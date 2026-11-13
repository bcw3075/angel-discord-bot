/* Angel's place in the voice channel: joining (with Discord's required end-to-end encryption, handled by
   @discordjs/voice and @snazzah/davey), listening to each speaker separately, and speaking.
   Emits "speech" { userId, packets, startedAt, final } for each piece of speech, and "lost" when the connection
   can't be recovered. The @discordjs/voice functions come in as `lib`, so tests can stand in for Discord. */
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import * as discordVoice from "@discordjs/voice";
import { gather } from "./capture.mjs";

export class VoiceLink extends EventEmitter {
  constructor({ channel, silenceMs = 900, maxUtteranceSeconds = 30, echoGuardMs = 2500, shouldListen = () => true, log, lib = discordVoice, now = Date.now }) {
    super();
    Object.assign(this, { channel, silenceMs, maxUtteranceSeconds, echoGuardMs, shouldListen, log, lib, now });
    this.closed = false;
    this.speakingNow = false;
    this.speakingSince = 0;
    this.periods = []; /* [start, end] of the last clips Angel played */
    this.playToken = 0;
    this.queue = Promise.resolve();
    this.listeners = new Map();
  }

  async join() {
    const { lib } = this;
    this.connection = lib.joinVoiceChannel({
      channelId: this.channel.id,
      guildId: this.channel.guild.id,
      adapterCreator: this.channel.guild.voiceAdapterCreator,
      selfDeaf: false, /* Angel has to hear */
      selfMute: false,
    });
    this.connection.on("error", e => this.log.warn(`voice connection error: ${e.message}`));
    try {
      await lib.entersState(this.connection, lib.VoiceConnectionStatus.Ready, 30000);
    } catch (e) {
      this.connection.destroy();
      throw new Error("Couldn't connect to the voice channel within 30 seconds. Check that Angel may Connect and Speak there.");
    }
    this.connection.on(lib.VoiceConnectionStatus.Disconnected, () => this.onDisconnected());
    this.player = lib.createAudioPlayer({ behaviors: { noSubscriber: lib.NoSubscriberBehavior.Pause } });
    this.player.on("error", e => this.log.warn(`voice playback error: ${e.message}`));
    this.connection.subscribe(this.player);
    this.receiver = this.connection.receiver;
    this.receiver.speaking.on("start", userId => this.listen(userId));
  }

  /* Subscribe to one speaker until they pause; then again when they next speak. */
  listen(userId) {
    if (this.closed || !this.receiver || this.receiver.subscriptions.has(userId) || !this.shouldListen(userId)) return;
    const stream = this.receiver.subscribe(userId, { end: { behavior: this.lib.EndBehaviorType.AfterSilence, duration: this.silenceMs } });
    const g = gather(stream, {
      maxPackets: Math.max(1, Math.round(this.maxUtteranceSeconds * 50)),
      onSegment: seg => this.emit("speech", { userId, ...seg }),
      onBroken: err => this.log.debug(`audio from ${userId} broke off: ${err.message}`),
      onClosed: () => {
        this.listeners.delete(userId);
        /* they started again in the moment the old stream was closing: listen again so nothing is lost */
        setImmediate(() => { if (this.receiver?.speaking.users.has(userId)) this.listen(userId); });
      },
    });
    this.listeners.set(userId, g);
  }

  /* Stop listening to someone at once (opt-out). */
  ignore(userId) {
    this.listeners.get(userId)?.stop();
    this.listeners.delete(userId);
  }

  async onDisconnected() {
    const { lib } = this;
    try {
      await Promise.race([
        lib.entersState(this.connection, lib.VoiceConnectionStatus.Signalling, 5000),
        lib.entersState(this.connection, lib.VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch {
      if (!this.closed) { this.log.warn("voice connection lost"); this.emit("lost"); }
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
  speak(clips) {
    const token = this.playToken;
    this.queue = this.queue.then(() => this.playClips(clips, token)).catch(e => this.log.warn(`speaking failed: ${e.message}`));
    return this.queue;
  }

  async playClips(clips, token) {
    if (!this.player) return;
    for (const clip of clips) {
      if (this.closed || token !== this.playToken) return;
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
    this.playToken++;
    for (const g of this.listeners.values()) g.stop();
    this.listeners.clear();
    try { this.player?.stop(true); } catch { /* already stopped */ }
    try { this.connection?.destroy(); } catch { /* already destroyed */ }
  }
}
