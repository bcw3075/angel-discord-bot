/* One game session: from /angel join to /angel leave. Speech comes in from the voice channel, is turned into
   transcript lines, and each line that names Angel goes through the "was that for me?" check; questions are
   answered one at a time, typed in the text channel and spoken in voice. Everything paid for is tallied, and the
   session stops itself at its spending cap (or the bot's daily cap). All outside parts (voice, Deepgram, Claude,
   the text channel) are passed in, so the whole flow runs in tests without Discord. */
import { packetsToWav, createDecoder } from "./audio.mjs";
import { Transcript } from "./transcript.mjs";
import { mentionsAngel, isStopRequest, afterStop } from "./wake.mjs";
import { typedAnswer, shortQuestion } from "./answer.mjs";
import { speakable, SentenceCutter } from "./speech.mjs";

/* does `heard` look like her own words coming back? most of its words are in what she just said */
/* when the check gave no reaction of its own (a typed question, a failed check) */
export const ACKS = ["Ooh, good one. Let me look.", "Hang on, pulling the page.", "One moment, checking the books.", "On it.", "Let me make sure I get this right.", "Give me a second with that one."];

export function echoOf(heard, said = "") {
  const words = t => String(t).toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const h = words(heard), mine = new Set(words(said));
  if (!h.length || !mine.size) return false;
  return h.filter(w => mine.has(w)).length / h.length >= 0.7;
}

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
    this.heardOrder = new Map(); /* userId → the hand-over of their last piece of speech, so their lines are taken in the order said */
    this.lastWritten = null;     /* { at, text }: her last written answer, which the table can see and may ask about */
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

  async onSpeech({ userId, packets, startedAt, final = true }) {
    if (this.ended || this.overCap()) return;
    const piece = packetsToWav(this.decoderFor(userId), packets, this.cfg);
    if (!piece.wav) {
      this.counts.skipped++;
      /* the end of their speech, too short to hear: a long question held for its rest has had all of it */
      if (final !== false) await this.afterTurn(userId, () => this.releaseHold(userId, "they stopped"));
      return;
    }
    this.counts.pieces++;
    /* pieces are transcribed side by side, but one speaker's lines are taken in the order they were said: when the
       second half of a question came back first it had no name yet and was dropped, and the first half then waited
       for a rest that had already gone by */
    const hearing = this.stt(piece.wav);
    /* "Angel, stop" doesn't wait its turn behind an earlier piece still being transcribed */
    let stoppedEarly = false;
    hearing.then(h => { if (!this.ended && h?.text && isStopRequest(h.text)) { stoppedEarly = true; this.stop(startedAt); } }).catch(() => {});
    const before = this.heardOrder.get(userId) ?? Promise.resolve();
    let handling = null;
    const turn = before.then(async () => {
      const heard = await hearing;
      this.costs.stt += this.sttCost(heard.seconds || piece.durationMs / 1000);
      if (!heard.text || this.ended) { if (final !== false && !this.ended) handling = this.releaseHold(userId, "they stopped"); return; }
      const who = this.speakerOf(userId);
      const line = this.transcript.add({ at: startedAt, userId, speaker: who.name, role: who.role, text: heard.text, kind: "voice" });
      /* started in order, not waited for in order: what they say while the check on this line runs is the rest of
         the question. `until` is when they stopped talking (speech time): the timing in the log starts there */
      if (line && !stoppedEarly) { handling = this.onLine(line, startedAt + piece.durationMs, final === false); handling.catch(() => {}); }
    });
    const settled = turn.catch(() => {});
    this.heardOrder.set(userId, settled);
    settled.then(() => { if (this.heardOrder.get(userId) === settled) this.heardOrder.delete(userId); });
    await turn;
    await handling;
  }

  /* runs once this speaker's earlier pieces have been taken, so a release can't overtake a piece still being heard */
  async afterTurn(userId, work) {
    await (this.heardOrder.get(userId) ?? Promise.resolve());
    await work();
  }

  /* a stop said after the question was said cancels it, wherever it is: transcribing, being checked, queued or looked up */
  stoppedSince(at) { return this.lastStopAt > at; }

  /* `more` means this piece was cut off because the speaker has talked for maxUtteranceSeconds and is still talking */
  async onLine(line, until = line.at, more = false, released = null) {
    if (isStopRequest(line.text)) { this.stop(line.at); return; }
    const uid = line.userId;
    /* the person she just answered may reply without her name for a little while after she stops talking (Rhea,
       2026-11-14: "you replied first but not when I replied to you"); the check still decides it was for her */
    const r = this.replyTo;
    const replying = !!r && r.userId === uid && line.at >= r.from && line.at <= r.from + this.cfg.replyWindowMs;
    const byName = mentionsAngel(line.text) || released?.byName === true;
    const named = byName || replying || !!released;
    /* the check on this speaker's last line is still running: keep the line, it may be the rest of the question */
    const inFlight = this.checking.get(uid);
    if (inFlight && !byName) { inFlight.push(line.text); return; }
    const waiting = released ? null : this.pending.get(uid);
    if (!waiting && !named) return;
    /* her own voice coming back through a microphone. A reply without her name gets a closer look instead of the plain
       time rule: right after she stops is exactly when people answer her (2026-11-14: "Nice. And does that stack...?"
       began 2 s after she finished and was dropped). It's an echo only if its words are hers. */
    if (!waiting && !released && this.voice.inEchoWindow(line.at) && (byName || !replying || echoOf(line.text, this.lastSaid))) {
      /* in the log, so a line she didn't answer can be explained */
      if (byName) this.log.info(`${line.speaker}'s line naming her began while she was talking (or just after): taken as her own voice coming back, not answered`);
      return;
    }
    if (this.overCap()) return;
    let text = line.text;
    /* when the question began: a stop said after that cancels it, even one said during its first piece (review 7) */
    const firstAt = released?.firstAt ?? (waiting?.held ? waiting.firstAt : line.at);
    /* her name in any piece of it makes it a named question, not a reply (review 7) */
    const wasNamed = byName || waiting?.byName === true;
    if (waiting) {
      this.pending.delete(uid);
      clearTimeout(waiting.timer);
      if (this.now() - waiting.at <= (waiting.holdMs ?? this.cfg.followUpMs)) text = `${waiting.text} ${line.text}`;
      else if (!named) return;
    }
    /* They are still talking: a long question is cut into pieces every maxUtteranceSeconds so the transcript keeps
       up, and the piece so far is not the question. It is kept, without the check, until the rest comes (live
       2026-11-14: a question said over 40 s was checked and answered from its first 30 s, and she began to talk
       while Rhea was still asking it). */
    if (more) {
      if (this.stoppedSince(firstAt)) return;
      const holdMs = this.cfg.maxUtteranceSeconds * 1000 + this.cfg.followUpMs;
      const held = { text, at: this.now(), holdMs, byName: wasNamed, held: true, firstAt, line: { ...line, at: firstAt }, until };
      /* the rest may never become a line (too short, too quiet, nothing transcribed): then what was said is checked
         as it is, not dropped (review 7) */
      held.timer = setTimeout(() => this.releaseHold(uid, "the rest never came"), holdMs);
      held.timer.unref?.();
      this.pending.set(uid, held);
      this.log.info(`${line.speaker} is still talking: waiting for the rest before the check`);
      return;
    }
    const context = Transcript.format(this.transcript.before(line, 7).slice(0, -1));
    const later = [];
    this.checking.set(uid, later);
    this.counts.gateChecks++;
    let decision;
    try { decision = await this.gate({ contextText: context, lastText: `${line.speaker}: ${text}`, bareText: text, replying: replying && !wasNamed }); }
    finally { if (this.checking.get(uid) === later) this.checking.delete(uid); }
    if (typeof decision.dollars === "number") this.costs.claude += decision.dollars;
    if (decision.error) this.log.warn(`the "was that for me?" check failed (${decision.error}); the plain rule decided`);
    else if (decision.fallback) this.log.warn(`the "was that for me?" check gave a reply that couldn't be read; the plain rule decided`);
    /* what the check decided goes in the log (no words, just the verdict), so a line she didn't answer can be explained */
    this.log.info(`check on ${line.speaker}'s line${wasNamed ? "" : " (a reply, no name)"}: ${decision.toAngel ? (decision.chat ? "for Angel, small talk" : decision.complete === false ? "for Angel, waiting for the rest" : "for Angel") : "not for Angel"}`);
    if (!decision.toAngel || this.ended || this.stoppedSince(firstAt)) return;
    let at = firstAt;
    let asked = text; /* their own words */
    if (decision.stop) {
      this.stop(line.at);
      /* "Angel, stop. What does stunned do?": stop, then answer the question (asked just after the stop): their own
         words from after the stop, which is already done (the check's wording when the stop can't be cut off) */
      if (!(decision.complete && decision.question && /\?/.test(text))) return;
      at = line.at + 1;
      asked = afterStop(text) || decision.question;
    }
    /* what they said while the check ran is the rest of the question, finished or not */
    const rest = later.length ? ` ${later.join(" ")}` : "";
    if (!decision.complete) {
      if (rest) { this.ask({ question: `${text}${rest}`, meaning: "", asker: line.speaker, role: line.role, via: "voice", at, userId: uid, until }); return; }
      const timer = setTimeout(() => this.pending.delete(uid), this.cfg.followUpMs);
      timer.unref?.();
      this.pending.set(uid, { text, at: this.now(), timer });
      return;
    }
    /* the answer is worked out from their own words; the check's reading of them (a paraphrase by a small model, which
       can drop or bend a detail) goes along as a hint only, and is what the post shows as the question */
    this.ask({ question: `${asked}${rest}`, meaning: decision.question ? `${decision.question}${rest}` : "", asker: line.speaker, role: line.role, via: "voice", at, userId: uid, until, chat: decision.chat === true, ack: decision.ack || "", turn: wasNamed ? 0 : (r?.turn ?? 0) + 1 });
  }

  /* a held piece of a long question whose rest didn't come as a line: checked and answered as it stands */
  releaseHold(uid, why) {
    const w = this.pending.get(uid);
    if (!w?.held) return null;
    this.pending.delete(uid);
    clearTimeout(w.timer);
    if (this.ended) return null;
    this.log.info(`${w.line.speaker}'s long question: ${why}; checking what was said`);
    const p = this.onLine({ ...w.line, text: w.text }, w.until, false, w);
    p.catch(() => {});
    return p;
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

  async runAsk({ question, meaning = "", asker, via, reply, at, userId = null, until = null, chat = false, turn = 0, ack = "" }) {
    const target = reply ?? this.post;
    const shown = meaning || question; /* the question as the channel shows it */
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
    const began = this.now();
    /* small talk spoken to her: no "looking it up", no post in the channel, just her spoken reply */
    const quiet = chat && via === "voice" && this.cfg.speak;
    /* the placeholder and her quick reaction are started but not waited for: the answer is already being worked out */
    const placed = quiet ? null
      : target.send(`**${asker} asked:** ${shortQuestion(shown)}\n-# Looking it up…`).catch(e => { this.log.warn(`couldn't post in the channel: ${e.message}`); return null; });
    /* everything she says for this question is handed to the voice in order, through this chain */
    let line = Promise.resolve();
    if (!quiet && this.cfg.speak && this.cfg.ackPhrase !== "") {
      /* her own quick reaction to this question (the check writes it), else one of a few, so it isn't the same line
         every time (Rhea, 2026-11-14: "the 'one sec, let me check' on every reply is getting repetitive") */
      const words = ack || ACKS[this.counts.questions % ACKS.length];
      const made = this.tts(words);
      line = made.then(clips => { this.costs.tts += this.ttsCost(words); if (!this.ended && !this.stoppedSince(at)) this.voice.speak(clips); })
        .catch(() => { if (this.ackClips && !this.ended && !this.stoppedSince(at)) this.voice.speak(this.ackClips); });
    }

    /* Her answer is spoken as she writes it (Rhea chose this to make her faster, 2026-11-14): each sentence of `say`
       is turned into voice the moment it is whole, and the pieces play in order behind her quick reaction. */
    const said = [];       /* the pieces given to the voice so far */
    const times = {};      /* for the log: when the first words were written, when her voice started */
    let lastPlayed = null; /* resolves when the last piece has played (or was stopped) */
    const sayPiece = text => {
      const spoken = speakable(text);
      /* the cap is asked before she begins an answer, not in the middle of one: a sentence of voice costs a
         fraction of a cent, and an answer cut off half way helps nobody */
      if (!spoken || !this.cfg.speak || this.ended || this.stoppedSince(at) || (!said.length && this.overCap())) return;
      const made = this.tts(spoken);
      made.catch(() => {}); /* waited for in order below; a failure there is logged once */
      said.push(text);
      /* what she is saying counts as hers for the echo check from the moment it is on its way */
      this.lastSaid = said.join(" ");
      line = line.then(async () => {
        let clips;
        try { clips = await made; this.costs.tts += this.ttsCost(spoken); }
        catch (e) { this.log.warn(`couldn't speak the answer: ${e.message}`); return; }
        if (this.ended || this.stoppedSince(at)) return;
        try { lastPlayed = this.voice.speak(clips, { onStart: () => { times.voice ??= this.now(); } }); }
        catch (e) { this.log.warn(`couldn't speak the answer: ${e.message}`); }
      });
    };
    const cutter = new SentenceCutter();
    let sayEnded = false;  /* all she was going to say had been written */
    /* `end` comes when all of what she will say is written, which is before the written answer is: the last
       sentence (or the only one) is spoken from there, not from the end of the whole answer */
    const onSay = this.cfg.speakAsWritten === false || !this.cfg.speak ? null : (piece, { end = false } = {}) => {
      try {
        if (piece) times.written ??= this.now();
        for (const sentence of cutter.push(piece)) sayPiece(sentence);
        if (end) { const last = cutter.flush(); if (last) sayPiece(last); sayEnded = true; }
      } catch (e) { this.log.warn(`couldn't speak part of the answer as it was written: ${e.message}`); }
    };

    let result;
    try {
      /* her last written answer goes along: the table can see it and asks about it ("what about that second
         exception?"), and only her spoken words are in the transcript */
      const w = this.lastWritten;
      const wrote = w && this.now() - w.at <= this.cfg.memoryMinutes * 60000 ? `\n\nYour last written answer in the text channel (the table can see it):\n${w.text}` : "";
      result = await this.answer({
        conversation: Transcript.format(this.transcript.recent(this.cfg.memoryMinutes, this.now())) + wrote,
        question, meaning, asker, via, onSay,
      });
      this.costs.claude += result.dollars ?? 0;
      /* three or more lookups make a slow answer: what she searched for and what came back, so it can be mended */
      if ((result.looked?.length ?? 0) >= 3) this.log.info(`lookups for ${asker}'s question: ${result.looked.join(" | ")}`);
      if (result.fellBack) this.log.warn(`the answer was worked out a second time, the plain way, after: ${result.fellBack}`);
    } catch (e) {
      /* what the failed rounds cost still counts */
      this.costs.claude += e.dollars ?? 0;
      this.log.error(`couldn't answer: ${e.message}`);
      /* it broke off after she had said all she was going to say: what she said is the answer, with no apology on
         top; only the written details are missing, and the post says so */
      if (sayEnded && said.length) result = { say: said.join(" "), details: `${said.join(" ")}\n-# (I lost the written details for this one. Ask again if you want them.)`, sources: [], failed: true, saidAll: true };
      else result = { say: "Sorry, I couldn't reach my rules brain just then. Give it a moment and ask me again?", sources: [], failed: true };
    }
    times.answered = this.now();
    /* what is left to say: the end of an answer spoken as it was written, or all of one that wasn't (a failure's
       apology comes after whatever she had already begun) */
    const early = said.join(" ");
    const rest = result.failed ? "" : cutter.flush();
    /* cut off part way through what she was saying: she says so, and so does the post */
    const cutNote = result.cut ? "Sorry, I got cut off there. Ask me again?" : "";
    if (result.saidAll) { /* nothing more to say */ }
    else if (result.failed || (!said.length && !rest)) sayPiece(result.say);
    else if (rest) sayPiece(rest);
    if (result.detailsLost && !result.failed && !result.cut) result = { ...result, details: `${result.say}\n-# (I lost the written details for this one. Ask again if you want them.)` };
    if (cutNote) { sayPiece(cutNote); result = { ...result, say: `${result.say} … ${cutNote}`, details: `${result.say} …\n-# (I got cut off part way through this answer. Ask me again.)` }; }
    const heard = result.failed && early && !result.saidAll ? `${early} ${result.say}` : result.say;

    /* the check may call a rules question small talk: one that looked something up is posted anyway */
    let posted = false;
    const post = async () => {
      if (posted) return;
      posted = true;
      const typed = typedAnswer({ asker, question: shown, say: result.details ?? result.say, sources: result.sources, unchecked: result.failedLookups > 0 });
      /* kept for the next question only when it is a checked rules answer: not small talk, not one a lookup failed for */
      if (!result.failed && result.details && !chat && !result.cut && !result.detailsLost && result.lookups > 0 && !(result.failedLookups > 0)) this.lastWritten = { at: this.now(), text: result.details };
      const placeholder = await placed;
      try { if (placeholder?.edit) await placeholder.edit(typed); else await target.send(typed); }
      catch (e) { this.log.warn(`couldn't post the answer: ${e.message}`); }
    };
    if (!quiet || result.failed || result.lookups > 0 || result.sources?.length) await post();
    /* in the transcript at the moment she began to say it */
    this.transcript.add({ at: times.written ?? this.now(), speaker: "Angel", role: "angel", text: heard, kind: "angel" });
    this.lastSaid = heard;
    await line.catch(e => this.log.warn(`speaking failed: ${e.message}`));
    const since = t => (t == null ? "n/a" : `${((t - began) / 1000).toFixed(1)} s`);
    const startLog = () => this.log.info(`timing for ${asker}'s question: first words written ${since(times.written)}, her answer began aloud ${since(times.voice)}, whole answer written ${since(times.answered)} after it was taken up`
      + `${until ? ` (taken up ${((began - until) / 1000).toFixed(1)} s after they stopped talking)` : ""}; ${result.rounds ?? "?"} round(s), ${result.lookups ?? 0} lookup(s)${early ? "" : ", not spoken as written"}`);
    /* nothing of the answer reached the voice (told to stop, the session ended, a cap, or the voice failed): a
       small-talk reply that was only going to be spoken is typed instead, unless she was told to stop */
    if (!lastPlayed) {
      if (this.cfg.speak) startLog();
      if (quiet && !this.stoppedSince(at)) await post();
      return;
    }
    /* the person she answered may reply without her name, from when this answer ends; at most three such replies
       in a row, so small talk can't run on and on at the table's expense */
    if (via === "voice" && userId && turn >= 3 && this.replyTo?.userId === userId) this.replyTo = null;
    Promise.resolve(lastPlayed).then(() => {
      startLog();
      if (this.ended || this.stoppedSince(at)) return;
      if (via === "voice" && userId && turn < 3) {
        this.replyTo = { userId, from: this.now(), turn };
        this.log.info(`${asker} can reply without her name for ${Math.round(this.cfg.replyWindowMs / 1000)} s`);
      }
    }).catch(() => {});
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
