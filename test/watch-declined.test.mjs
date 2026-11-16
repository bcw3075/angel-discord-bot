/* A line the usual check declined, set aside before any watch began, can make her wait or stop when a watch takes it up,
   never become a question (0.1.3, review 16; the review's probe, kept as a test). Stand-ins for Discord, Deepgram and
   Claude. */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session } from "../src/session.mjs";
import { DEFAULTS } from "../src/config.mjs";
import { tonePackets, sleep } from "./helpers.mjs";
class FakeVoice extends EventEmitter {
  constructor() { super(); this.spoken = []; this.stops = 0; this.echo = false; this.speakMs = 0; this.periods = []; }
  speak(clips) { this.spoken.push(...clips.map(String)); if (!this.speakMs) return Promise.resolve(); this.periods.push([Date.now(), null]); return sleep(this.speakMs * clips.length).then(() => { this.periods.at(-1)[1] = Date.now(); }); }
  ownSpeech() { return this.periods; } stopSpeaking() { this.stops++; } inEchoWindow() { return this.echo; } ignore() {} leave() {}
}
const made = [];
const FAST = { silenceMs: 0, busyBlipMs: 30, busyPauseMs: 40, busyFirstWaitMs: 400, busyGapMs: 80, busyMaxHoldMs: 1500, ackPhrase: "" };
function setup({ heard = [], hold = () => ({ kind: "none" }), cfg = {}, gate } = {}) {
  const voice = new FakeVoice(); const posted = [], holds = [], gates = [], asked = [], logs = [];
  const post = { send: async text => { const m = { text, edits: [], edit: async t => { m.edits.push(t); }, delete: async () => { m.deleted = true; } }; posted.push(m); return m; } };
  const s = new Session({ cfg: { ...DEFAULTS, ...FAST, ...cfg }, voice, post,
    stt: async () => ({ text: heard.shift() ?? "", seconds: 1 }), tts: async text => [Buffer.from(`clip:${text}`)],
    gate: async a => { gates.push(a); return { dollars: 0.0001, ...gate(a) }; },
    hold: async a => { holds.push(a); return { dollars: 0.0001, ...hold(a) }; },
    readyLine: async () => ({ dollars: 0.0001, text: "Got it, whenever you're ready." }),
    answer: async q => { asked.push(q); return { say: `Answer to: ${q.question}`, sources: [], lookups: 1, dollars: 0.02 }; },
    speakerOf: id => ({ name: { p1: "Mira", p2: "Sam", gm: "Dana", p3: "Carol" }[id] ?? id, role: id === "gm" ? "GM" : "player" }),
    log: { info: m => logs.push(m), warn: m => logs.push("W " + m), error: m => logs.push("E " + m), debug() {} } });
  made.push(s); return { s, voice, posted, holds, gates, asked, logs };
}
const speech = (voice, userId, at = Date.now()) => voice.emit("speech", { userId, packets: tonePackets(1), startedAt: at, final: true });
const answers = voice => voice.spoken.filter(c => c.startsWith("clip:Answer"));
async function started(x) { await x.s.start(); if (x.s.floor) x.s.floor.pollMs = 5; return x; }
afterEach(() => { for (const s of made.splice(0)) { try { s.end(); } catch { /* already ended */ } } });

/* Dana's "forget it" said while Mira's check runs (so it goes the usual way); Mira's answer is ready at once on a quiet
   table and spoken (watch ends "go"); Dana's slow check comes back during Sam's lookup. Carol's question waits behind Sam's. */
const until = async (cond, ms = 3000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timed out waiting"); await sleep(5); } };
/* Like review 14's test B, but the declined reply's check comes back before Dana's question is taken up
   (Dana's own check is slower): it goes to saidSince and is handed to Dana's watch at take-up. */
test("(se-12) a reply the usual check declined before a watch began is never asked when the watch takes it up", async () => {
  const x = await started(setup({ heard: ["Angel, how are you?", "Angel, what does grabbed do when you're also prone?", "Haha nice, what else?"],
    hold: a => ({ kind: "ask", chat: true, question: a.bareText }),
    gate: a => (/what else/.test(a.bareText) ? { toAngel: false, complete: true, stop: false, question: "" } : { toAngel: true, complete: true, stop: false, chat: !/grabbed/.test(a.bareText), question: a.bareText }) }));
  x.voice.speakMs = 100;
  const realGate = x.s.gate;
  x.s.gate = async a => { await sleep(/grabbed/.test(a.bareText) ? 900 : /what else/.test(a.bareText) ? 300 : 50); return realGate(a); };
  let release; const later = new Promise(r => { release = r; });
  x.s.answer = async q => { x.asked.push(q); if (x.asked.length === 2) await later; return { say: `Answer to: ${q.question}`, sources: [], lookups: 0, dollars: 0.02 }; };
  speech(x.voice, "p1");
  await until(() => answers(x.voice).length === 1);
  await until(() => x.s.replyTo?.userId === "p1", 2000);
  speech(x.voice, "gm");
  await sleep(150);
  speech(x.voice, "p1");
  await until(() => x.asked.length === 2, 4000);
  await sleep(500);
  release();
  await x.s.answering; await sleep(300); await x.s.answering;
  console.log("gates", x.gates.map(g => [g.bareText, g.replying]), "holds", x.holds.map(h => h.bareText), "questions", x.s.counts.questions, "asked", x.asked.map(q => q.question));
  assert.equal(x.s.counts.questions, 2, "declined by the usual check: not asked");
});
