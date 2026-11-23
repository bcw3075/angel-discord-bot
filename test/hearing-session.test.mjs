/* Losing her hearing mid-session (the talk of 2026-11-22): a decoder gone bad is replaced, and when she can't hear
   she mends what she can and tells the owner at once, in writing. Stand-ins for the voice channel and the services;
   real Opus packets and the real decoder. */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session } from "../src/session.mjs";
import { createDecoder } from "../src/audio.mjs";
import { DEFAULTS } from "../src/config.mjs";
import { tonePackets, sleep } from "./helpers.mjs";

class FakeVoice extends EventEmitter {
  constructor() { super(); this.spoken = []; this.rejoins = 0; this.maxRejoins = 3; this.rejoinCalls = 0; this.rejoining = false; }
  speak(clips) { this.spoken.push(...clips); return Promise.resolve(); }
  stopSpeaking() {}
  inEchoWindow() { return false; }
  ignore() {}
  leave() {}
  shouldListen(id) { return id !== "out"; }
  async rejoin() { this.rejoinCalls++; this.rejoins++; this.emit("rejoined", { count: this.rejoins }); }
}

const made = [];
afterEach(() => { for (const x of made.splice(0)) { try { x.end(); } catch { /* already ended */ } } });

function setup({ listenOnly = true, stt = null, newDecoder = createDecoder, hearing = {}, voice = new FakeVoice(), dailyOver = () => false } = {}) {
  const clock = { t: Date.now() }, posted = [], alerts = [], warned = [];
  const s = new Session({
    cfg: { ...DEFAULTS, ackPhrase: "", hearingCheckMs: 3_600_000 }, voice, listenOnly, newDecoder, hearing, dailyOver,
    now: () => clock.t, clock: t => `T+${Math.round((t - clock.t0) / 1000)}`,
    post: { send: async text => { posted.push(text); return { edit: async () => {} }; } },
    stt: stt ?? (async () => ({ text: "the dragon lands on the tower", seconds: 1 })),
    tts: async text => [Buffer.from(`clip:${text}`)],
    gate: async () => ({ toAngel: false, dollars: 0 }),
    answer: async () => ({ say: "", sources: [], dollars: 0 }),
    speakerOf: () => ({ name: "Mira", role: "player" }),
    alert: async text => { alerts.push(text); },
    log: { info() {}, warn: m => warned.push(m), error() {}, debug() {} },
  });
  clock.t0 = clock.t;
  voice.on("rejoined", () => { s.rejoined().catch(() => {}); });
  made.push(s);
  return { s, voice, posted, alerts, warned, clock };
}

const speech = (voice, userId, packets = tonePackets(1)) => voice.emit("speech", { userId, packets, startedAt: Date.now(), final: true });
const settle = async () => { for (let i = 0; i < 12; i++) await sleep(5); };
/* a decoder that fails as the shared one did on 2026-11-22 */
const dead = () => ({ decode() { throw new Error("memory access out of bounds"); }, delete() {} });
const garbage = n => Array.from({ length: n }, () => Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]));

test("(hr-7) six speakers in one session are all written down (the third used to end her hearing for good)", async () => {
  const x = setup();
  await x.s.start();
  for (let round = 0; round < 3; round++) for (const id of ["a", "b", "c", "d", "e", "f"]) { speech(x.voice, id); await settle(); }
  assert.equal(x.s.transcript.lines.length, 18);
  assert.equal(x.s.counts.skipped, 0);
  assert.deepEqual(x.alerts, []);
});

test("(hr-8) a decoder gone bad costs nothing: the piece is decoded by a fresh one and written down, nobody is alarmed", async () => {
  let n = 0;
  const x = setup({ newDecoder: () => (++n === 1 ? dead() : createDecoder()) });
  await x.s.start();
  speech(x.voice, "a"); await settle();
  assert.equal(x.s.transcript.lines.length, 1, "the piece its first decoder couldn't decode is in the transcript");
  speech(x.voice, "a"); await settle();
  assert.equal(x.s.transcript.lines.length, 2);
  assert.equal(n, 2, "the fresh decoder is kept");
  assert.deepEqual(x.alerts, []);
});

test("(hr-8) a decoder that can't even be made is tried again at the next piece", async () => {
  let n = 0;
  const x = setup({ newDecoder: () => { if (++n <= 2) throw new Error("memory access out of bounds"); return createDecoder(); } });
  await x.s.start();
  speech(x.voice, "a"); await settle();
  assert.equal(x.s.transcript.lines.length, 0);
  assert.equal(x.s.counts.skipped, 1);
  speech(x.voice, "a"); await settle();
  assert.equal(x.s.transcript.lines.length, 1);
});

