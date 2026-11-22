/* Is she still hearing the table? (the talk of 2026-11-22: her decoder broke four minutes in, she stayed in the
   channel looking fine, and 85 minutes gave 8 lines; nobody knew until the transcript was read.)

   The session tells this watch what became of each piece of speech and who is talking; the watch decides when
   something is wrong and calls back, so the session can try to mend it and the owner is told at once:
   - `onTrouble({ kind, since, detail })`, once when it starts. The kinds:
       "decode"       pieces of sound arrive but can't be turned into audio, several in a row
       "transcriber"  the transcriber fails, several in a row
       "quiet"        people talk and talk, and not one word has been written down (whatever the cause: the net
                      under the other two)
   - `onStill({ kind, since, minutes })` while it lasts: after `stillMs`, then every `againMs`, at most `maxAlerts`
     messages for one trouble
   - `onBack({ kind, since, until })` when words come through again.
   No timers of its own: the session calls `tick` now and then. */

export class HearingWatch {
  constructor({ now = Date.now, failRun = 3, quietMs = 180000, quietTalkMs = 60000, stillMs = 120000, againMs = 600000, maxAlerts = 6, stillTalkMs = 20000,
    onTrouble = () => {}, onStill = () => {}, onBack = () => {} } = {}) {
    Object.assign(this, { now, failRun, quietMs, quietTalkMs, stillMs, againMs, maxAlerts, stillTalkMs, onTrouble, onStill, onBack });
    /* lost pieces in a row, counted for each kind by itself: a decode loss and a transcriber failure are two troubles */
    this.runs = { decode: { n: 0, since: 0 }, transcriber: { n: 0, since: 0 } };
    this.trouble = null;       /* { kind, since, alerts, lastAlertAt } */
    this.wordsAt = now();      /* when words were last written down (or when she began to listen) */
    this.talkMs = 0;           /* finished talk since then, of the people she listens to */
    this.talkStarts = new Map();
  }

  /* a piece was turned into audio and the transcriber answered, with words or without */
  ok() {
    this.runs.decode.n = 0;
    this.runs.transcriber.n = 0;
    if (this.trouble && this.trouble.kind !== "quiet") this.back();
  }

  /* a piece was turned into audio, loud enough to send or not: the decoder works */
  decoded() {
    this.runs.decode.n = 0;
    /* she can make sound out again: that trouble is over, even if the piece was too quiet to send */
    if (this.trouble?.kind === "decode") this.back();
  }

  /* how many pieces of this kind were lost in a row so far */
  run(kind) { return this.runs[kind]?.n ?? 0; }

  /* words were written down */
  line() {
    this.runs.decode.n = 0;
    this.runs.transcriber.n = 0;
    this.fresh();
    if (this.trouble) this.back();
  }

  /* a piece was lost: `kind` is "decode" or "transcriber" */
  bad(kind, detail = "") {
    const run = this.runs[kind];
    if (!run) return;
    if (!run.n) run.since = this.now();
    run.n++;
    if (run.n < this.failRun) return;
    if (!this.trouble) this.begin(kind, run.since, detail);
    /* trouble of another kind on top of the one already told (her decoder breaks while the transcriber is down, or
       the other way round): it is told and mended as its own, once */
    else if (this.trouble.kind !== kind && run.n === this.failRun) {
      Object.assign(this.trouble, { kind, lastAlertAt: this.now() });
      this.call(this.onTrouble, { kind, since: run.since, detail });
    }
  }

  /* someone she listens to starts or stops talking (Discord's speaking signal) */
  talking(userId, speaking, at = this.now()) {
    if (speaking) { if (!this.talkStarts.has(userId)) this.talkStarts.set(userId, at); return; }
    const start = this.talkStarts.get(userId);
    if (start == null) return;
    this.talkStarts.delete(userId);
    this.talkMs += Math.max(0, at - Math.max(start, this.wordsAt));
  }

  /* she left and joined again, or mended herself: the count of talk without words starts over */
  fresh(at = this.now()) {
    this.wordsAt = at;
    this.talkMs = 0;
    for (const id of this.talkStarts.keys()) this.talkStarts.set(id, at);
  }

  talkSinceWords(at = this.now()) {
    let ms = this.talkMs;
    for (const start of this.talkStarts.values()) ms += Math.max(0, at - Math.max(start, this.wordsAt));
    return ms;
  }

  tick(at = this.now()) {
    const t = this.trouble;
    if (t) {
      if (t.alerts >= this.maxAlerts) return;
      if (at - t.lastAlertAt < (t.alerts === 1 ? this.stillMs : this.againMs)) return;
      /* "still not hearing" needs someone to have talked since she mended herself: at a table gone quiet nothing
         is being missed (the transcriber's trouble shows only when there is talk, so it needs no such test) */
      if (t.kind !== "transcriber" && this.talkSinceWords(at) < this.stillTalkMs) return;
      t.alerts++;
      t.lastAlertAt = at;
      this.call(this.onStill, { kind: t.kind, since: t.since, minutes: Math.max(1, Math.round((at - t.since) / 60000)) });
      return;
    }
    if (at - this.wordsAt >= this.quietMs && this.talkSinceWords(at) >= this.quietTalkMs) this.begin("quiet", this.wordsAt, "");
  }

  begin(kind, since, detail) {
    const at = this.now();
    this.trouble = { kind, since, alerts: 1, lastAlertAt: at };
    this.call(this.onTrouble, { kind, since, detail });
  }

  back() {
    const t = this.trouble;
    this.trouble = null;
    this.runs.decode.n = 0;
    this.runs.transcriber.n = 0;
    this.fresh();
    this.call(this.onBack, { kind: t.kind, since: t.since, until: this.now() });
  }

  /* what the session does about it must never break the hearing itself */
  call(fn, arg) { try { fn(arg); } catch { /* the session's own trouble */ } }
}
