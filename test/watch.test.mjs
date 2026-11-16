/* The watch on a question while she looks it up (0.1.3, review 13): a merge keeps the watch's state, a stopped watch
   catches nothing more, replies go the usual way, and the usual check's stop counts. Stand-ins for Discord, Deepgram
   and Claude (the review's own probes, kept as tests). */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session } from "../src/session.mjs";
import { DEFAULTS } from "../src/config.mjs";
import { tonePackets, sleep } from "./helpers.mjs";

class FakeVoice extends EventEmitter {
  constructor() { super(); this.spoken = []; this.stops = 0; this.echo = false; this.speakMs = 0; this.periods = []; }
  speak(clips) {
    this.spoken.push(...clips.map(String));
    if (!this.speakMs) return Promise.resolve();
    this.periods.push([Date.now(), null]);
    return sleep(this.speakMs * clips.length).then(() => { this.periods.at(-1)[1] = Date.now(); });
  }
  ownSpeech() { return this.periods; }
  stopSpeaking() { this.stops++; }
  inEchoWindow() { return this.echo; }
  ignore() {} leave() {}
  talk(userId, speaking, at = Date.now()) { this.emit("talking", { userId, speaking, at }); }
}
const made = [];
afterEach(() => { for (const x of made.splice(0)) { try { x.end(); } catch { /* already ended */ } } });
const FAST = { silenceMs: 0, busyBlipMs: 30, busyPauseMs: 40, busyFirstWaitMs: 400, busyGapMs: 80, busyMaxHoldMs: 1500, ackPhrase: "" };
function setup({ heard = [], hold = () => ({ kind: "none" }), cfg = {}, gate = a => ({ toAngel: true, complete: true, stop: false, question: a.bareText }) } = {}) {
  const voice = new FakeVoice();
  const posted = [], holds = [], gates = [], asked = [];
  const post = { send: async text => { const m = { text, edits: [], edit: async t => { m.edits.push(t); }, delete: async () => { m.deleted = true; } }; posted.push(m); return m; } };
  const s = new Session({
    cfg: { ...DEFAULTS, ...FAST, ...cfg }, voice, post,
    stt: async () => ({ text: heard.shift() ?? "", seconds: 1 }),
    tts: async text => [Buffer.from(`clip:${text}`)],
    gate: async a => { gates.push(a); return { dollars: 0.0001, ...gate(a) }; },
    hold: async a => { holds.push(a); return { dollars: 0.0001, ...hold(a) }; },
    readyLine: async () => ({ dollars: 0.0001, text: "Got it, whenever you're ready." }),
    answer: async q => { asked.push(q); return { say: `Answer to: ${q.question}`, sources: [], lookups: 1, dollars: 0.02 }; },
    speakerOf: id => ({ name: { p1: "Mira", p2: "Sam", gm: "Dana" }[id] ?? id, role: id === "gm" ? "GM" : "player" }),
    log: process.env.LOG ? { info: m => console.log("I", m), warn: m => console.log("W", m), error: m => console.log("E", m), debug() {} } : { info() {}, warn() {}, error() {}, debug() {} },
  });
  made.push(s);
  return { s, voice, posted, holds, gates, asked };
}
const speech = (voice, userId, at = Date.now()) => voice.emit("speech", { userId, packets: tonePackets(1), startedAt: at, final: true });
const until = async (cond, ms = 3000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timed out waiting"); await sleep(5); } };
const answers = voice => voice.spoken.filter(c => c.startsWith("clip:Answer"));
async function started(x) { await x.s.start(); if (x.s.floor) x.s.floor.pollMs = 5; return x; }
const holdOn = a => (/hold on|Hold on/i.test(a.bareText) ? { kind: "wait" } : /sorted/i.test(a.bareText) ? { kind: "stop" } : /shield/.test(a.bareText) ? { kind: "ask", question: a.bareText } : { kind: "none" });

/* P1: Sam's "Hold on Angel, one sec." while she looks Mira's question up, then Mira adds more (unnamed, merged):
   the merged question's answer must still wait for a go-ahead. */
test("(se-12) a 'hold on' said while she looks it up survives the asker's addition merging into a fresh answer", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Hold on Angel, one sec.", "Angel, and with a shield?"], hold: holdOn,
    gate: a => (/Hold on/.test(a.bareText) ? { toAngel: false, complete: true, stop: false, question: "" } : { toAngel: true, complete: true, stop: false, question: a.bareText }) }));
  let release; const later = new Promise(r => { release = r; });
  x.s.answer = async q => { x.asked.push(q); if (x.asked.length === 1) await later; return { say: `Answer to: ${q.question}`, sources: [], lookups: 1, dollars: 0.02 }; };
  speech(x.voice, "p1");
  await until(() => x.asked.length === 1);
  speech(x.voice, "p2");
  await sleep(150);
  speech(x.voice, "p1");                          /* Mira adds, named: merged into one */
  await until(() => x.s.counts.merged === 1, 3000);
  release();
  await sleep(1200);
  assert.deepEqual(answers(x.voice), [], "Sam said hold on: the merged answer must wait for a go-ahead");
});

