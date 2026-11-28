/* One game session: from /angel join to /angel leave. Speech comes in from the voice channel, is turned into
   transcript lines, and each line that names Angel goes through the "was that for me?" check; questions are
   answered one at a time, typed in the text channel and spoken in voice. Everything paid for is tallied, and the
   session stops itself at its spending cap (or the bot's daily cap). All outside parts (voice, Deepgram, Claude,
   the text channel) are passed in, so the whole flow runs in tests without Discord. */
import { packetsToWav, createDecoder } from "./audio.mjs";
import { HearingWatch } from "./hearing.mjs";
import { Transcript } from "./transcript.mjs";
import { mentionsAngel, isStopRequest, afterStop, parseHold } from "./wake.mjs";
import { Floor } from "./floor.mjs";
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

/* what a dropped reply's wait resolves to */
const DROPPED = Symbol("dropped");

/* what a question typed to her gets at a table where she only listens */
export const LISTEN_ONLY_REPLY = "I'm only listening at this table, so I don't answer questions here. I'm keeping the transcript.";

export class Session {
  constructor({ cfg, voice, post, stt, tts, gate, answer, speakerOf, hold = null, readyLine = null, transcript = new Transcript(), keytermCount = 1, log, now = Date.now, newDecoder = createDecoder, dailyOver = () => false, listenOnly = false, showCosts = true, alert = null, hearing = {}, clock = t => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) }) {
    Object.assign(this, { cfg, voice, post, stt, tts, gate, answer, speakerOf, hold, readyLine, transcript, keytermCount, log, now, newDecoder, dailyOver, alert, clock });
    /* a table where she only listens (0.2.0, d-10): every piece is transcribed into the transcript and nothing else
       happens: no "was that for me?" check, no answer, no lookups, never a word aloud */
    this.listenOnly = listenOnly === true;
    /* on a server that isn't the owner's, no dollar figure in anything she posts (Rhea, 2026-11-28) */
    this.showCosts = showCosts !== false;
    this.startedAt = now();
    this.decoders = new Map();
    this.pending = new Map();   /* userId → { text, at, timer }: "Angel?" with the question still to come */
    this.checking = new Map();  /* userId → lines said while the check on their last line is still running */
    this.costs = { claude: 0, stt: 0, tts: 0 };
    this.names = new Set(); /* who has spoken this session, for the transcriber */
    this.ownRecent = []; /* her quick reactions and "I'm ready" lines as they are spoken, for the echo test (review 20) */
    this.counts = { pieces: 0, skipped: 0, questions: 0, gateChecks: 0, merged: 0, held: 0, letGo: 0 };
    /* each speaker's reply not yet begun, so a line they add can be answered with it (see `ask`) */
    this.open = new Map();
    this.capped = false;
    this.ended = false;
    this.lastStopAt = -Infinity; /* when the last "stop" was said: a question said before it is dropped or not spoken */
    this.answering = Promise.resolve();
    this.ackClips = null;
    this.heardOrder = new Map(); /* userId → the hand-over of their last piece of speech, so their lines are taken in the order said */
    this.lastWritten = null;     /* { at, text }: her last written answer, which the table can see and may ask about */
    /* a busy table (Rhea, 2026-11-15, d-7): who is talking, from Discord's speaking signal; and the answer she is
       holding for a gap, if any (answers are spoken one at a time, so at most one) */
    this.floor = null;
    this.holding = null;
    /* the question she is looking up or holding, from when it is taken up: every line said since it is judged by the
       check while she waits, through one path (`onSince`; review 12 of 0.1.3: three hand-over paths at the moment her
       answer was ready had each left holes). `holding` is the same object once her answer is ready. */
    this.watch = null;
    this.readies = [];           /* her last few "I'm ready" lines, so the next one is different */
    this.hearingNow = new Map(); /* pieces of speech still being heard or judged (review 2 of 0.1.3) */
    this.lastArrived = new Map(); /* userId → when their latest piece of speech reached her */
    this.unheardCapMs = 10000;    /* longer unbroken talk than this isn't waited for (see `unheard`) */
    this.saidSince = [];          /* lines not for her by the usual rule, kept briefly for a hold that may begin */
    this.carry = null;            /* the watch of a question merged into a fuller one, for that one's watch to go on from */
    this.pastWatches = [];        /* the last few ended watches, so a late stop finds the one it was said during */
    this.pieceNo = 0;
    /* is she still hearing the table? (2026-11-22: she sat in the channel for 85 minutes hearing nothing, and nobody
       knew.) The watch decides; the session mends what it can and tells the owner at once (`alert`, from the bot) */
    this.hearing = new HearingWatch({ now, ...hearing,
      onTrouble: t => this.hearingTrouble(t), onStill: t => this.hearingStill(t), onBack: t => this.hearingBack(t) });
    this.hearingTimer = null;
    this.mending = false;      /* she asked for the rejoin herself: its own note to the owner would say it twice */
    this.quietRejoins = 0;
  }

  async start() {
    this.voice.on("speech", seg => { this.onSpeech(seg).catch(e => this.log.warn(`a piece of speech was lost: ${e.message}`)); });
    /* for the hearing watch: who is talking, of the people she listens to (an opted-out player's words never come) */
    this.voice.on("talking", ({ userId, speaking, at }) => {
      try {
        if (speaking && this.voice.shouldListen && !this.voice.shouldListen(userId)) return;
        this.hearing.talking(userId, speaking, at);
      } catch { /* not counted */ }
    });
    this.hearingTimer = setInterval(() => this.hearingTick(), this.cfg.hearingCheckMs ?? 15000);
    this.hearingTimer.unref?.();
    if (this.listenOnly) return;
    if (this.cfg.busyTable !== false) {
      this.floor = new Floor({ now: this.now, blipMs: this.cfg.busyBlipMs, ownSpeech: () => this.voice.ownSpeech?.() ?? this.voice.periods ?? [] });
      this.voice.on("talking", ({ userId, speaking, at }) => { try { this.floor.talk(userId, speaking, at); } catch (e) { this.log.warn(`the floor lost a speaking change: ${e.message}`); } });
    }
    if (this.cfg.speak && this.cfg.ackPhrase) {
      try { this.ackClips = await this.tts(this.cfg.ackPhrase); this.costs.tts += this.ttsCost(this.cfg.ackPhrase); }
      catch (e) { this.log.warn(`couldn't make the "checking" phrase: ${e.message}`); }
    }
  }

  /* She went deaf and rejoined the voice channel (field test of 2026-11-21): the table is told, in writing and
     briefly aloud, so a question asked while she couldn't hear is asked again */
  async rejoined({ asked = false } = {}) {
    if (this.ended) return;
    /* the talk that went unheard before the rejoin isn't counted against the new connection */
    this.hearing.fresh();
    /* one the owner asked for with /angel rejoin: nothing went wrong, so no warning and nothing aloud; the thread
       says it happened, since a few seconds of talk may be missing */
    if (asked) {
      /* a trouble that came while it was under way took this rejoin as its mend (hearingTrouble's `already`) */
      this.mending = false;
      /* at an answering table a question asked while she was out is lost, and a spoken answer was cut off (review 9) */
      this.post.send(this.listenOnly
        ? "🎙️ I left and rejoined the voice channel, as asked with `/angel rejoin`. A few seconds of talk may be missing from the transcript."
        : "🎙️ I left and rejoined the voice channel, as asked with `/angel rejoin`. If you asked me something just now, please ask again.")
        .catch(e => this.log.warn(`couldn't say she had rejoined: ${e.message}`));
      return;
    }
    /* the voice link's own deaf check did this (no sound came at all): the owner is told as well */
    if (!this.mending) this.tell("⚠️ My hearing dropped out in {where}, so I left the voice channel and joined again. A little of the talk may be missing from the transcript. I'll tell you if it happens again.");
    this.mending = false;
    /* where she only listens, the note is only written (d-10: nothing aloud there) */
    this.post.send(this.listenOnly
      ? "🎙️ My hearing dropped out for a moment, so I rejoined the voice channel. A few seconds of talk may be missing from the transcript."
      : "🎙️ My hearing dropped out for a moment, so I rejoined the voice channel. If you asked me something just now, please ask again.")
      .catch(e => this.log.warn(`couldn't say she had rejoined: ${e.message}`));
    if (this.listenOnly || !this.cfg.speak || this.overCap()) return;
    const words = "Sorry, I lost you for a second. I'm back.";
    try {
      const clips = await this.tts(words);
      this.costs.tts += this.ttsCost(words);
      if (this.ended) return;
      this.ownRecent.push({ text: words, at: this.now() });
      this.voice.speak(clips);
    } catch (e) { this.log.warn(`couldn't say aloud that she was back: ${e.message}`); }
  }

  /* /angel rejoin (hr-19): the owner makes her leave and rejoin on purpose, so the rejoin path can be seen working
     live without a real fault. Said why it can't when it can't. */
  rejoinOnPurpose() {
    if (this.ended) return "ended";
    if (typeof this.voice.rejoin !== "function") return "unsupported";
    if (this.voice.rejoining || this.mending) return "busy";
    this.log.info("the owner asked for a rejoin (/angel rejoin)");
    Promise.resolve().then(() => this.voice.rejoin({ asked: true })).catch(e => this.log.warn(`couldn't rejoin as asked: ${e.message}`));
    return "rejoining";
  }

  spent() { return this.costs.claude + this.costs.stt + this.costs.tts; }

  /* Deepgram charges the key-term rate whenever key terms are sent, and "Angel" always is */
  sttCost(seconds) {
    const p = this.cfg.deepgramPrices;
    return (seconds / 60) * (p.sttPerMinute + (this.keytermCount > 0 ? p.keytermPerMinute : 0));
  }

  ttsCost(text) { return (String(text).length / 1000) * this.cfg.deepgramPrices.ttsPer1000Chars; }

  capMessage() {
    const amount = n => (this.showCosts ? ` ($${n})` : "");
    return this.spent() >= this.cfg.maxSessionDollars
      ? `I've reached this session's spending cap${amount(this.cfg.maxSessionDollars)}, so I've stopped listening and answering. \`/angel leave\` and \`/angel join\` start a fresh session.`
      : `I've reached today's spending cap${amount(this.cfg.maxDailyDollars)}, so I've stopped listening and answering until tomorrow.`;
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

  /* the watch's regular look. Past a spending cap she has stopped listening on purpose and said so: talk without
     words is not trouble then (review 1 of the hearing watch: it rejoined and warned the owner three minutes after a cap) */
  hearingTick() {
    if (this.ended) return;
    if (this.overCap()) { this.hearing.fresh(); return; }
    this.hearing.tick();
  }

  dropDecoder(userId) {
    const d = this.decoders.get(userId);
    this.decoders.delete(userId);
    try { d?.delete(); } catch { /* gone anyway */ }
  }

  /* One piece of speech → WAV. A piece its decoder can't make sense of (it throws, or rejects more than half the
     packets) is tried once more with a fresh decoder, so a decoder gone bad costs nothing; if that fails too the
     piece is lost and the hearing watch is told. */
  toWav(userId, packets) {
    const attempt = () => {
      try { return packetsToWav(this.decoderFor(userId), packets, this.cfg); }
      catch (e) { return { wav: null, durationMs: packets.length * 20, reason: "broken", error: e.message }; }
    };
    const broken = p => p.reason === "broken" || (p.reason !== "short" && (p.badPackets ?? 0) * 2 > packets.length);
    let piece = attempt();
    if (!broken(piece)) { if (piece.reason !== "short") this.hearing.decoded(); return piece; }
    const why = piece.error ?? `${piece.badPackets} of ${packets.length} packets rejected`;
    this.dropDecoder(userId);
    piece = attempt();
    if (!broken(piece)) { this.hearing.decoded(); this.log.info(`a decoder had gone bad (${why}); a fresh one decoded the piece`); return piece; }
    this.dropDecoder(userId);
    if (this.hearing.run("decode") < this.hearing.failRun) this.log.warn(`a piece of speech couldn't be decoded, even by a fresh decoder (${piece.error ?? `${piece.badPackets} of ${packets.length} packets rejected`})`);
    this.hearing.bad("decode", piece.error ?? "the sound couldn't be decoded");
    return { wav: null, durationMs: piece.durationMs, reason: "broken" };
  }

  /* the transcriber, with the hearing watch told how it went */
  async transcribe(wav, opts) {
    let heard;
    try { heard = await this.stt(wav, opts); }
    catch (e) { this.hearing.bad("transcriber", e.message); throw e; }
    this.hearing.ok();
    return heard;
  }

  /* a message to the owner (whoever started the session), outside the voice channel: never aloud */
  tell(text) {
    this.log.warn(`to the owner: ${text.replaceAll("{where}", "the voice channel")}`);
    if (!this.alert) return;
    Promise.resolve().then(() => this.alert(text)).catch(e => this.log.warn(`couldn't tell the owner: ${e.message}`));
  }

  hearingTrouble({ kind, since, detail }) {
    if (this.ended || this.capped) return;
    const at = this.clock(since);
    if (kind === "transcriber") {
      this.tell(`⚠️ I can't get the talk in {where} written down: since ${at} the transcriber hasn't answered (${String(detail).slice(0, 120) || "no reason given"}). I'm still trying with every piece of speech, and I'll tell you when it works again.`);
      return;
    }
    /* fresh decoders for everyone, and a fresh voice connection: between them they start her hearing over */
    for (const userId of [...this.decoders.keys()]) this.dropDecoder(userId);
    /* the voice link's last rejoin is left for its own deaf check (after it, the link gives up and leaves); and talk
       without words can be an open microphone, so it gets one rejoin a session. A rejoin that fails to join ends the
       session as a lost connection, and the owner is told that too. */
    const already = this.voice.rejoining === true; /* the voice link's own rejoin is under way: that one will do */
    const room = already || (typeof this.voice.rejoin === "function" && (this.voice.rejoins ?? 0) < (this.voice.maxRejoins ?? 3) - 1 && (kind !== "quiet" || this.quietRejoins < 1));
    if (room) {
      /* cleared by `rejoined`, so the rejoin's own note to the owner isn't a second message for one event */
      this.mending = true;
      if (!already) {
        if (kind === "quiet") this.quietRejoins++;
        Promise.resolve().then(() => this.voice.rejoin()).catch(e => this.log.warn(`couldn't rejoin to mend her hearing: ${e.message}`)).then(() => { this.mending = false; });
      }
    }
    const doing = room ? "I'm starting my hearing afresh and rejoining the voice channel" : "I've started my hearing afresh";
    this.tell(kind === "decode"
      ? `⚠️ I've stopped hearing the table in {where}: since ${at} the sound reaches me but I can't make it out. ${doing}; I'll tell you whether that works.`
      : `⚠️ People seem to be talking in {where}, but I haven't caught a single word since ${at}. ${doing}; I'll tell you whether that works.`);
  }

  hearingStill({ kind, since, minutes }) {
    if (this.ended || this.capped) return;
    if (kind === "transcriber") {
      this.tell(`⚠️ I still can't get the talk in {where} written down: the transcriber hasn't answered since ${this.clock(since)} (${minutes} min). Leaving and rejoining won't mend that. It's worth checking the internet connection on my computer and the Deepgram account (its credit and its status page); I keep trying.`);
      return;
    }
    this.tell(`⚠️ I'm still not hearing the table in {where}: nothing written down since ${this.clock(since)} (${minutes} min). Please type \`/angel leave\` and then \`/angel join\`; if that doesn't bring me back, close my window and start me again.`);
  }

  hearingBack({ since, until }) {
    if (this.ended) return;
    this.tell(`✅ I can hear the table in {where} again. Nothing was written down between ${this.clock(since)} and ${this.clock(until)}.`);
  }

  async onSpeech(seg) {
    /* a piece is "being heard" until its line has been judged: a gap while she holds an answer doesn't release her
       before what was said in it is known (review 2 of 0.1.3: "hold on" then quiet, and she spoke over it) */
    const no = ++this.pieceNo;
    /* by when it ended: talk that began before the question and ran on past it counts (review 3 of 0.1.3) */
    /* by when it reached her: it holds what was said up to then (packets leave out pauses, so they can't date its end;
       review 4 of 0.1.3) */
    const arrived = this.now();
    this.hearingNow.set(no, { end: arrived, added: arrived });
    if (seg.userId != null) this.lastArrived.set(seg.userId, arrived);
    try { return await this.hearPiece(seg); }
    finally { this.hearingNow.delete(no); }
  }

  /* something said after `at` is still being heard or judged */
  stillHearing(at) {
    const now = this.now();
    /* a piece stuck longer than this (a hung call: listening has 20 s, the check 8 s and a retry) stops holding her up */
    for (const p of this.hearingNow.values()) if (p.end > at && now - p.added < 30000) return true;
    return false;
  }

  /* Is anything said since `at` not yet known? A piece still being heard or judged, or talk long enough to be words
     (minUtteranceMs) whose piece hasn't reached her yet: a piece comes silenceMs after the last sound. Shorter sounds
     are never transcribed, so they are not waited for (review 4 of 0.1.3: a trickle of clicks blocked every gap). */
  unheard(at) {
    if (this.stillHearing(at)) return true;
    if (!this.floor) return false;
    const now = this.now();
    for (const [uid, { start, end }] of this.floor.lastEnds(this.cfg.minUtteranceMs, this.cfg.silenceMs, now)) {
      if (end <= at) continue;
      /* talk that ran on for a long time without the pause that ends a piece (a trickle of clicks, a mic left open):
         its piece may not come for 30 s, so it stops holding her up; once it does reach her it is still judged
         (review 6 of 0.1.3) */
      if (end - start > this.unheardCapMs) continue;
      /* nobody listens to them (opted out, or not heard at all): nothing will come */
      try { if (this.voice.shouldListen && !this.voice.shouldListen(uid)) continue; } catch { continue; }
      const arrived = this.lastArrived.get(uid) ?? -Infinity;
      if (arrived >= end + this.cfg.silenceMs - 300) continue; /* its piece has come (review 6: 50 ms of slack was tight) */
      if (now < end + this.cfg.silenceMs + 1500) return true;  /* still on its way */
    }
    return false;
  }

  async hearPiece({ userId, packets, startedAt, final = true }) {
    if (this.ended || this.overCap()) return;
    if (this.listenOnly) return this.hearOnly({ userId, packets, startedAt });
    const piece = this.toWav(userId, packets);
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
    /* the names of the people heard so far go to the transcriber with her key terms, so they're spelled right
       (live round 2026-11-16: a player's Discord name was heard as a campaign name from keyterms.txt) */
    const speaking = this.speakerOf(userId)?.name;
    if (speaking && speaking !== "Someone") this.names.add(speaking); /* not the stand-in for an unknown member (review 20) */
    const hearing = this.transcribe(piece.wav, { names: [...this.names] });
    /* "Angel, stop" doesn't wait its turn behind an earlier piece still being transcribed */
    let stoppedEarly = false;
    hearing.then(h => { if (!this.ended && h?.text && isStopRequest(h.text)) { stoppedEarly = true; this.stop(startedAt); this.log.info(`${this.speakerOf(userId)?.name ?? "Someone"} said stop: she stops (heard at once)`); } }).catch(() => {});
    const before = this.heardOrder.get(userId) ?? Promise.resolve();
    let handling = null;
    const turn = before.then(async () => {
      const heard = await hearing;
      this.costs.stt += this.sttCost(heard.seconds || piece.durationMs / 1000);
      if (!heard.text || this.ended) { if (final !== false && !this.ended) handling = this.releaseHold(userId, "they stopped"); return; }
      const who = this.speakerOf(userId);
      const line = this.transcript.add({ at: startedAt, end: startedAt + piece.durationMs, userId, speaker: who.name, role: who.role, text: heard.text, kind: "voice" });
      this.hearing.line();
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

  /* Where she only listens: the piece is transcribed and written down, and that is all (no stop, no check, no reply).
     Lines are put in the order they were said by the transcript itself. */
  async hearOnly({ userId, packets, startedAt }) {
    const piece = this.toWav(userId, packets);
    if (!piece.wav) { this.counts.skipped++; return; }
    this.counts.pieces++;
    const speaking = this.speakerOf(userId)?.name;
    if (speaking && speaking !== "Someone") this.names.add(speaking);
    const heard = await this.transcribe(piece.wav, { names: [...this.names] });
    this.costs.stt += this.sttCost(heard.seconds || piece.durationMs / 1000);
    if (!heard.text || this.ended) return;
    const who = this.speakerOf(userId);
    this.transcript.add({ at: startedAt, end: startedAt + piece.durationMs, userId, speaker: who.name, role: who.role, text: heard.text, kind: "voice" });
    this.hearing.line();
  }

  /* runs once this speaker's earlier pieces have been taken, so a release can't overtake a piece still being heard */
  async afterTurn(userId, work) {
    await (this.heardOrder.get(userId) ?? Promise.resolve());
    await work();
  }

  /* said (or still being said) since the held question; the asker's own lines from before it are theirs */
  sinceHeld(h, line, until) { return Math.max(line.at, until ?? line.at) > h.at && !(line.userId === h.userId && line.at <= h.at); }

  /* a stop said after the question was said cancels it, wherever it is: transcribing, being checked, queued or looked up */
  stoppedSince(at) { return this.lastStopAt > at; }

  /* `more` means this piece was cut off because the speaker has talked for maxUtteranceSeconds and is still talking */
  /* her own recent words for the echo test: what she last said, and the quick reactions and "I'm ready" lines of the
     last half minute, which never reach `lastSaid` while they play (review 20: "Angel's on it!" coming back through a
     mic named her and didn't match her answer) */
  ownWords() {
    const since = this.now() - 30000;
    this.ownRecent = this.ownRecent.filter(o => o.at >= since);
    return [this.lastSaid ?? "", ...this.ownRecent.map(o => o.text)].join(" ").trim();
  }

  async onLine(line, until = line.at, more = false, released = null) {
    if (isStopRequest(line.text)) { this.stop(line.at); this.log.info(`${line.speaker} said stop: she stops`); return; }
    const uid = line.userId;
    /* She is holding an answer: every line said since the held question, by anyone and however it arrives (the end of
       a long talk, the rest of an "Angel?", a line said while their earlier one is still being checked, the asker's
       own), goes to the check while she waits (review 8 of 0.1.3: each of those went past it). The asker's own lines
       from before the question are theirs and go the usual way. */
    /* Every line said since the question she is looking up or holding goes to the check while she waits; the asker's
       own lines while she looks it up go the usual way first (more to their question is answered all in one, d-6), and
       to the watch only if the usual way would set them aside */
    /* the person she just answered may reply without her name for a little while after she stops talking (Rhea,
       2026-11-14: "you replied first but not when I replied to you"); the check still decides it was for her */
    const r = this.replyTo;
    const replying = !!r && r.userId === uid && line.at >= r.from && line.at <= r.from + this.cfg.replyWindowMs;
    /* (and so do replies to her last answer, which the usual check reads as replies: review 13 of 0.1.3). A watch
       already stopped catches nothing more (review 13: it judged lines until the lookup ended, and a stop read there
       dropped another player's question). */
    const h = this.watch;
    if (h && !h.signal && this.sinceHeld(h, line, until) && (h.ready || (uid !== h.userId && !replying))) return this.onSince(h, line, until, more, released);
    const byName = mentionsAngel(line.text) || released?.byName === true;
    const named = byName || replying || !!released;
    /* the check on this speaker's last line is still running: keep the line, it may be the rest of the question */
    const inFlight = this.checking.get(uid);
    if (inFlight && !byName) { inFlight.push(line.text); return; }
    const waiting = released ? null : this.pending.get(uid);
    if (!waiting && !named) {
      /* not for her by the usual rule, but a question of hers may be on its way: kept for a little while, so a "wait,
         hold on" heard before her answer is ready is judged when she holds it (review 9 of 0.1.3) */
      /* not her own voice coming back (review 10 of 0.1.3: her answer, echoed, was judged as "hold on") */
      if (!(this.voice.inEchoWindow(line.at) && echoOf(line.text, this.ownWords()))) {
        if (this.watch && !this.watch.signal && this.sinceHeld(this.watch, line, until)) return this.onSince(this.watch, line, until, more);
        this.saidSince.push({ line, until, added: this.now(), more });
        while (this.saidSince.length > 20) this.saidSince.shift();
      }
      return;
    }
    /* her own voice coming back through a microphone: an echo only if its words are hers. Not the plain time rule, for
       a reply (2026-11-14: "Nice. And does that stack...?" began 2 s after she finished and was dropped) or a line
       naming her (live round 2026-11-16: "Never mind, Angel" and "Hold on, Angel", said over her quick reaction and her
       answer, were dropped as her own voice; one began before her answer did). */
    if (!released && this.voice.inEchoWindow(line.at) && echoOf(line.text, this.ownWords())) {
      /* in the log, so a line she didn't answer can be explained */
      /* also when a line of theirs waits for the rest: her echo from the same mic is not the rest of their question
         (review 20: "Hold on, Angel." parked, then her own sentence joined to it and sent to the check) */
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
    else if (decision.cutOff) this.log.warn(`the "was that for me?" check ran past its limit; its verdict, written before the cut, was used`);
    /* what the check decided goes in the log (no words, just the verdict), so a line she didn't answer can be explained */
    this.log.info(`check on ${line.speaker}'s line${wasNamed ? "" : " (a reply, no name)"}: ${decision.toAngel ? (decision.chat ? "for Angel, small talk" : decision.complete === false ? "for Angel, waiting for the rest" : "for Angel") : "not for Angel"}`);
    if (this.ended || this.stoppedSince(firstAt)) return;
    /* a hold began while this check ran: the line was said since the held question, so it is judged as a line said
       while she waits, with what they added meanwhile (review 12 of 0.1.3: "Hold on Angel, one sec." whose check was
       still running when her answer was ready was kept for later, and she answered over it) */
    const h2 = this.watch;
    /* a whole question for her goes on the usual way (the asker's, while she looks it up, is answered with theirs,
       d-6; anyone else's is a go-ahead, the held answer first); once her answer is held the asker's goes to the check
       while she waits, to be worked into one fresh answer */
    const aQuestion = decision.toAngel && decision.complete && !decision.stop;
    /* a stop the usual check reads goes on the usual way, not judged a second time (review 13 of 0.1.3: the second
       check could say "none" and she spoke); someone else's drops only the watched answer, as in a hold (review 1) */
    const aStop = decision.stop && (decision.toAngel || wasNamed || replying);
    let watchStopped = false;
    /* the watch a stop belongs to is the one it was said during, not the one current when its check came back (review
       15 of 0.1.3: a "forget it" meant for Mira's answer, already dropped, dropped Sam's next, or everything) */
    let owner = aStop ? this.watchOf({ ...line, at: firstAt }, until) : null;
    while (owner?.next) owner = owner.next; /* merged since: the fuller question's watch */
    /* begun before that question was said: not a stop for it (field test 2026-11-21, as in onHeldLine). Judged by the
       piece that holds it, the one `stop()` below is given, so the stop it becomes is older than the question and
       leaves it alone (review of the fix: by the talk's start, a long talk's stop went global and dropped more) */
    /* and, as there, nothing else: no global stop that would drop an earlier question still waiting, clear calls
       waiting for their rest, or open a reply window (review 22) */
    if (owner && !(line.at > owner.at)) { this.log.info(`${line.speaker}'s line began before ${owner.asker}'s question: not a stop for it`); owner = null; watchStopped = true; }
    if (owner && uid !== owner.userId && (owner === h2 ? !owner.signal || owner.signal === "stop" : owner.signal === "stop")) {
      if (!owner.signal) { this.log.info(`check on ${line.speaker}'s line: read as "stop" for ${owner.asker}'s answer`); owner.poke("stop"); }
      watchStopped = true;
    } else if (h2 && !h2.signal && !aStop && this.sinceHeld(h2, { ...line, at: firstAt }, until)) {
      if (!aQuestion || (h2.ready && uid === h2.userId)) {
        const all = later.length ? `${text} ${later.join(" ")}` : text;
        /* the usual check said it isn't for her: it may still be "hold on", never a question (review 14 of 0.1.3: a
           reply it declined was asked anyway) */
        /* (only what the check saw: what they added while it ran may still be a question, review 15) */
        return this.onHeldLine(h2, { ...line, at: firstAt, text: all }, until, { noAsk: !decision.toAngel && !later.length, pieceAt: line.at });
      }
      if (uid !== h2.userId) h2.poke("go");
    }
    /* "okay, that's enough, thanks" can come back as not for her (a bare acknowledgement) and a stop: from the person
       she is talking with, the stop still counts (review 11) */
    if (!decision.toAngel && !(decision.stop && (wasNamed || replying))) {
      /* kept as any line not for her is, for a hold that may begin ("Hold on Angel, one sec." while she looks something
         up: review 11 of 0.1.3) */
      /* declined by the usual check: when a watch takes it up later it can still be "hold on", never a question
         (review 16 of 0.1.3: review 14's rule held only for a watch already running) */
      this.saidSince.push({ line: { ...line, text: later.length ? `${text} ${later.join(" ")}` : text }, until, added: this.now(), declined: !later.length });
      while (this.saidSince.length > 20) this.saidSince.shift();
      return;
    }
    let at = firstAt;
    let asked = text; /* their own words */
    if (decision.stop) {
      /* in the log, so a line taken as a stop can be explained (live 2026-11-15: "Cut me off there." was read as one,
         her answer was never spoken and the lines after it went unheard). A stop only the check read into the line
         gives them a reply window, so a wrong reading costs one answer, not the conversation. */
      if (!watchStopped) {
        this.log.info(`check on ${line.speaker}'s line: read as "stop": she stops`);
        this.stop(line.at, { keepReplyWindow: true });
        /* a fresh minute from now, not what was left of the last one (review 11), with the small-talk count kept */
        if (uid) this.replyTo = { userId: uid, from: this.now(), turn: r?.userId === uid ? r.turn : 0 };
      }
      if (!decision.toAngel) return;
      /* "Angel, stop. What does stunned do?": stop, then answer the question (asked just after the stop): their own
         words from after the stop, which is already done (the check's wording when the stop can't be cut off) */
      if (!(decision.complete && decision.question && /\?/.test(text))) return;
      at = line.at + 1;
      asked = afterStop(text) || decision.question;
    }
    /* what they said while the check ran is the rest of the question, finished or not */
    const rest = later.length ? ` ${later.join(" ")}` : "";
    /* the small-talk count is this speaker's own, from their open reply window; a named question starts it again */
    const count = { turn: wasNamed ? 0 : (r?.userId === uid ? r.turn : 0), unnamed: !wasNamed };
    if (!decision.complete) {
      if (rest) { this.ask({ question: `${text}${rest}`, meaning: "", asker: line.speaker, role: line.role, via: "voice", at, userId: uid, until, chat: decision.chat === true, ...count }); return; }
      const timer = setTimeout(() => this.pending.delete(uid), this.cfg.followUpMs);
      timer.unref?.();
      /* her name in this first part still makes the whole a named question (review 8) */
      this.pending.set(uid, { text, at: this.now(), timer, byName: wasNamed, line: { ...line, text } });
      return;
    }
    /* the answer is worked out from their own words; the check's reading of them (a paraphrase by a small model, which
       can drop or bend a detail) goes along as a hint only, and is what the post shows as the question */
    this.ask({ question: `${asked}${rest}`, meaning: decision.question ? `${decision.question}${rest}` : "", asker: line.speaker, role: line.role, via: "voice", at, userId: uid, until, chat: decision.chat === true, ack: decision.ack || "", ...count });
  }

  /* A line said since the question she is looking up or holding, by anyone and however it arrives (the end of a long
     talk, the rest of an "Angel?", a line said while their earlier one is still being checked, the asker's own): it goes
     to the check while she waits (review 8 and 12 of 0.1.3). */
  onSince(h, line, until, more = false, released = null, { noAsk = false } = {}) {
    const uid = line.userId;
    const before = released ?? this.pending.get(uid);
    const all = released ? released.text : before ? `${before.text} ${line.text}` : line.text;
    const firstAt = before?.held ? before.firstAt : (before?.firstAt ?? line.at);
    if (more) {
      /* still talking: kept, the rest to come; what is said so far may already be "hold on" */
      if (before && !released) clearTimeout(before.timer);
      const holdMs = this.cfg.maxUtteranceSeconds * 1000 + this.cfg.followUpMs;
      /* kept for this hold only (dropped when it ends, so nothing judged here is judged again: review 11 of 0.1.3),
         unless it was already a long question of theirs before the hold */
      const kept = { text: all, at: this.now(), holdMs, byName: mentionsAngel(line.text) || before?.byName === true, held: true, firstAt, line: { ...line, at: firstAt }, until, keptFor: before?.held && !before.keptFor ? null : h };
      kept.timer = setTimeout(() => this.releaseHold(uid, "the rest never came"), holdMs);
      kept.timer.unref?.();
      this.pending.set(uid, kept);
      return this.onHeldLine(h, { ...line, at: firstAt, text: all }, until, { partial: true, pieceAt: line.at });
    }
    if (before && !released) { this.pending.delete(uid); clearTimeout(before.timer); }
    return this.onHeldLine(h, { ...line, at: firstAt, text: all }, until, { noAsk: noAsk && !before, pieceAt: line.at });
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
    /* typed to her where she only listens: kept in the transcript, and one short line back, no lookup (d-10) */
    if (this.listenOnly) return (reply ?? this.post).send(LISTEN_ONLY_REPLY).catch(() => {});
    if (this.overCap()) {
      /* a deferred /angel ask must still get an answer, or Discord shows "thinking…" for 15 minutes */
      return (reply ?? this.post).send(this.capMessage()).catch(() => {});
    }
    /* someone else asking her, typed, while she holds an answer: a go-ahead, as a spoken question is (review of 0.1.3) */
    if (this.watch && userId !== this.watch.userId) this.watch.poke("go");
    return this.ask({ question: text, asker, role, via: "text", reply, at: line.at, userId });
  }

  ask(q) {
    this.counts.questions++;
    let asked = { at: this.now(), ...q };
    let into = null; /* the reply this one replaces: it takes that one's place in line (Rhea, d-7) */
    /* the same person said more before she began to speak her reply to them: that reply is dropped and everything they
       said is answered as one (Rhea, 2026-11-15: "Interesting." then "How hard is it to search?" got two replies, the
       first talking past her question; "Answer all in one"). Once she has begun speaking, the new line waits its turn. */
    const uid = q.via === "voice" ? q.userId : null;
    if (uid) {
      const prev = this.open.get(uid);
      if (prev && !prev.started && !prev.superseded && !this.ended && !this.stoppedSince(prev.at) && !this.overCap()) {
        prev.superseded = true;
        prev.drop();
        into = prev;
        this.counts.merged++;
        this.log.info(`${q.asker} said more before she began her reply: answering it all as one`);
        asked = {
          ...asked,
          question: `${prev.question} ${q.question}`,
          meaning: prev.meaning || q.meaning ? `${prev.meaning || prev.question} ${q.meaning || q.question}` : "",
          chat: prev.chat === true && q.chat === true,
          unnamed: prev.unnamed === true && q.unnamed === true,
          turn: Math.min(prev.turn ?? 0, q.turn ?? 0),
          until: q.until ?? prev.until,
          /* a stop said after the first line cancels all of it (review 10) */
          at: prev.at,
          ack: prev.ackPlayed ? "" : q.ack,
          noAck: prev.ackPlayed,
        };
      }
      asked = this.withEntry(uid, asked);
      /* a merged question keeps the first one's place in line, ahead of another player's question already waiting
         (Rhea, 2026-11-15, d-7; 0.1.2 put it at the back): the first one's turn runs it */
      if (into) { into.replacement = asked; return this.answering; }
    }
    this.answering = this.answering.then(() => this.runAsk(asked)).catch(e => this.log.error(`answering failed: ${e.message}`));
    return this.answering;
  }

  /* the speaker's open reply, so a line they add before she begins can be answered with it */
  withEntry(uid, asked) {
    let drop;
    const entry = { question: asked.question, meaning: asked.meaning ?? "", chat: asked.chat, unnamed: asked.unnamed, turn: asked.turn, until: asked.until, at: asked.at,
      started: false, superseded: false, ackPlayed: asked.noAck === true, dropped: new Promise(r => { drop = r; }), replacement: null };
    entry.drop = () => drop(DROPPED);
    this.open.set(uid, entry);
    return { ...asked, entry };
  }

  /* one turn in line: the question, then whatever replaced it (a merged question runs in its place) */
  async runAsk(q) {
    for (let cur = q; cur; cur = cur.entry?.replacement ?? null) {
      try { await this.runAskInner(cur); }
      catch (e) { this.log.error(`answering failed: ${e.message}`); }
      finally {
        if (cur.entry && this.open.get(cur.userId) === cur.entry) this.open.delete(cur.userId);
        /* a question dropped or never spoken ends its watch here (one spoken ends it as she begins) */
        if (this.watch) this.endWatch(this.watch);
      }
    }
  }

  async runAskInner({ question, meaning = "", asker, role = "player", via, reply, at, userId = null, until = null, chat = false, turn = 0, unnamed = false, ack = "", noAck = false, entry = null }) {
    const target = reply ?? this.post;
    /* they said more before its turn came: answered together with what they said next */
    if (entry?.superseded) return;
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
    const saidBefore = this.lastSaid; /* put back if nothing of this one is said */
    /* small talk spoken to her: no "looking it up", no post in the channel, just her spoken reply */
    const quiet = chat && via === "voice" && this.cfg.speak;
    /* the placeholder and her quick reaction are started but not waited for: the answer is already being worked out */
    const placed = quiet ? null
      : target.send(`**${asker} asked:** ${shortQuestion(shown)}\n-# Looking it up…`).catch(e => { this.log.warn(`couldn't post in the channel: ${e.message}`); return null; });
    /* everything she says for this question is handed to the voice in order, through this chain */
    let line = Promise.resolve();
    let ackText = "";
    /* the table is busy as she takes the question up: no quick reaction, so she cuts in at most once for it (Rhea, d-7) */
    const busyNow = !quiet && !noAck && this.cfg.speak && this.cfg.ackPhrase !== "" && this.floor?.busy() === true;
    if (busyNow) this.log.info(`the table is busy as ${asker}'s question is taken up: no quick reaction`);
    if (!quiet && !noAck && this.cfg.speak && this.cfg.ackPhrase !== "" && !busyNow) {
      if (entry) entry.ackPlayed = true;
      /* her own quick reaction to this question (the check writes it), else one of a few, so it isn't the same line
         every time (Rhea, 2026-11-14: "the 'one sec, let me check' on every reply is getting repetitive") */
      const words = ack || ACKS[this.counts.questions % ACKS.length];
      ackText = words;
      this.ownRecent.push({ text: words, at: this.now() });
      const made = this.tts(words);
      line = made.then(clips => { this.costs.tts += this.ttsCost(words); if (!this.ended && !this.stoppedSince(at)) this.voice.speak(clips); })
        .catch(() => { if (this.ackClips && !this.ended && !this.stoppedSince(at)) this.voice.speak(this.ackClips); });
    }

    /* Her answer is spoken as she writes it (Rhea chose this to make her faster, 2026-11-14): each sentence of `say`
       is turned into voice the moment it is whole, and the pieces play in order behind her quick reaction. */
    const said = [];       /* the pieces given to the voice so far */
    const times = {};      /* for the log: when the first words were written, when her voice started */
    let lastPlayed = null; /* resolves when the last piece has played (or was stopped) */
    let clipCount = 0;      /* clips of this answer handed to the voice, for the gaps in the timing line */
    /* before the first piece plays: is the table busy? (Rhea, d-7) "go", or why she won't say it: "letgo" (no gap
       came), "stop", "merge" (the asker said more: one fresh answer to all of it), "end" */
    const qc = { question, meaning, asker, role, via, at, userId, until, chat, turn, unnamed, entry, get ackText() { return ackText; } };
    /* from here every line said since the question is judged as one said while she waits (review 12 of 0.1.3) */
    qc.watch = this.startWatch(qc);
    let floor = null;
    let floorAt = null;
    const spokenNow = []; /* the pieces handed to the voice */
    const sayPiece = text => {
      const spoken = speakable(text);
      /* the cap is asked before she begins an answer, not in the middle of one: a sentence of voice costs a
         fraction of a cent, and an answer cut off half way helps nobody */
      if (!spoken || !this.cfg.speak || this.ended || this.stoppedSince(at) || (!said.length && this.overCap())) return;
      /* dropped for a fuller question before she began: nothing of it is said. Once begun, it can't be dropped. */
      if (entry?.superseded && !said.length) return;
      /* dropped for a fuller question while she held it: nothing more of it is voiced (review 2 of 0.1.3) */
      if (entry?.mergedAway) return;
      if (entry) entry.started = true;
      const made = this.tts(spoken);
      made.catch(() => {}); /* waited for in order below; a failure there is logged once */
      said.push(text);
      line = line.then(async () => {
        let clips;
        try { clips = await made; this.costs.tts += this.ttsCost(spoken); }
        catch (e) { this.log.warn(`couldn't speak the answer: ${e.message}`); return; }
        if (this.ended || this.stoppedSince(at)) return;
        if (!floor) {
          try { floor = await this.takeFloor(qc); }
          catch (e) { this.log.warn(`couldn't judge whether the table is busy (${e.message}): speaking`); floor = "go"; }
          floorAt = this.now();
        }
        if (floor !== "go" || this.ended || this.stoppedSince(at)) return;
        /* hers for the echo check once it is handed to the voice, not before (review 11 of 0.1.3: words not yet said,
           held for a gap, made a real "Hold on." look like her own voice) */
        spokenNow.push(text);
        this.lastSaid = spokenNow.join(" ");
        try { lastPlayed = this.voice.speak(clips, { onStart: () => { times.voice ??= this.now(); } }); clipCount += clips.length; }
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

    /* a dropped reply leaves nothing behind: no post (its placeholder is taken away, not waited for), no transcript
       line, no reply window; its cost is counted when its call ends. Past this point the reply can't be dropped. */
    const answeringRef = {};
    const dropNow = got => {
      if (!(entry?.superseded && !entry.started) && !entry?.mergedAway) {
        if (entry) entry.started = true; /* the answer is in hand: from here it is hers to give (review 10) */
        return false;
      }
      if (got.raced) answeringRef.p?.then(r => { this.costs.claude += r?.dollars ?? 0; }, e => { this.costs.claude += e?.dollars ?? 0; });
      else this.costs.claude += (got.result ?? got.error)?.dollars ?? 0;
      placed?.then(m => m?.delete?.().catch(() => {}));
      return true;
    };
    let result;
    try {
      /* her last written answer goes along: the table can see it and asks about it ("what about that second
         exception?"), and only her spoken words are in the transcript */
      const w = this.lastWritten;
      const wrote = w && this.now() - w.at <= this.cfg.memoryMinutes * 60000 ? `\n\nYour last written answer in the text channel (the table can see it):\n${w.text}` : "";
      const answering = this.answer({
        conversation: Transcript.format(this.transcript.recent(this.cfg.memoryMinutes, this.now())) + wrote,
        question, meaning, asker, via, onSay,
        /* this reply, if it stays small talk, closes the window: she says so in her own words (Rhea, 2026-11-15) */
        lastReply: via === "voice" && !!userId && unnamed && chat && turn + 1 >= 3,
      });
      answeringRef.p = answering;
      /* dropped while it was being worked out: the next question doesn't wait for it, and what it cost still counts */
      let first;
      try { first = entry ? await Promise.race([answering, entry.dropped]) : await answering; }
      catch (e) { if (dropNow({ error: e })) return; throw e; }
      /* dropped while it was worked out, or in the moment after (review 10): whatever came back is not used */
      if (dropNow(first === DROPPED ? { raced: true } : { result: first })) return;
      result = first === DROPPED ? await answering : first;
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
    /* only small talk counts toward the limit of three unnamed replies in a row, so banter can't run on at the
       table's expense; rules follow-ups ("can you elaborate?", "yes please") never use it up (Rhea, 2026-11-15:
       her fourth reply in a row, a question after three rules answers, was left unanswered) */
    /* a failed or cut-off answer doesn't count: she has already asked them to try again (review 8); one that failed
       only after all she had to say was spoken does, since she said it (review 9) */
    const smallTalk = chat && !(result.lookups > 0) && !(result.failed && !result.saidAll) && !result.cut;
    const run = unnamed && smallTalk ? turn + 1 : turn;
    /* when that limit closes the window she has said so in her own reply (`lastReply` above), not with a fixed line */
    const heard = result.failed && early && !result.saidAll ? `${early} ${result.say}` : result.say;

    /* the check may call a rules question small talk: one that looked something up is posted anyway */
    let posted = false;
    let postedMsg = null;
    let wroteBefore = null, ownWritten = null; /* her last written answer before this one, put back if this post goes */
    const LET_GO_NOTE = "\n-# (The table was busy, so I didn't get a gap to say this aloud.)";
    const typedWith = (note = "") => typedAnswer({ asker, question: shown, say: result.details ?? result.say, sources: result.sources, unchecked: result.failedLookups > 0, note });
    const post = async (note = "") => {
      if (posted) return;
      posted = true;
      const typed = typedWith(note);
      /* kept for the next question only when it is a checked rules answer: not small talk, not one a lookup failed for */
      if (!result.failed && result.details && !chat && !result.cut && !result.detailsLost && result.lookups > 0 && !(result.failedLookups > 0)) { wroteBefore = this.lastWritten; this.lastWritten = ownWritten = { at: this.now(), text: result.details }; }
      const placeholder = await placed;
      try { if (placeholder?.edit) { await placeholder.edit(typed); postedMsg = placeholder; } else postedMsg = await target.send(typed); }
      catch (e) { this.log.warn(`couldn't post the answer: ${e.message}`); }
    };
    if (!quiet || result.failed || result.lookups > 0 || result.sources?.length) await post();
    await line.catch(e => this.log.warn(`speaking failed: ${e.message}`));
    /* in the transcript at the moment she began to say it (after a wait for a gap, when the gap came); not at all when
       she never got to say it */
    const unsaid = floor !== null && floor !== "go";
    /* what she really said for it, for the echo check: her reaction and her "I'm ready", not the answer (review 3) */
    if (unsaid) this.lastSaid = [ackText, qc.cutIn].filter(Boolean).join(" ") || saidBefore;
    if (!unsaid) {
      this.transcript.add({ at: floor === "go" && floorAt && floorAt > (times.written ?? 0) ? floorAt : (times.written ?? this.now()), speaker: "Angel", role: "angel", text: heard, kind: "angel" });
      this.lastSaid = heard;
    }
    const since = t => (t == null ? "n/a" : `${((t - began) / 1000).toFixed(1)} s`);
    /* the silences between the clips of this answer, so a choppy-sounding one can be told apart: a long gap is a
       sentence whose voice wasn't ready yet, a short one is the join between clips (Rhea, 2026-11-15) */
    const gaps = () => {
      /* this answer's own clips only: the first `clipCount` from when her voice began (the next answer's may follow) */
      const p = (this.voice.periods ?? []).filter(([start]) => times.voice != null && start >= times.voice).slice(0, clipCount);
      if (p.length < 2) return "";
      const g = p.slice(1).map(([start], i) => ((start - p[i][1]) / 1000).toFixed(2));
      return `; ${p.length} clips, gaps between them ${g.join(", ")} s${p.length < clipCount ? ` (${clipCount} clips, the rest not kept)` : ""}`;
    };
    const startLog = () => this.log.info(`timing for ${asker}'s question: first words written ${since(times.written)}, her answer began aloud ${since(times.voice)}, whole answer written ${since(times.answered)} after it was taken up`
      + `${until ? ` (taken up ${((began - until) / 1000).toFixed(1)} s after they stopped talking)` : ""}; ${result.rounds ?? "?"} round(s), ${result.lookups ?? 0} lookup(s)${early ? "" : ", not spoken as written"}${gaps()}`);
    /* nothing of the answer reached the voice (told to stop, the session ended, a cap, or the voice failed): a
       small-talk reply that was only going to be spoken is typed instead, unless she was told to stop */
    /* the limit reached closes their window whether or not her voice got it out (review 9) */
    if (via === "voice" && userId && run >= 3 && this.replyTo?.userId === userId) this.replyTo = null;
    if (floor === "letgo") {
      /* no gap came in time: the written answer says so, and the asker can still ask "what was it?" without her name */
      startLog();
      if (posted) { if (postedMsg?.edit) await postedMsg.edit(typedWith(LET_GO_NOTE)).catch(e => this.log.warn(`couldn't note the post: ${e.message}`)); }
      else await post(LET_GO_NOTE);
      if (via === "voice" && userId && run < 3 && !this.ended && !this.stoppedSince(at)) {
        this.replyTo = { userId, from: this.now(), turn: run };
        this.log.info(`${asker} can reply without her name for ${Math.round(this.cfg.replyWindowMs / 1000)} s`);
      }
      return;
    }
    /* replaced by a fuller question while she waited: its post goes, the fuller answer is the one (review of 0.1.3) */
    if (floor === "merge") {
      const m = postedMsg ?? await placed;
      m?.delete?.().catch(() => {});
      /* the table can't see it any more: not "your last written answer" for the fresh one (review 2 of 0.1.3) */
      if (ownWritten && this.lastWritten === ownWritten) this.lastWritten = wroteBefore;
    }
    /* stopped, replaced by a fuller question, or the session ended while she waited for a gap: nothing more */
    if (unsaid) { startLog(); return; }
    if (!lastPlayed) {
      if (this.cfg.speak) startLog();
      if (quiet && !this.stoppedSince(at)) await post();
      return;
    }
    /* the person she answered may reply without her name, from when this answer ends (the limit is set above) */
    Promise.resolve(lastPlayed).then(() => {
      startLog();
      if (this.ended || this.stoppedSince(at)) return;
      if (via === "voice" && userId && run < 3) {
        this.replyTo = { userId, from: this.now(), turn: run };
        this.log.info(`${asker} can reply without her name for ${Math.round(this.cfg.replyWindowMs / 1000)} s`);
      }
    }).catch(() => {});
  }

  /* A busy table (Rhea, 2026-11-15, d-7: "she cuts in with a quick, I'm ready style responce and then waits for a gap
     or somone to give some type of go ahead"). Called once per answer, before its first piece plays. Free when the
     table is quiet: Discord's speaking signal decides, nothing is heard or paid for.
     - Someone talking: she waits up to busyFirstWaitMs for a pause of busyPauseMs; if one comes she just answers.
     - Still talking: a quick "I'm ready" in her own words (one tiny call writes it), then she waits for busyGapMs of
       quiet or a go-ahead ("go ahead", her name, another player's question; judged in `onHeldLine`).
     - "Hold on" (before or after the cut-in): only a go-ahead releases her; she doesn't cut in after it.
     - No opening within busyMaxHoldMs of nonstop talk: she lets the spoken answer go ("letgo").
     Returns "go", "letgo", "stop", "merge" or "end". */
  /* Can she hold an answer at all? Only while she speaks and the busy table is on. */
  canHold() { return !!this.floor && this.cfg.busyTable !== false && !!this.cfg.speak && !this.ended; }

  /* The watch on a question, from when it is taken up to when she speaks (or doesn't): every line said since the
     question goes to the check while she waits (`onSince`), so a "hold on" said while she looks it up is judged the
     same way as one said while she holds the answer (review 12 of 0.1.3: the structural change review 11 named).
     Before her answer is ready (`ready` false) a "hold on" and a stop count at once; a go-ahead only takes back a
     "hold on": it can't wave her through a table that is still talking when her answer comes. */
  startWatch(qc) {
    if (!this.canHold()) return null;
    let signalled, kicked;
    const h = { ...qc, since: this.now(), ready: false, mode: "gap", cutIn: "", signal: null, waiter: null, goAsked: false,
      signalled: new Promise(r => { signalled = r; }), kicked: new Promise(r => { kicked = r; }) };
    /* "wait" changes how she waits; "go" asks to go once nothing said is unheard (a later "wait" or stop still
       counts, review 8 of 0.1.3); anything else ends the wait, and the first one stands */
    h.poke = reason => {
      if (h.signal) return;
      /* a "hold on" also takes back an invitation carried from a merge (review 22 of 0.1.3) */
      if (reason === "wait") { h.mode = "invite"; h.goAsked = false; h.goCarried = false; h.waiter?.wake("wait"); return; }
      if (reason === "go") {
        if (!h.ready) { if (h.mode === "invite") h.mode = "gap"; return; }
        h.goAsked = true; kicked("go"); h.waiter?.wake("go"); return;
      }
      h.signal = reason;
      signalled(reason);
      kicked(reason);
      h.waiter?.wake(reason);
    };
    /* a question merged with more from the asker goes on from where its first watch stood: a "hold on" still holds,
       who named her still counts, and verdicts still on their way act on this one (review 13 of 0.1.3: Sam's "hold on"
       was forgotten when Mira's addition merged) */
    const from = this.carry;
    this.carry = null;
    /* merged again before the first merge's watch began: follow the chain (review 14 of 0.1.3) */
    let link = from?.entry;
    while (link?.replacement?.entry && link.replacement.entry !== qc.entry) link = link.replacement.entry;
    if (from && link?.replacement?.entry === qc.entry) {
      if (from.mode === "invite") h.mode = "invite";
      if (from.goCarried) { h.mode = "gap"; h.goCarried = true; }
      if (from.named) h.named = new Set(from.named);
      from.next = h;
    }
    this.watch = h;
    /* lines said since the question before it was taken up (it waited in line, or they came while its own check ran),
       heard already: handed to the same path now, the last six at most (review 10: a lively table waits a check's
       time, not one per line), each held as "being heard" until it is judged */
    const now0 = this.now();
    this.saidSince = this.saidSince.filter(u => now0 - u.added < 20000);
    const since = this.saidSince.filter(u => this.sinceHeld(h, u.line, u.until));
    for (const u of since) this.saidSince.splice(this.saidSince.indexOf(u), 1);
    const judge = (work, what) => {
      const no = ++this.pieceNo;
      this.hearingNow.set(no, { end: this.now(), added: this.now() });
      Promise.resolve().then(work).catch(e => this.log.warn(`couldn't judge ${what}: ${e.message}`)).finally(() => this.hearingNow.delete(no));
    };
    for (const u of since.slice(-6)) judge(() => this.onSince(h, u.line, u.until, u.more === true, null, { noAsk: u.declined === true }), "a line said since the question");
    /* a call waiting for the rest ("Angel, about the grab," or "Hold on Angel, one sec." read as a call), said since the
       question by someone else: it stays waiting, so the rest still joins it (review 12: taken away, the rest was a
       question of its own or lost), and what it says so far is judged now (it may be "hold on") */
    for (const [u, p] of this.pending) {
      if (p.held || !p.line || u === qc.userId || !(p.line.at > qc.at)) continue;
      judge(() => this.onHeldLine(h, p.line, p.line.at, { partial: true }), "a call said since the question");
    }
    return h;
  }

  /* the watch a line was said during: the earliest whose question came before it and that hadn't ended when it was said
     (one still current, or one of the last few ended) */
  watchOf(line, until) {
    for (const w of [...this.pastWatches, this.watch]) {
      if (w && this.sinceHeld(w, line, until) && (w.endedAt == null || line.at < w.endedAt)) return w;
    }
    return null;
  }

  /* the watch is over: she speaks, lets it go, or the question was dropped. Talk kept only for it is dropped, so
     nothing judged here is judged again (review 9 to 11 of 0.1.3; a question spoken at length across two of her
     holds is lost: rare). */
  endWatch(h) {
    if (!h) return;
    /* merged into a fuller question: its watch goes on from this one */
    if (h.entry?.replacement) this.carry = h;
    if (this.watch === h) this.watch = null;
    if (this.holding === h) this.holding = null;
    if (h.endedAt == null) {
      h.endedAt = this.now();
      this.pastWatches.push(h);
      while (this.pastWatches.length > 4) this.pastWatches.shift();
    }
    h.waiter?.wake("end");
    for (const [uid, p] of [...this.pending]) {
      if (p.keptFor !== h) continue;
      clearTimeout(p.timer);
      this.pending.delete(uid);
    }
  }

  async takeFloor(qc) {
    const f = this.floor;
    const h = qc.watch;
    if (!f || !h || this.cfg.busyTable === false || !this.cfg.speak || this.ended) { this.endWatch(h); return "go"; }
    /* a quiet table, and nothing said since the question still unheard or being judged: at once, nothing paid.
       Something just said ("wait, hold on") and not heard yet is waited for (Rhea, 2026-11-15 afternoon, after
       review 8: "Wait to hear it"; free, a second or two) */
    const busyAtStart = f.busy();
    if (h.signal) { this.endWatch(h); return this.held(h); }
    if (!busyAtStart && h.mode !== "invite" && !this.unheard(qc.at)) { this.endWatch(h); return "go"; }
    h.ready = true;
    if (h.goCarried) h.goAsked = true;
    h.since = this.now();
    this.holding = h;
    this.counts.held++;
    const who = qc.asker;
    this.log.info(busyAtStart ? `the table is busy as ${who}'s answer is ready: waiting for a gap` : h.mode === "invite" ? `told to hold on while she looked it up: ${who}'s answer waits for a go-ahead` : `something was just said as ${who}'s answer is ready: waiting to hear it`);
    const deadline = h.since + this.cfg.busyMaxHoldMs;
    /* a pause or gap is at least as long as it takes a piece of speech to reach her (it ends after silenceMs of
       silence), so what was said just before it is already being heard when it is judged (review 2 of 0.1.3) */
    const reachMs = this.cfg.silenceMs + 200;
    const pauseMs = Math.max(this.cfg.busyPauseMs, reachMs);
    const gapMs = Math.max(this.cfg.busyGapMs, reachMs);

    const left = () => Math.max(0, deadline - this.now());
    const wait = (needMs, opts) => {
      if (h.signal) return Promise.resolve(h.signal);
      const w = f.waitForQuiet(needMs, opts);
      h.waiter = w;
      return w.promise.finally(() => { if (h.waiter === w) h.waiter = null; });
    };
    /* her words are written while she waits, so they are ready if she needs them; a pause that comes first leaves
       them unsaid (a fraction of a cent) */
    /* written only when she may need it: the table busy now, or once it is (nothing is paid for a just-said line) */
    let readyMade = null;
    const makeReady = () => readyMade ??= (!this.readyLine ? Promise.reject(new Error("nothing to write it")) : Promise.resolve()
      .then(() => this.readyLine({ question: qc.meaning || qc.question, asker: who, earlier: this.readies.slice(-5) }))
      .then(async r => {
        this.costs.claude += r?.dollars ?? 0;
        if (!r?.text) throw new Error("no words came back");
        const clips = await this.tts(r.text);
        this.costs.tts += this.ttsCost(r.text);
        return { text: r.text, clips };
      }));
    let readyDone = false;
    const ready = () => { const p = makeReady(); p.then(() => { readyDone = true; }, () => { readyDone = true; }); return p; };
    if (busyAtStart && !h.goCarried) ready().catch(() => {});
    /* a go-ahead came: she goes once nothing said is unheard; null when a "hold on" took it back or time ran out */
    const goNow = async () => {
      while (h.goAsked && !h.signal && !this.ended) {
        if (!this.unheard(h.at)) { this.log.info(`a go-ahead: ${who}'s answer goes ahead`); return "go"; }
        /* time is up: the hold ends (review 9 of 0.1.3: a wait of 0 ms returned at once, round and round, and froze
           the whole bot) */
        if (left() <= 0) return null;
        const r2 = await wait(0, { maxMs: left(), blocked: () => this.unheard(h.at) });
        if (r2 === "timeout") return null;
      }
      return null;
    };
    try {
      /* 0. invited as the question was finished: no wait for a pause, no cut-in */
      if (h.goCarried && await goNow()) return "go";
      if (h.signal) return this.held(h);
      /* 1. a moment for a natural pause */
      let r = h.mode === "invite" ? "wait" : await wait(pauseMs, { maxMs: Math.min(this.cfg.busyFirstWaitMs, left()), blocked: () => this.unheard(h.at) });
      if (r === "quiet") { this.log.info(`a pause came: ${who}'s answer goes ahead`); return "go"; }
      if (h.signal) return this.held(h);
      if (h.goAsked && await goNow()) return "go";
      if (h.signal) return this.held(h);
      /* 2. still talking: she cuts in, unless told to hold on, or they stopped as the moment passed */
      let since = -Infinity;
      let cutDone = false, cutFailed = false;
      /* what was said is known and nobody is talking (review 3 and 4 of 0.1.3) */
      /* and quiet long enough for the last words to have reached her: a finished stretch's piece comes silenceMs
         after it, whatever its length (review 7 of 0.1.3: after 10 s of talk the cap let her answer go 0.5 s after
         "...hold on, Angel") */
      const settled = () => !f.busy() && f.quietFor(this.now()) >= reachMs && !this.unheard(h.at);
      /* her "I'm ready": once, only while someone is talking, never after "hold on"; the time limit still counts while
         her words are being written */
      const cutIn = async () => {
        let timer;
        const late = new Promise(r => { timer = setTimeout(() => r({ late: true }), left()); });
        const got = await Promise.race([ready().catch(e => ({ failed: e })), h.kicked, late]);
        clearTimeout(timer);
        if (h.signal || h.goAsked || got?.late || this.ended || h.mode === "invite" || this.stoppedSince(qc.at)) return;
        if (got?.failed) { cutFailed = true; this.log.warn(`couldn't make her "I'm ready" (${got.failed.message}): waiting without it`); return; }
        /* only while someone is talking. Her "I'm ready" may land over words not heard yet (Rhea, 2026-11-15 15:0x,
           after review 6 showed that waiting to be sure meant she never cut in at a table that talks with breaths:
           "Yes, cut in anyway"); her answer itself never goes over an unheard line. */
        if (!f.busy()) return;
        cutDone = true;
        h.cutIn = qc.cutIn = got.text;
        this.ownRecent.push({ text: got.text, at: this.now() });
        this.readies.push(got.text);
        if (this.readies.length > 10) this.readies.shift();
        const cutAt = this.now();
        this.log.info(`the table is still talking: she says she's ready, then waits for a gap or a go-ahead`);
        await this.voice.speak(got.clips);
        this.transcript.add({ at: cutAt, speaker: "Angel", role: "angel", text: got.text, kind: "angel" });
        since = this.now();
      };
      if (h.mode !== "invite" && !f.busy() && this.unheard(h.at)) this.log.info(`the talk stopped; waiting to hear what was said`);
      else if (h.mode !== "invite") {
        if (settled()) { this.log.info(`the talk stopped: ${who}'s answer goes ahead`); return "go"; }
        /* while her words are written and voiced, a pause or the time limit still counts (review of 0.1.3) */
        const watch = f.waitForQuiet(pauseMs, { maxMs: left(), blocked: () => this.unheard(h.at) });
        h.waiter = watch;
        /* her words are only written while someone talks */
        const readyP = f.busy() ? ready().then(() => ({ ready: true }), () => ({ ready: true })) : new Promise(() => {});
        const got = await Promise.race([readyP, h.kicked, watch.promise.then(r => ({ floor: r }))]);
        watch.wake("done");
        if (h.waiter === watch) h.waiter = null;
        if (h.signal) return this.held(h);
        if (h.goAsked) { if (await goNow()) return "go"; if (h.signal) return this.held(h); }
        if (got?.floor === "quiet") { this.log.info(`a pause came: ${who}'s answer goes ahead`); return "go"; }
        if (got?.floor === "timeout") { this.counts.letGo++; this.log.info(`no gap came in ${Math.round(this.cfg.busyMaxHoldMs / 1000)} s: ${who}'s spoken answer is let go (it is in the thread)`); return "letgo"; }
        if (got?.ready) {
          if (settled()) { this.log.info(`the talk stopped: ${who}'s answer goes ahead`); return "go"; }
          if (f.busy()) await cutIn();
          else this.log.info(`the talk stopped; waiting to hear what was said`);
        }
        /* got.floor "wait": "hold on" while her words were written: no cut-in */
      }
      /* 3. a gap (not after "hold on") or a go-ahead, until the time is up; if the talk starts again before she has
         cut in, she cuts in then (review 4 of 0.1.3: she stayed silent for the whole minute) */
      for (;;) {
        if (h.signal) return this.held(h);
        if (this.ended) return "end";
        if (left() <= 0) break;
        if (h.goAsked) { if (await goNow()) return "go"; continue; }
        if (left() <= 0) break;
        const canCut = !cutDone && !cutFailed && h.mode !== "invite" && !!this.readyLine;
        r = await wait(h.mode === "invite" ? Infinity : gapMs, { maxMs: left(), since, blocked: () => this.unheard(h.at), orBusy: canCut });
        if (r === "wait") { this.log.info(`told to hold on: ${who}'s answer waits for a go-ahead`); continue; }
        if (r === "go") continue;
        if (r === "quiet") { this.log.info(`a gap came: ${who}'s answer goes ahead`); return "go"; }
        if (r === "busy") {
          /* her words not ready yet: keep watching for a gap meanwhile, not just wait for them (review 5 of 0.1.3) */
          if (readyDone) await cutIn(); else ready().catch(() => {});
          if (!cutDone && !cutFailed && !h.signal) await this.pauseBriefly();
          continue;
        }
        if (r === "timeout") break;
      }
      if (h.signal) return this.held(h);
      this.counts.letGo++;
      this.log.info(`no gap came in ${Math.round(this.cfg.busyMaxHoldMs / 1000)} s: ${who}'s spoken answer is let go (it is in the thread)`);
      return "letgo";
    } finally {
      this.endWatch(h);
    }
  }

  /* a moment, so a cut-in that couldn't happen (the talk stopped as her words came) isn't tried again at once */
  pauseBriefly() { return new Promise(r => setTimeout(r, 200)); }

  /* what ended a hold early, as takeFloor returns it */
  held(h) {
    const why = { go: "a go-ahead", stop: "a stop", merge: "more to the question", end: "the session ending" }[h.signal] ?? h.signal;
    this.log.info(`${h.asker}'s held answer: ${why}`);
    return h.signal === "go" ? "go" : h.signal;
  }

  /* A line said while she holds an answer: a go-ahead, a "hold on", a stop, a question, or nothing for her. */
  /* `pieceAt`: when the piece being judged began (`line.at` is when their whole talk began, for a long one) */
  async onHeldLine(h, line, until, { partial = false, noAsk = false, pieceAt = line.at } = {}) {
    const uid = line.userId;
    /* her own "I'm ready" coming back through a microphone */
    /* her own words for this question coming back through a microphone: the quick reaction or the "I'm ready" */
    const mine = `${h.ackText ?? ""} ${h.cutIn} ${this.lastSaid ?? ""}`.trim();
    if (mine && this.voice.inEchoWindow(line.at) && echoOf(line.text, mine)) return;
    if (this.overCap()) return;
    const context = Transcript.format(this.transcript.before(line, 7).slice(0, -1));
    let v;
    if (this.hold) {
      this.counts.gateChecks++;
      v = await this.hold({ contextText: context, lastText: `${line.speaker}: ${line.text}`, bareText: line.text, asker: h.asker, question: h.meaning || h.question, cutIn: h.cutIn, ready: h.ready !== false });
    } else v = parseHold("", line.text);
    if (typeof v.dollars === "number") this.costs.claude += v.dollars;
    if (v.error) this.log.warn(`the check while she waits failed (${v.error}); the plain rule decided`);
    else if (v.cutOff) this.log.warn(`the check while she waits ran past its limit; its verdict (${v.kind}) was written before the cut and used`);
    this.log.info(`check on ${line.speaker}'s line while she waits: ${{ go: "a go-ahead", wait: "hold on", stop: "a stop", ask: v.chat ? "a question, small talk" : "a question", none: "not for her" }[v.kind] ?? v.kind}`);
    if (this.ended) return;
    /* a verdict on a watch merged into a fuller question since acts on that one */
    while (h.next) h = h.next;
    /* still watching the same question (looking it up or holding it), nothing has ended the wait yet */
    const live = this.watch === h && !h.signal;
    /* someone else's line that didn't name her (and isn't a reply she invited): it may make her wait or stop, never
       become a question of its own (review 10 of 0.1.3: table chatter judged "a question" was answered) */
    const r = this.replyTo;
    const replying = !!r && r.userId === uid && line.at >= r.from && line.at <= r.from + this.cfg.replyWindowMs;
    const named = mentionsAngel(line.text);
    if (named && uid) (h.named ??= new Set()).add(uid);
    /* (someone who named her earlier in this wait may go on without her name: "Hold on Angel, one sec." … "okay, does
       it end if I move away?") */
    if ((noAsk || (uid !== h.userId && !named && !replying && !h.named?.has(uid))) && v.kind === "ask") return;
    /* "never mind" about the held answer drops only that one: another player's question waiting behind it is still
       answered (review of 0.1.3). After the hold it is a stop like any the check reads, with the reply window kept. */
    /* a second "never mind" about an answer already dropped does nothing more (review 14 of 0.1.3: it became a global
       stop and dropped another player's waiting question) */
    /* a stop that began before the question was said is about something earlier, even if it ended after the question
       began (field test 2026-11-21: "Thank you, Angel. You're all set." for the last answer, said over the start of
       the next question, dropped it). Judged by the piece that holds the stop: a long talk begun before the question
       can still say "never mind" after it (review of the fix) */
    if (v.kind === "stop" && !(pieceAt > h.at)) { this.log.info(`${line.speaker}'s line began before the question: not a stop for it`); return; }
    if (v.kind === "stop") { if (live) h.poke("stop"); else if (h.signal !== "stop") this.stop(line.at, { keepReplyWindow: true }); return; }
    /* only the start of a question, the rest still to come ("Angel, about the grab,"): kept as a call is, so the rest
       joins it (review 12 of 0.1.3: it was asked on its own, half a question) */
    const callOnly = v.kind === "ask" && v.complete === false && !partial;
    /* the asker finishes the question and invites her in the same line ("... so can I go back to it? Now you can
       speak."): merged like more to the question, not a go-ahead for the half she holds (field test 2026-11-21) */
    const goWithMore = v.kind === "go" && v.adds === true && !partial && live && uid && uid === h.userId && h.via === "voice" && !!h.entry && !this.stoppedSince(h.at);
    /* the same when it can't be merged (a typed question held, or a merge already under way): the held answer is
       released and the added words asked after it, as an ask is, not lost (review of the fix) */
    const goThenAsk = v.kind === "go" && v.adds === true && !partial && !goWithMore && !noAsk && uid && uid === h.userId;
    if ((v.kind === "go" && !goWithMore && !goThenAsk) || callOnly) {
      if (live && !callOnly) h.poke("go");
      /* "Angel?" from someone else may be a call with their question still to come: kept, as any "Angel?" is
         (review of 0.1.3: the question said next had no name and was dropped) */
      if (uid && (callOnly || (uid !== h.userId && named)) && !this.pending.has(uid)) {
        const timer = setTimeout(() => this.pending.delete(uid), this.cfg.followUpMs);
        timer.unref?.();
        this.pending.set(uid, { text: line.text, at: this.now(), timer, byName: named, line });
      }
      return;
    }
    if (v.kind === "wait") { if (live) h.poke("wait"); return; }
    /* a long talk still going on: only a go-ahead, "hold on" or a stop counts yet; a question waits for the rest */
    if (partial || (v.kind !== "ask" && !goWithMore && !goThenAsk)) return;
    /* the asker adds to their question: one fresh answer to all of it, in this one's place (Rhea, d-7 and d-6) */
    if ((v.kind === "ask" || goWithMore) && live && uid && uid === h.userId && h.via === "voice" && h.entry && !this.stoppedSince(h.at)) {
      this.counts.questions++;
      this.counts.merged++;
      this.log.info(`${line.speaker} said more while she waited${goWithMore ? " and invited her" : ""}: answering it all as one`);
      const merged = this.withEntry(uid, {
        question: `${h.question} ${line.text}`,
        meaning: h.meaning || v.question ? `${h.meaning || h.question} ${v.question || line.text}` : "",
        asker: h.asker, role: h.role, via: "voice", at: h.at, userId: uid, until: until ?? h.until,
        chat: h.chat === true && v.chat === true, unnamed: h.unnamed === true, turn: h.turn ?? 0, noAck: true,
      });
      h.entry.replacement = merged;
      /* the held answer is dropped even if still being written, and its post taken away: one answer to all of it */
      h.entry.mergedAway = true;
      h.entry.drop();
      /* they invited her as they finished: the merged answer goes once it is ready, without waiting again for a gap
         or a go-ahead, and their invitation takes back an earlier "hold on" (review of the fix) */
      if (goWithMore) { h.mode = "gap"; h.goCarried = true; }
      h.poke("merge");
      return;
    }
    /* anyone else asking her counts as a go-ahead: the held answer first, then theirs */
    if (live) h.poke("go");
    this.ask({ question: line.text, meaning: v.question || "", asker: line.speaker, role: line.role, via: "voice", at: line.at, userId: uid, until, chat: v.chat === true, turn: 0, unnamed: false });
  }

  /* "Angel, stop": cut her off, drop questions still waiting, and don't speak an answer still being looked up.
     `at` is when the stop was said (a typed or /angel stop: now). */
  stop(at = this.now(), { keepReplyWindow = false } = {}) {
    this.lastStopAt = Math.max(this.lastStopAt, at);
    if (!keepReplyWindow) this.replyTo = null;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.voice.stopSpeaking();
    /* a stop said after the question she is holding drops its spoken answer (the written one stays) */
    if (this.watch && at > this.watch.at) this.watch.poke("stop");
  }

  status() {
    const minutes = Math.round((this.now() - this.startedAt) / 60000);
    return { minutes, lines: this.transcript.lines.length, ...this.counts, dollars: this.spent(), costs: { ...this.costs }, capped: this.capped, ...(this.listenOnly ? { listenOnly: true } : {}) };
  }

  end() {
    if (this.ended) return this.status();
    this.ended = true;
    this.replyTo = null;
    this.watch?.poke("end");
    this.lastArrived.clear();
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    clearInterval(this.hearingTimer);
    this.voice.leave();
    for (const d of this.decoders.values()) { try { d.delete(); } catch { /* freed */ } }
    this.decoders.clear();
    this.transcript.close();
    return this.status();
  }
}

/* `cost: false` leaves the money out: the line posted on a server that isn't the owner's, whose cost goes to the owner
   by direct message instead (Rhea, 2026-11-28) */
export function summaryText(s, { cost = true } = {}) {
  const money = n => `$${n.toFixed(2)}`;
  if (!cost) return `Session over: ${s.minutes} min, ${s.lines} transcript lines${s.listenOnly ? "" : `, ${s.questions} question${s.questions === 1 ? "" : "s"}`}.`;
  if (s.listenOnly) return `Session over: ${s.minutes} min, ${s.lines} transcript lines. Cost about ${money(s.dollars)} (listening).`;
  return `Session over: ${s.minutes} min, ${s.lines} transcript lines, ${s.questions} question${s.questions === 1 ? "" : "s"}. ` +
    `Cost about ${money(s.dollars)} (Claude ${money(s.costs.claude)}, listening ${money(s.costs.stt)}, voice ${money(s.costs.tts)}).`;
}
