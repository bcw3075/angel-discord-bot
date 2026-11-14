/* One game session: from /angel join to /angel leave. Speech comes in from the voice channel, is turned into
   transcript lines, and each line that names Angel goes through the "was that for me?" check; questions are
   answered one at a time, typed in the text channel and spoken in voice. Everything paid for is tallied, and the
   session stops itself at its spending cap (or the bot's daily cap). All outside parts (voice, Deepgram, Claude,
   the text channel) are passed in, so the whole flow runs in tests without Discord. */
import { packetsToWav, createDecoder } from "./audio.mjs";
import { Transcript } from "./transcript.mjs";
import { mentionsAngel, isStopRequest } from "./wake.mjs";
import { typedAnswer, shortQuestion } from "./answer.mjs";
import { speakable } from "./speech.mjs";

export class Session {
  constructor({ cfg, voice, post, stt, tts, gate, answer, speakerOf, transcript = new Transcript(), keytermCount = 1, log, now = Date.now, newDecoder = createDecoder, dailyOver = () => false }) {
    Object.assign(this, { cfg, voice, post, stt, tts, gate, answer, speakerOf, transcript, keytermCount, log, now, newDecoder, dailyOver });
    this.startedAt = now();
    this.decoders = new Map();
    this.pending = new Map();   /* userId → { text, at, timer }: "Angel?" with the question still to come */
    this.checking = new Map();  /* userId → lines said while the check on their last line is still running */
    this.costs = { claude: 0, stt: 0, tts: 0 };
    this.counts = { pieces: 0, skipped: 0, questions: 0, gateChecks: 0 };
    this.capped = false;
    this.ended = false;
    this.lastStopAt = -Infinity; /* when the last "stop" was said: a question said before it is dropped or not spoken */
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

  /* Deepgram charges the key-term rate whenever key terms are sent, and "Angel" always is */
  sttCost(seconds) {
    const p = this.cfg.deepgramPrices;
    return (seconds / 60) * (p.sttPerMinute + (this.keytermCount > 0 ? p.keytermPerMinute : 0));
  }

  ttsCost(text) { return (String(text).length / 1000) * this.cfg.deepgramPrices.ttsPer1000Chars; }

  capMessage() {
    return this.spent() >= this.cfg.maxSessionDollars
      ? `I've reached this session's spending cap ($${this.cfg.maxSessionDollars}), so I've stopped listening and answering. \`/angel leave\` and \`/angel join\` start a fresh session.`
      : `I've reached today's spending cap ($${this.cfg.maxDailyDollars}), so I've stopped listening and answering until tomorrow.`;
  }

  /* Past a cap Angel stops paying for anything and says so once; typed questions get a reply saying so. */
  overCap() {
    if (this.capped) return true;
    if (this.spent() < this.cfg.maxSessionDollars && !this.dailyOver()) return false;
    this.capped = true;
    this.log.warn(`spending cap reached: $${this.spent().toFixed(2)} this session`);
    this.post.send(this.capMessage()).catch(() => {});
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

  /* a stop said after the question was said cancels it, wherever it is: transcribing, being checked, queued or looked up */
  stoppedSince(at) { return this.lastStopAt > at; }

  async onLine(line) {
    if (isStopRequest(line.text)) { this.stop(line.at); return; }
    const uid = line.userId;
    /* the person she just answered may reply without her name for a little while after she stops talking (Rhea,
       2026-11-14: "you replied first but not when I replied to you"); the check still decides it was for her */
    const r = this.replyTo;
    const replying = !!r && r.userId === uid && line.at >= r.from && line.at <= r.from + this.cfg.replyWindowMs;
    const byName = mentionsAngel(line.text);
    const named = byName || replying;
    /* the check on this speaker's last line is still running: keep the line, it may be the rest of the question */
    const inFlight = this.checking.get(uid);
    if (inFlight && !byName) { inFlight.push(line.text); return; }
    const waiting = this.pending.get(uid);
    if (!waiting && !named) return;
    if (!waiting && this.voice.inEchoWindow(line.at)) return;
    if (this.overCap()) return;
    let text = line.text;
    if (waiting) {
      this.pending.delete(uid);
      clearTimeout(waiting.timer);
      if (this.now() - waiting.at <= this.cfg.followUpMs) text = `${waiting.text} ${line.text}`;
      else if (!named) return;
    }
    const context = Transcript.format(this.transcript.before(line, 7).slice(0, -1));
    const later = [];
    this.checking.set(uid, later);
    this.counts.gateChecks++;
    let decision;
    try { decision = await this.gate({ contextText: context, lastText: `${line.speaker}: ${text}`, bareText: text }); }
    finally { if (this.checking.get(uid) === later) this.checking.delete(uid); }
    if (typeof decision.dollars === "number") this.costs.claude += decision.dollars;
    if (decision.error) this.log.warn(`the "was that for me?" check failed (${decision.error}); the plain rule decided`);
    /* what the check decided goes in the log (no words, just the verdict), so a line she didn't answer can be explained */
    this.log.info(`check on ${line.speaker}'s line${byName ? "" : " (a reply, no name)"}: ${decision.toAngel ? (decision.chat ? "for Angel, small talk" : decision.complete === false ? "for Angel, waiting for the rest" : "for Angel") : "not for Angel"}`);
    if (!decision.toAngel || this.ended || this.stoppedSince(line.at)) return;
    let at = line.at;
    if (decision.stop) {
      this.stop(line.at);
      /* "Angel, stop. What does stunned do?": stop, then answer the question (asked just after the stop) */
      if (!(decision.complete && decision.question && /\?/.test(text))) return;
      at = line.at + 1;
    }
    /* what they said while the check ran is the rest of the question, finished or not */
    const rest = later.length ? ` ${later.join(" ")}` : "";
    if (!decision.complete) {
      if (rest) { this.ask({ question: `${text}${rest}`, asker: line.speaker, role: line.role, via: "voice", at, userId: uid }); return; }
      const timer = setTimeout(() => this.pending.delete(uid), this.cfg.followUpMs);
      timer.unref?.();
      this.pending.set(uid, { text, at: this.now(), timer });
      return;
    }
    this.ask({ question: `${decision.question || text}${rest}`, asker: line.speaker, role: line.role, via: "voice", at, userId: uid, chat: decision.chat === true, turn: byName ? 0 : (r?.turn ?? 0) + 1 });
  }

  /* A typed question (@Angel, "Angel, …" in chat, or /angel ask): no check needed, they meant her. */
  textQuestion({ userId, asker, role = "player", text, reply = null }) {
    const line = this.transcript.add({ at: this.now(), userId, speaker: asker, role, text, kind: "text" });
    if (!line) return Promise.resolve();
    if (this.overCap()) {
      /* a deferred /angel ask must still get an answer, or Discord shows "thinking…" for 15 minutes */
      return (reply ?? this.post).send(this.capMessage()).catch(() => {});
    }
    return this.ask({ question: text, asker, role, via: "text", reply, at: line.at });
  }

  ask(q) {
    this.counts.questions++;
    const asked = { at: this.now(), ...q };
    this.answering = this.answering.then(() => this.runAsk(asked)).catch(e => this.log.error(`answering failed: ${e.message}`));
    return this.answering;
  }

  async runAsk({ question, asker, via, reply, at, userId = null, chat = false, turn = 0 }) {
    const target = reply ?? this.post;
    if (this.ended) {
      /* a deferred /angel ask must still hear back */
      if (reply) await reply.send(`The session ended before I got to "${shortQuestion(question)}".`).catch(() => {});
      return;
    }
    /* stopped before its turn came: dropped (a typed one is told so) */
    if (this.stoppedSince(at)) {
      if (reply) await reply.send(`Okay, I've dropped "${shortQuestion(question)}".`).catch(() => {});
      return;
    }
    if (this.overCap()) {
      if (reply) await reply.send(this.capMessage()).catch(() => {});
      return;
    }
    /* small talk spoken to her: no "looking it up", no post in the channel, just her spoken reply */
    const quiet = chat && via === "voice" && this.cfg.speak;
    let placeholder = null;
    if (!quiet) {
      try { placeholder = await target.send(`**${asker} asked:** ${shortQuestion(question)}\n-# Looking it up…`); } catch (e) { this.log.warn(`couldn't post in the channel: ${e.message}`); }
      if (this.cfg.speak && this.ackClips) this.voice.speak(this.ackClips);
    }
    let result;
    try {
      result = await this.answer({
        conversation: Transcript.format(this.transcript.recent(this.cfg.memoryMinutes, this.now())),
        question, asker, via,
      });
      this.costs.claude += result.dollars ?? 0;
    } catch (e) {
      /* what the failed rounds cost still counts */
      this.costs.claude += e.dollars ?? 0;
      this.log.error(`couldn't answer: ${e.message}`);
      result = { say: "Sorry, I couldn't reach my rules brain just then. Give it a moment and ask me again?", sources: [], failed: true };
    }
    /* the check may call a rules question small talk: one that looked something up is posted anyway */
    let posted = false;
    const post = async () => {
      if (posted) return;
      posted = true;
      const typed = typedAnswer({ asker, question, say: result.details ?? result.say, sources: result.sources });
      try { if (placeholder?.edit) await placeholder.edit(typed); else await target.send(typed); }
      catch (e) { this.log.warn(`couldn't post the answer: ${e.message}`); }
    };
    if (!quiet || result.failed || result.lookups > 0 || result.sources?.length) await post();
    this.transcript.add({ at: this.now(), speaker: "Angel", role: "angel", text: result.say, kind: "angel" });
    /* told to stop while she was looking it up: the answer stays typed, but she doesn't say it */
    if (!this.cfg.speak || this.ended || this.stoppedSince(at) || this.overCap()) { if (quiet && !this.stoppedSince(at)) await post(); return; }
    const spoken = speakable(result.say);
    try {
      const clips = await this.tts(spoken);
      this.costs.tts += this.ttsCost(spoken);
      if (!this.ended && !this.stoppedSince(at)) {
        const played = this.voice.speak(clips);
        /* the person she answered may reply without her name, from when this answer ends; at most three such replies
           in a row, so small talk can't run on and on at the table's expense */
        if (via === "voice" && userId && turn >= 3 && this.replyTo?.userId === userId) this.replyTo = null;
        if (via === "voice" && userId && turn < 3) {
          Promise.resolve(played).then(() => {
            if (this.ended || this.stoppedSince(at)) return;
            this.replyTo = { userId, from: this.now(), turn };
            this.log.info(`${asker} can reply without her name for ${Math.round(this.cfg.replyWindowMs / 1000)} s`);
          }).catch(() => {});
        }
      }
    } catch (e) {
      this.log.warn(`couldn't speak the answer: ${e.message}`);
      if (quiet) await post();
    }
  }

  /* "Angel, stop": cut her off, drop questions still waiting, and don't speak an answer still being looked up.
     `at` is when the stop was said (a typed or /angel stop: now). */
  stop(at = this.now()) {
    this.lastStopAt = Math.max(this.lastStopAt, at);
    this.replyTo = null;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.voice.stopSpeaking();
  }

  status() {
    const minutes = Math.round((this.now() - this.startedAt) / 60000);
    return { minutes, lines: this.transcript.lines.length, ...this.counts, dollars: this.spent(), costs: { ...this.costs }, capped: this.capped };
  }

  end() {
    if (this.ended) return this.status();
    this.ended = true;
    this.replyTo = null;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.voice.leave();
    for (const d of this.decoders.values()) { try { d.delete(); } catch { /* freed */ } }
    this.decoders.clear();
    this.transcript.close();
    return this.status();
  }
}

export function summaryText(s) {
  const money = n => `$${n.toFixed(2)}`;
  return `Session over: ${s.minutes} min, ${s.lines} transcript lines, ${s.questions} question${s.questions === 1 ? "" : "s"}. ` +
    `Cost about ${money(s.dollars)} (Claude ${money(s.costs.claude)}, listening ${money(s.costs.stt)}, voice ${money(s.costs.tts)}).`;
}