/* P2: "Angel, stop" while she looks Mira's question up; Sam then asks his own question; Dana then says
   "we sorted it out" (read as a stop): Sam's question must still be answered. And table talk after the stop
   is not paid for. */
test("(se-12) a stopped question's watch catches nothing more: no paid checks, and no stop dropping another player's question", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Angel, stop.", "Angel, how does flanking work?", "Okay we sorted it out, moving on.", "So I move ten feet."],
    hold: a => (/flanking/.test(a.bareText) ? { kind: "ask", question: a.bareText } : /sorted/.test(a.bareText) ? { kind: /grabbed/.test(a.question) ? "stop" : "none" } : holdOn(a)) }));
  let release; const later = new Promise(r => { release = r; });
  x.s.answer = async q => { x.asked.push(q); if (x.asked.length === 1) await later; return { say: `Answer to: ${q.question}`, sources: [], lookups: 1, dollars: 0.02 }; };
  speech(x.voice, "p1");
  await until(() => x.asked.length === 1);
  speech(x.voice, "p1");
  await until(() => x.s.lastStopAt > 0);
  await sleep(20);
  speech(x.voice, "p2");                           /* Sam's own question, after the stop */
  await until(() => x.s.counts.questions === 2);
  await sleep(20);
  speech(x.voice, "gm");                           /* table talk about Mira's old question */
  speech(x.voice, "gm", Date.now() + 1);
  await sleep(200);
  const paid = x.holds.length;
  release();
  await until(() => !x.s.watch && x.asked.length >= 1, 2000);
  await x.s.answering; await sleep(100);
  console.log("P2 hold checks while the stopped question was still looked up:", paid, x.holds.map(h => h.bareText));
  assert.deepEqual(answers(x.voice), ["clip:Answer to: Angel, how does flanking work?"], "Sam's question answered");
});

/* P3: the person she just answered replies without her name while the next question is looked up */
test("(se-12) a reply to her last answer while another question is looked up goes to the usual check, as a reply", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Angel, how does flanking work?", "Nice. And does that stack with a shield?"],
    hold: () => ({ kind: "none" }),
    gate: a => ({ toAngel: true, complete: true, stop: false, question: a.bareText }) }));
  x.voice.speakMs = 100;
  let release; const later = new Promise(r => { release = r; });
  x.s.answer = async q => { x.asked.push(q); if (x.asked.length === 2) await later; return { say: `Answer to: ${q.question}`, sources: [], lookups: 1, dollars: 0.02 }; };
  speech(x.voice, "p1");
  await until(() => answers(x.voice).length === 1);
  speech(x.voice, "gm");                           /* Dana asks while Mira's answer plays */
  await until(() => x.asked.length === 2);
  await until(() => x.s.replyTo?.userId === "p1", 2000);
  speech(x.voice, "p1");                           /* Mira replies, no name, while Dana's is looked up */
  await sleep(200);
  release();
  await x.s.answering; await sleep(100);
  console.log("P3 gates:", x.gates.map(g => [g.bareText, g.replying]), "holds:", x.holds.map(h => h.bareText));
  assert.ok(x.gates.some(g => /stack/.test(g.bareText) && g.replying), "judged as a reply by the usual check");
});