test("(hr-9) she can't decode anyone: after three pieces the owner is told at once, every decoder is dropped and she rejoins; when sound decodes again the owner is told that too", async () => {
  let broken = true, makes = 0;
  const x = setup({ newDecoder: () => { makes++; return broken ? dead() : createDecoder(); } });
  await x.s.start();
  speech(x.voice, "a"); await settle(); speech(x.voice, "b"); await settle();
  assert.deepEqual(x.alerts, [], "two lost pieces: not yet");
  speech(x.voice, "a"); await settle();
  assert.equal(x.alerts.length, 1);
  assert.match(x.alerts[0], /^⚠️ I've stopped hearing the table in \{where\}: since T\+0 the sound reaches me but I can't make it out\. I'm starting my hearing afresh and rejoining the voice channel/);
  assert.equal(x.voice.rejoinCalls, 1);
  assert.equal(x.s.decoders.size, 0, "no decoder is kept");
  assert.match(x.posted.at(-1), /rejoined the voice channel/, "the table's thread has the usual note");
  for (let i = 0; i < 10; i++) { speech(x.voice, "b"); await settle(); }
  assert.equal(x.alerts.length, 1, "one message, not one a piece");
  assert.equal(x.voice.rejoinCalls, 1);
  /* two minutes on with nobody talking: nothing is being missed, so nothing more is said */
  x.clock.t += 121_000; x.s.hearingTick(); await settle();
  assert.equal(x.alerts.length, 1);
  /* half a minute of talk, still nothing decoded */
  x.voice.emit("talking", { userId: "b", speaking: true, at: x.clock.t }); x.clock.t += 30_000;
  x.voice.emit("talking", { userId: "b", speaking: false, at: x.clock.t });
  x.s.hearingTick(); await settle();
  assert.equal(x.alerts.length, 2);
  assert.match(x.alerts[1], /still not hearing the table in \{where\}.*\/angel leave.*\/angel join.*start me again/s);
  broken = false;
  x.clock.t += 5000;
  speech(x.voice, "b"); await settle();
  assert.equal(x.s.transcript.lines.length, 1);
  assert.equal(x.alerts.length, 3);
  assert.match(x.alerts[2], /^✅ I can hear the table in \{where\} again\. Nothing was written down between T\+0 and T\+156\./);
  assert.equal(x.s.counts.skipped, 13);
});

test("(hr-9) packets the decoder rejects (not a throw): more than half bad is a lost piece too, a few bad ones are not", async () => {
  const x = setup();
  await x.s.start();
  const some = tonePackets(1); some.splice(10, 5, ...garbage(5));
  speech(x.voice, "a", some); await settle();
  assert.equal(x.s.transcript.lines.length, 1, "five bad packets in fifty: silence in their place, the piece is kept");
  for (let i = 0; i < 3; i++) { speech(x.voice, "a", garbage(50)); await settle(); }
  assert.equal(x.s.transcript.lines.length, 1);
  assert.equal(x.alerts.length, 1);
  assert.match(x.alerts[0], /stopped hearing the table/);
});

test("(hr-10) the transcriber failing three times running: the owner is told why, no rejoin; told again when it answers", async () => {
  let fail = true;
  const x = setup({ stt: async () => { if (fail) throw new Error("The operation was aborted due to timeout"); return { text: "we open the door", seconds: 1 }; } });
  await x.s.start();
  for (let i = 0; i < 3; i++) { speech(x.voice, "a"); await settle(); }
  assert.equal(x.alerts.length, 1);
  assert.match(x.alerts[0], /can't get the talk in \{where\} written down: since T\+0 the transcriber hasn't answered \(The operation was aborted due to timeout\)/);
  assert.equal(x.voice.rejoinCalls, 0, "rejoining can't mend the transcriber");
  fail = false;
  speech(x.voice, "a"); await settle();
  assert.match(x.alerts[1], /^✅ I can hear the table/);
  assert.equal(x.s.transcript.lines.length, 1);
});

test("(hr-10) one transcriber timeout among good pieces alarms nobody", async () => {
  let n = 0;
  const x = setup({ stt: async () => { if (++n % 3 === 0) throw new Error("timeout"); return { text: "fine", seconds: 1 }; } });
  await x.s.start();
  for (let i = 0; i < 12; i++) { speech(x.voice, "a"); await settle(); }
  assert.deepEqual(x.alerts, []);
});

test("(hr-11) the net: people talk for minutes and no word comes (every piece too quiet to send): the owner is told, with one rejoin a session for it", async () => {
  const x = setup();
  await x.s.start();
  const t0 = x.clock.t;
  x.voice.emit("talking", { userId: "out", speaking: true, at: t0 }); /* opted out: her words never come, so not counted */
  x.clock.t += 200_000; x.s.hearing.tick();
  assert.deepEqual(x.alerts, []);
  x.voice.emit("talking", { userId: "a", speaking: true, at: x.clock.t });
  for (let i = 0; i < 5; i++) { speech(x.voice, "a", tonePackets(1, { amp: 0 })); await settle(); } /* silence where speech should be */
  x.clock.t += 61_000;
  x.voice.emit("talking", { userId: "a", speaking: false, at: x.clock.t });
  x.s.hearing.tick(); await settle();
  assert.equal(x.alerts.length, 1);
  assert.match(x.alerts[0], /People seem to be talking in \{where\}, but I haven't caught a single word since T\+0\. I'm starting my hearing afresh and rejoining/);
  assert.equal(x.voice.rejoinCalls, 1);
  speech(x.voice, "a"); await settle();
  assert.match(x.alerts[1], /^✅/);
  /* again later: told again, but no second rejoin for talk without words (it may be an open microphone) */
  x.voice.emit("talking", { userId: "a", speaking: true, at: x.clock.t });
  x.clock.t += 181_000; x.s.hearing.tick(); await settle();
  assert.equal(x.alerts.length, 3);
  assert.match(x.alerts[2], /I've started my hearing afresh;/);
  assert.equal(x.voice.rejoinCalls, 1);
});

test("(hr-12) the voice link's last rejoin is left for its own deaf check: she never asks for it", async () => {
  const voice = new FakeVoice(); voice.rejoins = 2;
  const x = setup({ voice, newDecoder: dead });
  await x.s.start();
  for (let i = 0; i < 3; i++) { speech(x.voice, "a"); await settle(); }
  assert.equal(x.alerts.length, 1);
  assert.equal(voice.rejoinCalls, 0);
  assert.match(x.alerts[0], /I've started my hearing afresh;/);
});

test("(hr-13) the voice link's own rejoin (no sound at all) is told to the owner too", async () => {
  const x = setup();
  await x.s.start();
  await x.voice.rejoin(); await settle();
  assert.equal(x.alerts.length, 1);
  assert.match(x.alerts[0], /My hearing dropped out in \{where\}, so I left the voice channel and joined again/);
});

test("(hr-13) a rejoin she asked for isn't told twice, nor one the voice link had already begun as her trouble started", async () => {
  const x = setup({ newDecoder: dead });
  await x.s.start();
  for (let i = 0; i < 3; i++) { speech(x.voice, "a"); await settle(); }
  assert.equal(x.voice.rejoinCalls, 1);
  assert.equal(x.alerts.length, 1, "her warning, and no 'my hearing dropped out' for her own rejoin");
  assert.ok(!x.alerts.some(a => /dropped out/.test(a)));
  /* the same with the voice link's own rejoin already under way: she doesn't ask for another, and its note isn't a second message */
  const voice = new FakeVoice(); voice.rejoining = true;
  const y = setup({ voice, newDecoder: dead });
  await y.s.start();
  for (let i = 0; i < 3; i++) { speech(y.voice, "a"); await settle(); }
  assert.equal(voice.rejoinCalls, 0);
  assert.match(y.alerts[0], /rejoining the voice channel/);
  voice.rejoining = false; voice.rejoins++; voice.emit("rejoined", { count: 1 }); await settle();
  assert.equal(y.alerts.length, 1);
  /* a later rejoin by the voice link is told again */
  voice.emit("rejoined", { count: 2 }); await settle();
  assert.equal(y.alerts.length, 2);
  assert.match(y.alerts[1], /dropped out/);
});

test("(hr-16) past a spending cap she has stopped listening on purpose: talk without words is no trouble, no rejoin, no warning", async () => {
  let over = false;
  const x = setup({ dailyOver: () => over });
  await x.s.start();
  speech(x.voice, "a"); await settle();
  over = true;
  x.voice.emit("talking", { userId: "a", speaking: true, at: x.clock.t });
  for (let i = 0; i < 4; i++) { speech(x.voice, "a"); await settle(); }
  for (let i = 0; i < 30; i++) { x.clock.t += 60_000; x.s.hearingTick(); }
  await settle();
  assert.deepEqual(x.alerts, []);
  assert.equal(x.voice.rejoinCalls, 0);
  assert.equal(x.s.transcript.lines.length, 1);
});

test("(hr-16) a cap reached with nobody's piece after it (the day's cap, crossed at another table): the watch rests, the cap is said once", async () => {
  let over = false;
  const x = setup({ dailyOver: () => over });
  await x.s.start();
  over = true;
  x.voice.emit("talking", { userId: "a", speaking: true, at: x.clock.t });
  for (let i = 0; i < 30; i++) { x.clock.t += 60_000; x.s.hearingTick(); }
  await settle();
  assert.equal(x.s.hearing.trouble, null, "no trouble is even begun");
  assert.deepEqual(x.alerts, []);
  assert.equal(x.posted.filter(t => /spending cap/.test(t)).length, 1);
});

test("(hr-10) transcriber trouble that lasts: the second message doesn't send the owner to leave and join, which can't mend it", async () => {
  const x = setup({ stt: async () => { throw new Error("fetch failed"); } });
  await x.s.start();
  for (let i = 0; i < 3; i++) { speech(x.voice, "a"); await settle(); }
  x.clock.t += 121_000; x.s.hearingTick(); await settle();
  assert.equal(x.alerts.length, 2);
  assert.match(x.alerts[1], /still can't get the talk in \{where\} written down.*Leaving and rejoining won't mend that.*Deepgram/s);
});

test("(hr-9) lost pieces with pieces too quiet to send between them (which decoded fine) are not three in a row", async () => {
  let n = 0;
  const x = setup({ newDecoder: () => (++n, createDecoder()) });
  await x.s.start();
  for (let i = 0; i < 4; i++) { speech(x.voice, "a", garbage(50)); await settle(); speech(x.voice, "a", tonePackets(1, { amp: 0 })); await settle(); }
  assert.deepEqual(x.alerts, []);
});

test("(hr-14) where she answers, the same: a lost run is told in writing, never aloud", async () => {
  const x = setup({ listenOnly: false, newDecoder: dead });
  await x.s.start();
  for (let i = 0; i < 3; i++) { speech(x.voice, "a"); await settle(); }
  assert.equal(x.alerts.length, 1);
  await settle();
  /* aloud there is only the usual "I'm back" of a rejoin, which the answering table has had since 0.1.3 */
  assert.deepEqual(x.voice.spoken.map(String), ["clip:Sorry, I lost you for a second. I'm back."]);
});

test("(hr-15) nothing is told after the session ends, and a failing alert breaks nothing", async () => {
  const x = setup({ newDecoder: dead });
  x.s.alert = async () => { throw new Error("Cannot send messages to this user"); };
  await x.s.start();
  for (let i = 0; i < 3; i++) { speech(x.voice, "a"); await settle(); }
  assert.ok(x.warned.some(m => /couldn't tell the owner: Cannot send messages to this user/.test(m)));
  x.s.end();
  x.clock.t += 900_000; x.s.hearing.tick(); await settle();
  assert.equal(x.warned.filter(m => /^to the owner/.test(m)).length, 1);
});

/* /angel rejoin (hr-19's way to make a rejoin happen live): a voice link whose rejoin passes on what it was asked */
class AskVoice extends FakeVoice {
  async rejoin(o = {}) { this.rejoinCalls++; this.asks = [...(this.asks ?? []), o]; if (!o.asked) this.rejoins++; this.emit("rejoined", { count: this.rejoins, asked: !!o.asked }); }
}
function askSetup(o = {}) {
  const voice = new AskVoice();
  const x = setup({ voice, ...o });
  voice.removeAllListeners("rejoined");
  voice.on("rejoined", e => { x.s.rejoined(e).catch(() => {}); });
  return x;
}

test("(hr-21) a rejoin the owner asks for: the real rejoin, asked; the thread is told; no warning to the owner and nothing aloud, even at an answering table", async () => {
  for (const listenOnly of [true, false]) {
    const x = askSetup({ listenOnly });
    await x.s.start();
    x.posted.length = 0;
    assert.equal(x.s.rejoinOnPurpose(), "rejoining");
    await settle();
    assert.deepEqual(x.voice.asks, [{ asked: true }]);
    assert.equal(x.posted.length, 1);
    assert.match(x.posted[0], /I left and rejoined the voice channel, as asked with `\/angel rejoin`/);
    assert.deepEqual(x.alerts, [], "nothing went wrong: no warning");
    assert.deepEqual(x.voice.spoken, [], "nothing aloud");
    /* she still hears afterwards */
    speech(x.voice, "a"); await settle();
    assert.equal(x.s.transcript.lines.length, 1);
  }
});

test("(hr-21) /angel rejoin while a rejoin is under way, or after the session ended, does nothing; her own hearing rejoins are still told afterwards", async () => {
  const x = askSetup();
  await x.s.start();
  x.voice.rejoining = true;
  assert.equal(x.s.rejoinOnPurpose(), "busy");
  x.voice.rejoining = false;
  x.s.mending = true;
  assert.equal(x.s.rejoinOnPurpose(), "busy", "not while she mends her hearing");
  x.s.mending = false;
  await settle();
  assert.equal(x.voice.rejoinCalls, 0);
  /* an asked rejoin, then the voice link's own: that one is still a warning */
  x.s.rejoinOnPurpose(); await settle();
  await x.voice.rejoin(); await settle();
  assert.equal(x.alerts.length, 1);
  assert.match(x.alerts[0], /My hearing dropped out in \{where\}/);
  x.s.end();
  assert.equal(x.s.rejoinOnPurpose(), "ended");
  await settle();
  assert.equal(x.voice.rejoinCalls, 2);
});

test("(hr-21) trouble that comes while an asked rejoin is under way takes it as its mend, and later rejoins are told as before", async () => {
  const x = askSetup({ newDecoder: dead });
  await x.s.start();
  x.voice.rejoining = true; /* the asked rejoin is under way */
  for (let i = 0; i < 3; i++) { speech(x.voice, "a"); await settle(); }
  assert.equal(x.voice.rejoinCalls, 0, "no second rejoin");
  assert.equal(x.alerts.length, 1);
  assert.equal(x.s.mending, true);
  x.voice.rejoining = false; x.voice.emit("rejoined", { count: 0, asked: true }); await settle();
  assert.equal(x.s.mending, false, "cleared, or the voice link's next rejoin would never be told");
  x.voice.rejoins++; x.voice.emit("rejoined", { count: 1, asked: false }); await settle();
  assert.match(x.alerts.at(-1), /dropped out/);
});

test("(hr-22) four people talking over each other where she only listens: every piece written down in the order it was said, though transcribed out of order; nobody alarmed", async () => {
  /* the transcriber answers the later pieces first (as Deepgram can), and every speaker's pieces overlap */
  let n = 0;
  const x = setup({ stt: async () => { const k = ++n; await sleep(40 - (k % 4) * 10); return { text: `line ${k}`, seconds: 1 }; } });
  await x.s.start();
  const base = Date.now(), ids = ["a", "b", "c", "d"];
  const tone = tonePackets(1);
  const sent = [];
  for (let round = 0; round < 10; round++) {
    for (const [k, id] of ids.entries()) {
      const startedAt = base + round * 4000 + k * 700; /* each starts before the one before has stopped */
      sent.push(startedAt);
      x.voice.emit("speech", { userId: id, packets: tone, startedAt, final: true });
    }
    await sleep(5);
  }
  for (let i = 0; i < 40 && x.s.transcript.lines.length < 40; i++) await sleep(10);
  assert.equal(x.s.transcript.lines.length, 40, "every piece of all four");
  assert.deepEqual(x.s.transcript.lines.map(l => l.at), [...sent].sort((p, q) => p - q), "in the order it was said");
  assert.deepEqual(new Set(x.s.transcript.lines.map(l => l.userId)), new Set(ids));
  assert.equal(x.s.counts.skipped, 0);
  assert.equal(x.s.decoders.size, 4, "one decoder each");
  assert.deepEqual(x.alerts, []);
  assert.deepEqual(x.voice.spoken, []);
});

test("(hr-22) a long session: eight people, 400 pieces, people leaving and new ones coming, and every piece still decoded", async () => {
  const x = setup();
  await x.s.start();
  const tone = tonePackets(0.4);
  for (let k = 0; k < 400; k++) {
    /* eight at a time, the group changing every 50 pieces (12 different people in all) */
    const id = `p${(k % 8) + Math.floor(k / 100)}`;
    x.voice.emit("speech", { userId: id, packets: tone, startedAt: Date.now() + k, final: true });
    if (k % 20 === 19) await settle();
  }
  for (let i = 0; i < 50 && x.s.transcript.lines.length < 400; i++) await sleep(10);
  assert.equal(x.s.transcript.lines.length, 400);
  assert.equal(x.s.counts.skipped, 0);
  assert.deepEqual(x.alerts, []);
});
