/* Angel's place in the voice channel: joining (with Discord's required end-to-end encryption, handled by
   @discordjs/voice and @snazzah/davey), listening to each speaker separately, and speaking.
   Emits "speech" { userId, packets, startedAt, final } for each piece of speech, "talking" { userId, speaking, at }
   when a person starts or stops talking (Discord's speaking signal, for the floor), "rejoined" when she left and
   rejoined the channel because she had gone deaf, and "lost" when the connection can't be recovered. The @discordjs/voice functions come in as `lib`, so tests can stand in for Discord. */
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import * as discordVoice from "@discordjs/voice";
import { gather } from "./capture.mjs";

export class VoiceLink extends EventEmitter {
  constructor({ channel, silenceMs = 900, maxUtteranceSeconds = 30, echoGuardMs = 2500, shouldListen = () => true, isPerson = () => true, log, lib = discordVoice, now = Date.now, reconnectMs = 30000,
    deafWindowMs = 30000, deafTalkMs = 10000, deafHeardShare = 0.15, rejoinCooldownMs = 120000, maxRejoins = 3, tallyMs = 10000, rejoinPauseMs = 1000 }) {
    super();
    Object.assign(this, { channel, silenceMs, maxUtteranceSeconds, echoGuardMs, shouldListen, isPerson, log, lib, now, reconnectMs,
      deafWindowMs, deafTalkMs, deafHeardShare, rejoinCooldownMs, maxRejoins, tallyMs, rejoinPauseMs });
    this.watchdog = null;
    this.closed = false;
    this.speakingNow = false;
    this.speakingSince = 0;
    this.periods = []; /* [start, end] of the last clips Angel played */
    this.playToken = 0;
    this.queue = Promise.resolve();
    this.listeners = new Map();
    this.talkers = new Set(); /* people marked talking, so their end is passed on */
    /* for the deaf check: when the people she listens to talked, and how much of their sound came through */
    this.talkStarts = new Map();
    this.talked = [];             /* [start, end] */
    this.heard = new Map();       /* second -> packets that came through in it */
    this.listenSince = 0;         /* when she joined or rejoined: the check looks no further back */
    this.rejoins = 0;
    this.rejoining = false;
    this.tallies = new Map();     /* repeated warnings, counted instead of written one by one */
  }

  async join() {
    const { lib } = this;
    this.connection = lib.joinVoiceChannel({
      channelId: this.channel.id,
      guildId: this.channel.guild.id,
      adapterCreator: this.channel.guild.voiceAdapterCreator,
      selfDeaf: false, /* Angel has to hear */
      selfMute: false,
      /* the library tells of the voice encryption (DAVE) only through its debug messages: kept for the log below */
      debug: true,
    });
    const conn = this.connection;
    const stale = () => this.closed || this.rejoining || conn !== this.connection;
    this.connection.on("error", e => this.log.warn(`voice connection error: ${e.message}`));
    this.connection.on("debug", m => { if (!stale()) this.onDebug(m); });
    /* every step of joining goes in the log, so a join that never gets ready says where it stopped (2026-11-14: the
       first live join timed out and the log said nothing) */
    const steps = [];
    const onStep = (_old, state) => { steps.push(state.status); this.log.info(`voice: ${state.status}`); };
    this.connection.on("stateChange", onStep);
    try {
      await lib.entersState(this.connection, lib.VoiceConnectionStatus.Ready, 30000);
    } catch (e) {
      const last = steps.at(-1) ?? "signalling";
      this.log.warn(`voice join timed out after: ${steps.join(" > ") || "(no change)"}`);
      this.connection.destroy();
      throw new Error(last === lib.VoiceConnectionStatus.Connecting
        ? "Couldn't connect to the voice channel within 30 seconds: Discord answered but the voice link never opened. On the PC running Angel, allow Node.js through Windows Firewall (Private networks), then try /angel join again."
        : "Couldn't connect to the voice channel within 30 seconds. Check that Angel may Connect and Speak there.");
    } finally {
      this.connection.off("stateChange", onStep);
    }
    this.connection.on(lib.VoiceConnectionStatus.Disconnected, () => { if (!stale()) this.onDisconnected(); });
    this.connection.on(lib.VoiceConnectionStatus.Destroyed, () => { if (!stale()) { this.log.warn("voice connection destroyed"); this.emit("lost"); } });
    /* any time the connection leaves Ready it must get back within reconnectMs, or Angel would sit there deaf. The
       library reconnects most drops by going straight to Signalling, never Disconnected, so this watches every change. */
    this.connection.on("stateChange", (_old, state) => { if (!stale()) this.watch(state.status); });
    this.player = lib.createAudioPlayer({ behaviors: { noSubscriber: lib.NoSubscriberBehavior.Pause } });
    this.player.on("error", e => this.log.warn(`voice playback error: ${e.message}`));
    this.connection.subscribe(this.player);
    this.receiver = this.connection.receiver;
    this.receiver.speaking.on("start", userId => { if (stale()) return; this.talking(userId, true); this.listen(userId); });
    this.receiver.speaking.on("end", userId => { if (!stale()) this.talking(userId, false); });
    this.listenSince = this.now();
  }