/* P4: the same reply, judged "ask" by the hold check: the small-talk count (turn) is reset */
test("(se-12) small-talk replies while another question is looked up keep the three-in-a-row count", async () => {
  const x = await started(setup({ heard: ["Angel, how are you?", "Angel, what does grabbed do?", "Haha nice, what else?"],
    hold: a => ({ kind: "ask", chat: true, question: a.bareText }),
    gate: a => ({ toAngel: true, complete: true, stop: false, chat: !/grabbed/.test(a.bareText), question: a.bareText }) }));
  x.voice.speakMs = 100;
  let release; const later = new Promise(r => { release = r; });
  x.s.answer = async q => { x.asked.push(q); if (x.asked.length === 2) await later; return { say: `Answer to: ${q.question}`, sources: [], lookups: 0, dollars: 0.02 }; };
  speech(x.voice, "p1");
  await until(() => answers(x.voice).length === 1);
  speech(x.voice, "gm");
  await until(() => x.asked.length === 2);
  await until(() => x.s.replyTo?.userId === "p1", 2000);
  const turnBefore = x.s.replyTo.turn;
  speech(x.voice, "p1");
  await until(() => x.s.counts.questions === 3, 2000);
  release();
  await x.s.answering; await sleep(50);
  await sleep(200);
  console.log("P4 turn before:", turnBefore, "reply window after Mira's small-talk reply:", x.s.replyTo);
  assert.equal(x.s.replyTo?.turn, 1, "an unnamed small-talk reply counts toward the three");
});

/* P5: the asker, while she looks it up, calls it off in words only the usual check reads as a stop */
test("(se-12) the usual check's stop on a line said while she looks it up counts, without a second check", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Angel, actually we don't need that any more."],
    hold: () => ({ kind: "none" }),
    gate: a => (/any more/.test(a.bareText) ? { toAngel: false, complete: true, stop: true, question: "" } : { toAngel: true, complete: true, stop: false, question: a.bareText }) }));
  let release; const later = new Promise(r => { release = r; });
  x.s.answer = async q => { x.asked.push(q); await later; return { say: `Answer to: ${q.question}`, sources: [], lookups: 1, dollars: 0.02 }; };
  speech(x.voice, "p1");
  await until(() => x.asked.length === 1);
  speech(x.voice, "p1");
  await until(() => x.gates.length === 2);
  await sleep(50);
  release();
  await x.s.answering; await sleep(50);
  console.log("P5 holds:", x.holds.map(h => h.bareText), "spoken:", answers(x.voice));
  assert.deepEqual(answers(x.voice), [], "she was told to stop");
});

test("(se-12) a verdict still on its way when the asker's addition merges acts on the fresh answer's watch", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Hold on Angel, one sec.", "Angel, and with a shield?"], hold: holdOn }));
  const realHold = x.s.hold;
  x.s.hold = async a => { if (/Hold on/.test(a.bareText)) await sleep(400); return realHold(a); };
  let release; const later = new Promise(r => { release = r; });
  x.s.answer = async q => { x.asked.push(q); if (x.asked.length === 1) await later; return { say: `Answer to: ${q.question}`, sources: [], lookups: 1, dollars: 0.02 }; };
  speech(x.voice, "p1");
  await until(() => x.asked.length === 1);
  speech(x.voice, "p2");                          /* its check takes 0.4 s */
  await until(() => x.s.transcript.lines.length === 2);
  speech(x.voice, "p1");                          /* Mira adds, named: merged before Sam's verdict comes */
  await until(() => x.s.counts.merged === 1);
  release();
  await sleep(1200);
  assert.deepEqual(answers(x.voice), [], "Sam's late 'hold on' holds the merged answer");
  assert.equal(x.s.watch?.mode, "invite");
});

test("(se-12) someone else's stop read by the usual check drops only the watched answer, not every waiting question", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Okay, we sorted that out Angel."],
    gate: a => (/sorted/.test(a.bareText) ? { toAngel: true, complete: true, stop: true, question: "" } : { toAngel: true, complete: true, stop: false, question: a.bareText }) }));
  const realGate = x.s.gate;
  x.s.gate = async a => { await sleep(/sorted/.test(a.bareText) ? 300 : 100); return realGate(a); };
  speech(x.voice, "p1");
  speech(x.voice, "p2");                          /* said while Mira's own check runs: its check comes back during the watch */
  await until(() => x.gates.length === 2);
  await until(() => x.s.counts.questions === 1);
  await x.s.answering; await sleep(50);
  assert.deepEqual(answers(x.voice), [], "Mira's spoken answer dropped");
  assert.equal(x.s.lastStopAt, -Infinity, "no global stop");
});
