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
    VoiceConnectionStatus: { Ready: "ready", Disconnected: "disconnected", Signalling: "signalling", Connecting: "connecting" },
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
  await sleep(5);
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
  const done = v.speak([Buffer.from("a"), Buffer.from("b"), Buffer.from("c")]);
  await sleep(1);
  assert.equal(lib.player.played.length, 1);
  assert.equal(lib.resources[0].opts.inputType, "ogg/opus");
  assert.equal(v.inEchoWindow(1500), true, "speech that began while she talks");
  assert.equal(v.inEchoWindow(500), false, "speech that began before she started");
  t = 2000; lib.player.setStatus("idle");
  await sleep(1);
  assert.equal(lib.player.played.length, 2);
  t = 3000; v.stopSpeaking();
  await done;
  assert.equal(lib.player.played.length, 2, "the third clip never plays");
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