  /* The voice encryption's own messages (field test of 2026-11-21: she went deaf for 13 minutes after a third person
     joined, and the log had nothing on why). Its changes of keys are written as they come; packets it couldn't
     decrypt come many a second, so they are counted. */
  onDebug(message) {
    const at = String(message).indexOf("[DAVE]");
    if (at < 0) return;
    const text = String(message).slice(at + 6).trim();
    if (/^Failed to decrypt/i.test(text)) this.tally("decrypt", `voice encryption: a packet couldn't be decrypted (${text})`, "packets that couldn't be decrypted");
    else this.log.info(`voice encryption: ${text}`);
  }

  /* the first of a kind is written at once; the rest are counted and written as one line after tallyMs */
  tally(key, first, label) {
    const t = this.tallies.get(key);
    if (t) { t.n++; return; }
    this.log.warn(first);
    const e = { n: 0, label };
    e.timer = setTimeout(() => this.flushTally(key), this.tallyMs);
    e.timer.unref?.();
    this.tallies.set(key, e);
  }

  flushTally(key) {
    const e = this.tallies.get(key);
    if (!e) return;
    clearTimeout(e.timer);
    this.tallies.delete(key);
    if (e.n) this.log.warn(`...and ${e.n} more ${e.label} in the ${Math.round(this.tallyMs / 1000)} s after`);
  }

  noteHeard(at = this.now()) {
    const s = Math.floor(at / 1000);
    this.heard.set(s, (this.heard.get(s) ?? 0) + 1);
  }

  /* Deaf: the people she listens to talked for a good while, but next to none of their sound came through. Leaving
     and joining again starts the voice encryption afresh, which is the cure whatever broke it. */
  checkDeaf(now = this.now()) {
    if (this.closed || this.rejoining) return false;
    if (this.rejoins && now - this.listenSince < this.rejoinCooldownMs) return false;
    const status = this.connection?.state?.status;
    if (status && status !== this.lib.VoiceConnectionStatus.Ready) return false; /* reconnecting: the watchdog's job */
    const since = Math.max(now - this.deafWindowMs, this.listenSince);
    this.talked = this.talked.filter(([, end]) => end >= since);
    let talked = 0;
    for (const [start, end] of this.talked) talked += Math.max(0, Math.min(end, now) - Math.max(start, since));
    if (talked < this.deafTalkMs) return false;
    let packets = 0;
    for (const [s, n] of this.heard) {
      if ((s + 1) * 1000 <= since) this.heard.delete(s);
      else packets += n;
    }
    const heardMs = packets * 20;
    if (heardMs >= talked * this.deafHeardShare) return false;
    this.log.warn(`she seems to have gone deaf: ${(talked / 1000).toFixed(1)} s of talk in the last ${Math.round((now - since) / 1000)} s, but only ${(heardMs / 1000).toFixed(1)} s of sound came through`);
    this.rejoin();
    return true;
  }

