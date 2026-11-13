/* One game session: from /angel join to /angel leave. Speech comes in from the voice channel, is turned into
   transcript lines, and each line that names Angel goes through the "was that for me?" check; questions are
   answered one at a time, typed in the text channel and spoken in voice. Everything paid for is tallied, and the
   session stops itself at the spending cap. All outside parts (voice, Deepgram, Claude, the text channel) are
   passed in, so the whole flow runs in tests without Discord. */
import { packetsToWav, createDecoder } from "./audio.mjs";
import { Transcript } from "./transcript.mjs";
import { mentionsAngel, isStopRequest } from "./wake.mjs";
import { typedAnswer } from "./answer.mjs";
import { speakable } from "./speech.mjs";

export class Session {
  constructor({ cfg, voice, post, stt, tts, gate, answer, speakerOf, transcript = new Transcript(), keytermCount = 1, log, now = Date.now, newDecoder = createDecoder }) {
    Object.assign(this, { cfg, voice, post, stt, tts, gate, answer, speakerOf, transcript, keytermCount, log, now, newDecoder });
    this.startedAt = now();
    this.decoders = new Map();
    this.pending = new Map();
    this.costs = { claude: 0, stt: 0, tts: 0 };
    this.counts = { pieces: 0, skipped: 0, questions: 0, gateChecks: 0 };
    this.capped = false;
    this.ended = false;
    this.answering = Promise.resolve();
    this.ackClips = null;
  }

  async start() {
    this.voice.on("speech", seg => { this.onSpeech(seg).catch(e => this.log.warn(`a piece of speech was lost: ${e.message}`)); });
    if (this.cfg.speak && this.cfg.ackPhrase) {
      try { this.ackClips = await this.tts(this.cfg.ackPhrase); this.costs.tts += this.ttsCost(this.cfg.ackPhrase); }
      catch (e) { this.log.warn(`couldn't make the "checking" phrase: ${e.message}`); }
    }
  }

  spent() { return this.costs.claude + this.costs.stt + this.costs.tts; }

  sttCost(seconds) {
    const p = this.cfg.deepgramPrices;
    return (seconds / 60) * (p.sttPerMinute + (this.keytermCount > 1 ? p.keytermPerMinute : 0));
  }

  ttsCost(text) { return (String(text).length / 1000) * this.cfg.deepgramPrices.ttsPer1000Chars; }

  /* Past the cap Angel stops paying for anything, says so once, and only "stop" and leaving still work. */
  overCap() {
    if (this.capped) return true;
    if (this.spent() < this.cfg.maxSessionDollars) return false;
    this.capped = true;
    this.log.warn(`spending cap of $${this.cfg.maxSessionDollars} reached`);
    this.post.send(`I've reached this session's spending cap ($${this.cfg.maxSessionDollars}), so I've stopped listening and answering. \`/angel leave\` and \`/angel join\` start a fresh session.`).catch(() => {});
    return true;
  }

  decoderFor(userId) {
    let d = this.decoders.get(userId);
    if (!d) { d = this.newDecoder(); this.decoders.set(userId, d); }
    return d;
  }

  async onSpeech({ userId, packets, startedAt }) {
    if (this.ended || this.overCap()) return;
    const piece = packetsToWav(this.decoderFor(userId), packets, this.cfg);
    if (!piece.wav) { this.counts.skipped++; return; }
    this.counts.pieces++;
    const heard = await this.stt(piece.wav);
    this.costs.stt += this.sttCost(heard.seconds || piece.durationMs / 1000);
    if (!heard.text || this.ended) return;
    const who = this.speakerOf(userId);
    const line = this.transcript.add({ at: startedAt, userId, speaker: who.name, role: who.role, text: heard.text, kind: "voice" });
    if (line) await this.onLine(line);
  }

