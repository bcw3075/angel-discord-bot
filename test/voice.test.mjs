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

/* field test of 2026-11-21: she went deaf for 13 minutes after a third person joined (the voice encryption, most
   likely). A lib whose every join makes a fresh connection, as the real one does after a destroy. */
function rejoinLib({ failJoinAfter = Infinity } = {}) {
  const base = fakeLib();
  const lib = { ...base, connections: [], joins: 0 };
  lib.joinVoiceChannel = opts => {
    lib.joins++;
    lib.joined = opts;
    const speaking = Object.assign(new EventEmitter(), { users: new Map() });
    const receiver = {
      speaking, subscriptions: new Map(), subscribed: [],
      subscribe(id) { const s = new FakeStream(); this.subscriptions.set(id, s); this.subscribed.push(id); s.once("close", () => this.subscriptions.delete(id)); return s; },
    };
    const c = Object.assign(new EventEmitter(), { receiver, destroyed: false, subscribe() {}, destroy() { this.destroyed = true; this.emit("destroyed"); } });
    lib.connections.push(c);
    lib.connection = c; lib.receiver = receiver;
    return c;
  };
  lib.entersState = async c => { if (lib.joins > failJoinAfter) throw new Error("timed out"); return c; };
  return lib;
}
const logOf = () => { const lines = []; return { lines, info: m => lines.push(["info", m]), warn: m => lines.push(["warn", m]), error() {}, debug() {} }; };

/* someone talks from `from` for `ms`, with `packets` of their sound coming through */
function talk(lib, clock, uid, ms, packets) {
  lib.receiver.speaking.emit("start", uid);
  const s = lib.receiver.subscriptions.get(uid);
  for (let i = 0; i < packets; i++) { clock.t += Math.floor(ms / Math.max(packets, 1)); s?.emit("data", Buffer.from([1])); }
  clock.t += ms - Math.floor(ms / Math.max(packets, 1)) * packets;
  lib.receiver.speaking.emit("end", uid);
  s?.end();
}

test("deaf: talk keeps coming but almost no sound does, so she rejoins once, tells of it, and the floor is cleared", async () => {
  const lib = rejoinLib();
  const clock = { t: 100000 };
  const log = logOf();
  const v = new VoiceLink({ channel, lib, log, now: () => clock.t, rejoinPauseMs: 0 });
  await v.join();
  assert.equal(lib.joined.debug, true, "the library's debug messages are asked for");
  const events = [];
  v.on("rejoined", e => events.push(["rejoined", e.count]));
  v.on("lost", () => events.push(["lost"]));
  v.on("talking", e => events.push(["talking", e.userId, e.speaking]));
  /* healthy first: 12 s of talk with all its sound */
  talk(lib, clock, "u1", 6000, 300);
  talk(lib, clock, "u2", 6000, 300);
  assert.equal(lib.joins, 1, "sound that comes through is not deaf");
  clock.t += 31000;
  /* then deaf: 12 s of talk, 10 packets (0.2 s) of sound */
  talk(lib, clock, "u1", 5000, 5);
  assert.equal(lib.joins, 1, "not yet: under 10 s of talk");
  lib.receiver.speaking.emit("start", "u2"); /* still talking as she rejoins */
  const mark = events.length;
  talk(lib, clock, "u1", 7000, 5);
  for (let i = 0; i < 50 && !events.some(e => e[0] === "rejoined"); i++) await sleep(2);
  assert.equal(lib.joins, 2, "she rejoined");
  assert.equal(lib.connections[0].destroyed, true, "the old connection is gone");
  assert.ok(events.slice(mark).some(e => e[0] === "talking" && e[1] === "u2" && e[2] === false), "u2's talk is ended for the floor");
  assert.deepEqual(events.filter(e => e[0] !== "talking"), [["rejoined", 1]], "no 'lost' for the old connection's end");
  assert.ok(log.lines.some(([k, m]) => k === "warn" && /gone deaf: 12\.0 s of talk/.test(m)), "the log says why");
  /* the old connection's late events do nothing */
  lib.connections[0].receiver.speaking.emit("start", "u3");
  assert.equal(lib.connections[0].receiver.subscribed.includes("u3"), false);
  /* the new connection hears */
  talk(lib, clock, "u1", 2000, 100);
  assert.equal(lib.receiver.subscribed.at(-1), "u1");
  /* deaf again at once: the cool-down holds her off */
  talk(lib, clock, "u1", 12000, 2);
  await sleep(5);
  assert.equal(lib.joins, 2, "no second rejoin within the cool-down");
  v.leave();
});