  /* leave the channel and join it again; after maxRejoins she gives up, since it isn't helping. One the owner asks for
     (`/angel rejoin`, a live check of this path: hr-19) is the same leave and join, but it isn't trouble, so it never
     counts against the rejoins her hearing may use and never gives up */
  async rejoin({ asked = false } = {}) {
    if (this.closed || this.rejoining) return;
    if (!asked && this.rejoins >= this.maxRejoins) {
      this.log.warn(`still deaf after ${this.rejoins} rejoins: giving up`);
      this.emit("lost", "deaf");
      return;
    }
    this.rejoining = true;
    if (asked) this.log.info("rejoining the voice channel (asked for with /angel rejoin)");
    else {
      this.rejoins++;
      this.log.warn(`rejoining the voice channel (${this.rejoins} of at most ${this.maxRejoins})`);
    }
    this.stopSpeaking();
    clearTimeout(this.watchdog); this.watchdog = null;
    for (const g of this.listeners.values()) g.stop();
    this.listeners.clear();
    /* nobody is talking as far as the floor knows, or the table would stay busy for good */
    const at = this.now();
    for (const userId of this.talkers) this.emit("talking", { userId, speaking: false, at });
    this.talkers.clear();
    this.talkStarts.clear();
    this.talked = [];
    this.heard.clear();
    for (const key of [...this.tallies.keys()]) this.flushTally(key);
    try { this.player?.stop(true); } catch { /* already stopped */ }
    try { this.connection?.destroy(); } catch { /* already destroyed */ }
    /* a moment for Discord to take the leave before the join */
    if (this.rejoinPauseMs > 0) await new Promise(r => setTimeout(r, this.rejoinPauseMs));
    if (this.closed) { this.rejoining = false; return; }
    try {
      await this.join();
    } catch (e) {
      this.rejoining = false;
      if (this.closed) return;
      this.log.warn(`couldn't rejoin the voice channel: ${e.message}`);
      this.emit("lost");
      return;
    }
    this.rejoining = false;
    if (this.closed) { try { this.connection?.destroy(); } catch { /* already gone */ } return; }
    this.log.info("back in the voice channel");
    this.emit("rejoined", { count: this.rejoins, asked });
  }

  /* who is talking, for the floor: people only (another bot's sound isn't the table talking); a player who opted out
     still counts, since only the fact that they are talking is used, never what they say */
  talking(userId, speaking) {
    if (this.closed) return;
    /* decided once, when they start: an end is passed on for whoever's start was (review of 0.1.3: a member not yet
       cached counted as a person at the start and as a bot at the end, and the table stayed busy for good) */
    if (speaking) {
      try { if (!this.isPerson(userId)) return; } catch { return; }
      this.talkers.add(userId);
    } else if (!this.talkers.delete(userId)) return;
    const at = this.now();
    this.emit("talking", { userId, speaking, at });
    /* only people she listens to count for the deaf check: an opted-out player's sound never comes */
    if (speaking) {
      let heard = false;
      try { heard = this.shouldListen(userId); } catch { /* not counted */ }
      if (heard) this.talkStarts.set(userId, at);
    } else if (this.talkStarts.has(userId)) {
      this.talked.push([this.talkStarts.get(userId), at]);
      this.talkStarts.delete(userId);
      this.checkDeaf(at);
    }
  }

  /* her own speech, for the floor: the clips she played lately and the one playing now ([start, null]) */
  ownSpeech() {
    return this.speakingNow ? [...this.periods, [this.speakingSince, null]] : this.periods;
  }

  /* Subscribe to one speaker until they pause; then again when they next speak. */
  listen(userId) {
    if (this.closed || !this.receiver || this.receiver.subscriptions.has(userId) || !this.shouldListen(userId)) return;
    const stream = this.receiver.subscribe(userId, { end: { behavior: this.lib.EndBehaviorType.AfterSilence, duration: this.silenceMs } });
    const g = gather(stream, {
      maxPackets: Math.max(1, Math.round(this.maxUtteranceSeconds * 50)),
      onSegment: seg => this.emit("speech", { userId, ...seg }),
      onBroken: err => this.tally("broken", `audio from ${userId} broke off: ${err.message}`, "pieces of audio that broke off"),
      onClosed: () => {
        this.listeners.delete(userId);
        /* they started again in the moment the old stream was closing: listen again so nothing is lost */
        setImmediate(() => { if (this.receiver?.speaking.users.has(userId)) this.listen(userId); });
      },
    });
    stream.on("data", () => this.noteHeard());
    this.listeners.set(userId, g);
  }