  async onLine(line) {
    if (isStopRequest(line.text)) { this.stop(); return; }
    const waiting = this.pending.get(line.userId);
    if (!waiting && !mentionsAngel(line.text)) return;
    if (!waiting && this.voice.inEchoWindow(line.at)) return;
    if (this.overCap()) return;
    let text = line.text;
    if (waiting) {
      this.pending.delete(line.userId);
      clearTimeout(waiting.timer);
      if (this.now() - waiting.at <= this.cfg.followUpMs) text = `${waiting.text} ${line.text}`;
      else if (!mentionsAngel(line.text)) return;
    }
    const context = Transcript.format(this.transcript.before(line, 7).slice(0, -1));
    this.counts.gateChecks++;
    const decision = await this.gate({ contextText: context, lastText: `${line.speaker}: ${text}` });
    if (typeof decision.dollars === "number") this.costs.claude += decision.dollars;
    if (!decision.toAngel) return;
    if (decision.stop) { this.stop(); return; }
    if (!decision.complete) {
      const timer = setTimeout(() => this.pending.delete(line.userId), this.cfg.followUpMs);
      timer.unref?.();
      this.pending.set(line.userId, { text, at: this.now(), timer });
      return;
    }
    this.ask({ question: decision.question || text, asker: line.speaker, role: line.role, via: "voice" });
  }

  /* A typed question (@Angel, "Angel, …" in chat, or /angel ask): no check needed, they meant her. */
  textQuestion({ userId, asker, role = "player", text, reply = null }) {
    const line = this.transcript.add({ at: this.now(), userId, speaker: asker, role, text, kind: "text" });
    if (!line) return Promise.resolve();
    if (this.overCap()) return Promise.resolve();
    return this.ask({ question: text, asker, role, via: "text", reply });
  }

  ask(q) {
    this.counts.questions++;
    this.answering = this.answering.then(() => this.runAsk(q)).catch(e => this.log.error(`answering failed: ${e.message}`));
    return this.answering;
  }

  async runAsk({ question, asker, via, reply }) {
    if (this.ended) return;
    const target = reply ?? this.post;
    let placeholder = null;
    try { placeholder = await target.send(`**${asker} asked:** ${question}\n-# Looking it up…`); } catch (e) { this.log.warn(`couldn't post in the channel: ${e.message}`); }
    if (this.cfg.speak && this.ackClips) this.voice.speak(this.ackClips);
    let result;
    try {
      result = await this.answer({
        conversation: Transcript.format(this.transcript.recent(this.cfg.memoryMinutes, this.now())),
        question, asker, via,
      });
      this.costs.claude += result.dollars ?? 0;
    } catch (e) {
      this.log.error(`couldn't answer: ${e.message}`);
      result = { say: "Sorry, I couldn't reach my rules brain just then. Give it a moment and ask me again?", sources: [], failed: true };
    }
    const typed = typedAnswer({ asker, question, say: result.say, sources: result.sources });
    try { if (placeholder?.edit) await placeholder.edit(typed); else await target.send(typed); }
    catch (e) { this.log.warn(`couldn't post the answer: ${e.message}`); }
    this.transcript.add({ at: this.now(), speaker: "Angel", role: "angel", text: result.say, kind: "angel" });
    if (this.cfg.speak && !this.ended) {
      const spoken = speakable(result.say);
      try {
        const clips = await this.tts(spoken);
        this.costs.tts += this.ttsCost(spoken);
        if (!this.ended) this.voice.speak(clips);
      } catch (e) { this.log.warn(`couldn't speak the answer: ${e.message}`); }
    }
  }

  stop() { this.voice.stopSpeaking(); }

  status() {
    const minutes = Math.round((this.now() - this.startedAt) / 60000);
    return { minutes, lines: this.transcript.lines.length, ...this.counts, dollars: this.spent(), costs: { ...this.costs }, capped: this.capped };
  }

  end() {
    if (this.ended) return this.status();
    this.ended = true;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.voice.leave();
    for (const d of this.decoders.values()) { try { d.delete(); } catch { /* freed */ } }
    this.decoders.clear();
    return this.status();
  }
}

export function summaryText(s) {
  const money = n => `$${n.toFixed(2)}`;
  return `Session over: ${s.minutes} min, ${s.lines} transcript lines, ${s.questions} question${s.questions === 1 ? "" : "s"}. ` +
    `Cost about ${money(s.dollars)} (Claude ${money(s.costs.claude)}, listening ${money(s.costs.stt)}, voice ${money(s.costs.tts)}).`;
}
