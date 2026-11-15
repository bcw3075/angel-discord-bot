/* VoiceLink with a stand-in for @discordjs/voice, plus one test of the real library's Ogg Opus playback path. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { createAudioResource, StreamType } from "@discordjs/voice";
import { Readable } from "node:stream";
import { VoiceLink } from "../src/voice.mjs";
import { FakeStream, sleep } from "./helpers.mjs";

function fakeLib() {
  const lib = { joined: null, resources: [] };
  const speaking = Object.assign(new EventEmitter(), { users: new Map() });
  const receiver = {
    speaking, subscriptions: new Map(), subscribed: [],
    subscribe(id, opts) { const s = new FakeStream(); this.subscriptions.set(id, s); this.subscribed.push([id, opts]); s.once("close", () => this.subscriptions.delete(id)); return s; },
  };
  const connection = Object.assign(new EventEmitter(), { receiver, destroyed: false, subscribe() {}, destroy() { this.destroyed = true; } });
  const player = Object.assign(new EventEmitter(), {
    status: "idle", played: [],
    setStatus(s) { const old = { status: this.status }; this.status = s; this.emit("stateChange", old, { status: s }); },
    play(r) { this.played.push(r); this.setStatus("buffering"); this.setStatus("playing"); },
    stop() { if (this.status !== "idle") this.setStatus("idle"); },
  });
  Object.assign(lib, {
    receiver, connection, player,
    VoiceConnectionStatus: { Ready: "ready", Disconnected: "disconnected", Signalling: "signalling", Connecting: "connecting", Destroyed: "destroyed" },
    EndBehaviorType: { AfterSilence: 1 },
    NoSubscriberBehavior: { Pause: "pause" },
    StreamType: { OggOpus: "ogg/opus" },
    joinVoiceChannel(opts) { lib.joined = opts; return connection; },
    entersState: async () => connection,
    createAudioPlayer: () => player,
    createAudioResource: (stream, opts) => { const r = { stream, opts }; lib.resources.push(r); return r; },
  });
  return lib;
}
const channel = { id: "vc1", guild: { id: "g1", voiceAdapterCreator: () => ({}) } };
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

test("joining hears (not deafened) and listens to each speaker until they pause", async () => {
  const lib = fakeLib();
  const v = new VoiceLink({ channel, lib, log: quiet, silenceMs: 900, maxUtteranceSeconds: 30 });
  await v.join();
  assert.equal(lib.joined.selfDeaf, false);
  assert.equal(lib.joined.channelId, "vc1");
  const got = [];
  v.on("speech", s => got.push(s));
  lib.receiver.speaking.emit("start", "u1");
  assert.deepEqual(lib.receiver.subscribed[0], ["u1", { end: { behavior: 1, duration: 900 } }]);
  lib.receiver.speaking.emit("start", "u1");
  assert.equal(lib.receiver.subscribed.length, 1, "no second subscription while one is open");
  lib.receiver.subscriptions.get("u1").feed([Buffer.from([1]), Buffer.from([2])]);
  lib.receiver.subscriptions.get("u1").end();
  assert.equal(got.length, 1);
  assert.equal(got[0].userId, "u1");
  assert.equal(got[0].packets.length, 2);
});

test("someone who starts again as the old stream closes is listened to again", async () => {
  const lib = fakeLib();
  const v = new VoiceLink({ channel, lib, log: quiet });
  await v.join();
  lib.receiver.speaking.emit("start", "u1");
  lib.receiver.speaking.users.set("u1", Date.now());
  lib.receiver.subscriptions.get("u1").end();
  /* the new listen comes a few event-loop turns after the close (setImmediate): wait for it, not for a fixed time,
     which a busy machine can let run out first */
  for (let i = 0; i < 100 && lib.receiver.subscribed.length < 2; i++) await sleep(5);
  assert.equal(lib.receiver.subscribed.length, 2);
});

test("opted-out players and a left channel are not listened to", async () => {
  const lib = fakeLib();
  const v = new VoiceLink({ channel, lib, log: quiet, shouldListen: id => id !== "out" });
  await v.join();
  lib.receiver.speaking.emit("start", "out");
  assert.equal(lib.receiver.subscribed.length, 0);
  lib.receiver.speaking.emit("start", "u1");
  v.ignore("u1");
  assert.equal(lib.receiver.subscriptions.get("u1").destroyed, true);
  v.leave();
  assert.equal(lib.connection.destroyed, true);
  lib.receiver.speaking.emit("start", "u2");
  assert.equal(lib.receiver.subscribed.length, 1);
});