test("deaf: opted-out talk doesn't count, and after maxRejoins she gives up with 'lost' (deaf)", async () => {
  const lib = rejoinLib();
  const clock = { t: 100000 };
  const v = new VoiceLink({ channel, lib, log: quiet, now: () => clock.t, shouldListen: id => id !== "out", maxRejoins: 1, rejoinCooldownMs: 1000, rejoinPauseMs: 0 });
  await v.join();
  const lost = [];
  let back = 0;
  v.on("lost", why => lost.push(why));
  v.on("rejoined", () => back++);
  talk(lib, clock, "out", 15000, 0);
  assert.equal(lib.joins, 1, "an opted-out player's sound never comes: not deaf");
  talk(lib, clock, "u1", 12000, 0);
  for (let i = 0; i < 50 && !back; i++) await sleep(2);
  assert.equal(lib.joins, 2);
  clock.t += 2000;
  talk(lib, clock, "u1", 12000, 0);
  await sleep(5);
  assert.equal(lib.joins, 2, "no third join");
  assert.deepEqual(lost, ["deaf"]);
  v.leave();
});

test("deaf: a rejoin that can't connect is 'lost'", async () => {
  const lib = rejoinLib({ failJoinAfter: 1 });
  const clock = { t: 100000 };
  const v = new VoiceLink({ channel, lib, log: quiet, now: () => clock.t, rejoinPauseMs: 0 });
  await v.join();
  const lost = [];
  v.on("lost", why => lost.push(why ?? "lost"));
  talk(lib, clock, "u1", 12000, 0);
  for (let i = 0; i < 50 && !lost.length; i++) await sleep(2);
  assert.deepEqual(lost, ["lost"]);
  v.leave();
});

test("the voice encryption's messages go to the log; undecryptable packets are counted, not written one by one", async () => {
  const lib = rejoinLib();
  const log = logOf();
  const v = new VoiceLink({ channel, lib, log, tallyMs: 30 });
  await v.join();
  const c = lib.connection;
  c.emit("debug", "[NW] [DAVE] Preparing for transition (5, v1)");
  c.emit("debug", "[NW] [WS] >> {\"op\":3}");
  for (let i = 0; i < 40; i++) c.emit("debug", "[NW] [DAVE] Failed to decrypt a packet (1 pending transition[s])");
  assert.deepEqual(log.lines.filter(([, m]) => /encryption/.test(m)).map(([k]) => k), ["info", "warn"], "one line for the transition, one for the first failure");
  assert.equal(log.lines.some(([, m]) => /op/.test(m)), false, "other debug messages are left out");
  await sleep(60);
  assert.ok(log.lines.some(([k, m]) => k === "warn" && /39 more packets that couldn't be decrypted/.test(m)));
  v.leave();
});

test("deaf: leaving while she waits to rejoin means no join and no note", async () => {
  const lib = rejoinLib();
  const clock = { t: 100000 };
  const v = new VoiceLink({ channel, lib, log: quiet, now: () => clock.t, rejoinPauseMs: 20 });
  await v.join();
  const said = [];
  v.on("rejoined", () => said.push("rejoined"));
  v.on("lost", () => said.push("lost"));
  talk(lib, clock, "u1", 12000, 0);
  v.leave();
  await sleep(40);
  assert.equal(lib.joins, 1);
  assert.deepEqual(said, []);
});