  /* Stop listening to someone at once (opt-out). */
  ignore(userId) {
    this.listeners.get(userId)?.stop();
    this.listeners.delete(userId);
  }

  watch(status) {
    const { VoiceConnectionStatus: S } = this.lib;
    if (this.closed || status === S.Destroyed) return;
    if (status === S.Ready) { clearTimeout(this.watchdog); this.watchdog = null; return; }
    if (this.watchdog) return;
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (!this.closed && this.connection?.state?.status !== S.Ready) { this.log.warn("the voice connection didn't come back"); this.emit("lost"); }
    }, this.reconnectMs);
    this.watchdog.unref?.();
  }

  /* Disconnected (kicked, moved, or Discord closed the call): a reconnect starts within 5 s, or it never will. An
     "error" event during the wait rejects it too: that is left to the watchdog, which knows whether it came back. */
  async onDisconnected() {
    const { lib } = this;
    try {
      await Promise.race([
        lib.entersState(this.connection, lib.VoiceConnectionStatus.Signalling, 5000),
        lib.entersState(this.connection, lib.VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch (e) {
      const timedOut = e?.name === "AbortError" || e?.code === "ABORT_ERR";
      if (timedOut && !this.closed) { this.log.warn("voice connection lost"); this.emit("lost"); }
    }
  }

  /* Did speech that began at `at` start while Angel was talking, or just after? Her voice can come back through a
     player's microphone. Judged by when the speech began, not when its text arrived, so a quick follow-up question
     after she finishes still counts. */
  inEchoWindow(at = this.now()) {
    if (this.speakingNow && at >= this.speakingSince) return true;
    return this.periods.some(([start, end]) => at >= start && at <= end + this.echoGuardMs);
  }

  /* Play Ogg Opus clips one after another; queued behind anything already playing. Resolves when done or stopped. */
  speak(clips, { onStart = null } = {}) {
    const token = this.playToken;
    this.queue = this.queue.then(() => this.playClips(clips, token, onStart)).catch(e => this.log.warn(`speaking failed: ${e.message}`));
    return this.queue;
  }

  /* onStart is called once, as the first of these clips starts to play (not when it was queued) */
  async playClips(clips, token, onStart = null) {
    if (!this.player) return;
    for (const clip of clips) {
      if (this.closed || token !== this.playToken) return;
      if (onStart) { try { onStart(); } catch { /* the caller's note, not the voice's trouble */ } onStart = null; }
      this.speakingNow = true;
      this.speakingSince = this.now();
      const resource = this.lib.createAudioResource(Readable.from([clip]), { inputType: this.lib.StreamType.OggOpus });
      const idle = this.waitIdle();
      this.player.play(resource);
      await idle;
      this.endPeriod();
    }
  }

  endPeriod() {
    if (!this.speakingNow) return;
    this.speakingNow = false;
    this.periods.push([this.speakingSince, this.now()]);
    if (this.periods.length > 20) this.periods.shift();
  }

  waitIdle(maxMs = 5 * 60000) {
    return new Promise(resolve => {
      let started = false;
      const timer = setTimeout(done, maxMs);
      const player = this.player;
      function done() { clearTimeout(timer); player.off("stateChange", on); resolve(); }
      function on(_old, state) {
        if (state.status !== "idle") started = true;
        else if (started) done();
      }
      player.on("stateChange", on);
    });
  }

  /* "Angel, stop": cut the current clip and drop the rest of the queue. */
  stopSpeaking() {
    this.playToken++;
    this.player?.stop(true);
    this.endPeriod();
  }

  leave() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.watchdog);
    for (const key of [...this.tallies.keys()]) this.flushTally(key);
    this.playToken++;
    for (const g of this.listeners.values()) g.stop();
    this.listeners.clear();
    try { this.player?.stop(true); } catch { /* already stopped */ }
    try { this.connection?.destroy(); } catch { /* already destroyed */ }
  }
}