test("clips play one after another; stop cuts the rest; the echo window follows when she spoke", async () => {
  const lib = fakeLib();
  let t = 1000;
  const v = new VoiceLink({ channel, lib, log: quiet, echoGuardMs: 2500, now: () => t });
  await v.join();
  let starts = 0, never = 0;
  const done = v.speak([Buffer.from("a"), Buffer.from("b"), Buffer.from("c")], { onStart: () => starts++ });
  const dropped = v.speak([Buffer.from("d")], { onStart: () => never++ });
  assert.equal(starts, 0, "queued is not started");
  await sleep(1);
  assert.equal(starts, 1, "told when the first clip starts to play");
  assert.equal(lib.player.played.length, 1);
  assert.equal(lib.resources[0].opts.inputType, "ogg/opus");
  assert.equal(v.inEchoWindow(1500), true, "speech that began while she talks");
  assert.equal(v.inEchoWindow(500), false, "speech that began before she started");
  t = 2000; lib.player.setStatus("idle");
  await sleep(1);
  assert.equal(lib.player.played.length, 2);
  t = 3000; v.stopSpeaking();
  await done; await dropped;
  assert.equal(lib.player.played.length, 2, "the third clip never plays");
  assert.equal(starts, 1, "once, not for each clip");
  assert.equal(never, 0, "clips dropped by a stop never start");
  assert.equal(v.inEchoWindow(5400), true, "just after she stopped");
  assert.equal(v.inEchoWindow(5600), false, "well after");
  assert.equal(v.inEchoWindow(1999), true);
});

test("the real library reads an Ogg Opus clip into Opus packets for Discord (no FFmpeg)", async () => {
  const clip = fs.readFileSync(new URL("./fixtures/tone.ogg", import.meta.url));
  const res = createAudioResource(Readable.from([clip]), { inputType: StreamType.OggOpus });
  const packets = [];
  for await (const p of res.playStream) packets.push(p);
  assert.ok(packets.length > 90, `audio packets come out (${packets.length})`);
  assert.ok(packets.every(p => Buffer.isBuffer(p) && p.length > 0 && p.length < 1500));
});

test("a connection that leaves Ready and doesn't come back, or is destroyed, tells the session it's lost", async () => {
  const lib = fakeLib();
  lib.connection.state = { status: "ready" };
  const v = new VoiceLink({ channel, lib, log: quiet, reconnectMs: 20 });
  await v.join();
  let lost = 0;
  v.on("lost", () => lost++);
  const change = status => { lib.connection.state = { status }; lib.connection.emit("stateChange", {}, { status }); };
  change("signalling"); change("connecting"); change("ready");
  await sleep(40);
  assert.equal(lost, 0, "a reconnect that got back in time is fine");
  change("signalling");
  await sleep(40);
  assert.equal(lost, 1, "stuck before Ready");
  const timeout = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  lib.entersState = async () => { throw timeout; };
  await v.onDisconnected();
  assert.equal(lost, 2, "disconnected and no reconnect started");
  lib.entersState = async () => { throw new Error("socket hiccup"); };
  await v.onDisconnected();
  assert.equal(lost, 2, "an error event during the wait is left to the watchdog");
  lib.connection.emit("destroyed");
  assert.equal(lost, 3);
  v.leave();
  lib.connection.emit("destroyed");
  change("signalling");
  await sleep(40);
  assert.equal(lost, 3, "nothing after our own leave");
});

test("(vo-6) who is talking goes to the floor, people only; her own speech is given with the clip playing now", async () => {
  const lib = fakeLib();
  let t = 1000;
  const v = new VoiceLink({ channel, lib, log: quiet, now: () => t, shouldListen: id => id !== "out", isPerson: id => id !== "bot" });
  await v.join();
  const seen = [];
  v.on("talking", e => seen.push(e));
  lib.receiver.speaking.emit("start", "p1");
  lib.receiver.speaking.emit("start", "bot");
  lib.receiver.speaking.emit("start", "out");
  t = 1500;
  lib.receiver.speaking.emit("end", "p1");
  assert.deepEqual(seen, [{ userId: "p1", speaking: true, at: 1000 }, { userId: "out", speaking: true, at: 1000 }, { userId: "p1", speaking: false, at: 1500 }],
    "another bot isn't the table talking; a player who opted out still counts (nothing of theirs is heard)");
  assert.ok(!lib.receiver.subscriptions.has("out"), "and isn't listened to");
  assert.deepEqual(v.ownSpeech(), []);
  v.speak([Buffer.from("a")]);
  await sleep(1);
  assert.deepEqual(v.ownSpeech(), [[1500, null]], "the clip playing now");
  t = 2500; lib.player.setStatus("idle");
  await sleep(1);
  assert.deepEqual(v.ownSpeech(), [[1500, 2500]]);
  v.leave();
  lib.receiver.speaking.emit("start", "p1");
  assert.equal(seen.length, 3, "nothing after leaving");
});

test("(vo-6) a start that counted always gets its end, even if who is a person changes in between (review of 0.1.3)", async () => {
  const lib = fakeLib();
  let bot = false;
  const v = new VoiceLink({ channel, lib, log: quiet, isPerson: () => !bot });
  await v.join();
  const seen = [];
  v.on("talking", e => seen.push([e.userId, e.speaking]));
  lib.receiver.speaking.emit("start", "x");
  bot = true;
  lib.receiver.speaking.emit("end", "x");
  lib.receiver.speaking.emit("start", "x");
  lib.receiver.speaking.emit("end", "x");
  assert.deepEqual(seen, [["x", true], ["x", false]]);
  v.leave();
});
