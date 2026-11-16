/* A stop said while she looks a question up belongs to the watch it was said during, and what someone adds while their
   own check runs isn't thrown away with what it declined (0.1.3, review 15; the review's probes, kept as tests).
   Stand-ins for Discord, Deepgram and Claude. */
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
function setup({ heard = [], hold = () => ({ kind: "none" }), cfg = {}, gate = a => ({ toAngel: true, complete: true, stop: false, question: a.bareText }) } = {}) {
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
const until = async (cond, ms = 3000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timed out waiting"); await sleep(5); } };
const answers = voice => voice.spoken.filter(c => c.startsWith("clip:Answer"));
async function started(x) { await x.s.start(); if (x.s.floor) x.s.floor.pollMs = 5; return x; }

afterEach(() => { for (const s of made.splice(0)) { try { s.end(); } catch { /* already ended */ } } });

/* P1: two others' stops for Mira's answer, read by the usual check (said while Mira's own check ran); the second
   check comes back only after Mira's stopped watch has ended. Sam's question (said then too) waits in line. */
for (const [label, slowMs, firstSayGapMs] of [["A: comes back between watches", 1200, 1500], ["B: comes back during Sam's watch", 1200, 0]]) {
  test(`(se-12) a stop for an answer already dropped, its check ${label.slice(3)}: no global stop, the next question kept`, async () => {
    const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Angel, how does flanking work?", "Okay, we sorted that out Angel.", "Yeah, forget it Angel."],
      gate: a => (/sorted|forget/.test(a.bareText) ? { toAngel: true, complete: true, stop: true, question: "" } : { toAngel: true, complete: true, stop: false, question: a.bareText }) }));
    const realGate = x.s.gate;
    let gStarted = 0;
    x.s.gate = async a => { gStarted++; await sleep(/sorted/.test(a.bareText) ? 300 : /forget/.test(a.bareText) ? slowMs : /flanking/.test(a.bareText) ? 150 : 100); return realGate(a); };
    let release; const later = new Promise(r => { release = r; });
    x.s.answer = async q => {
      x.asked.push(q);
      if (x.asked.length === 1) {
        await later;
        /* live-like: the first sentence is written, the rest a moment later */
        q.onSay?.("Answer to: grabbed part one. ");
        await sleep(firstSayGapMs);
        q.onSay?.("", { end: true });
      }
      return { say: `Answer to: ${q.question}`, sources: [], lookups: 1, dollars: 0.02 };
    };
    speech(x.voice, "p1");
    speech(x.voice, "p2");
    speech(x.voice, "gm");
    speech(x.voice, "p3");
    await until(() => gStarted === 4);
    await sleep(400);
    release();
    await until(() => x.gates.length === 4 && x.logs.some(l => /forget|Carol's line/.test(l)), 4000).catch(() => {});
    await sleep(2500);
    await x.s.answering; await sleep(200); await x.s.answering;
    console.log(label, "lastStopAt set?", x.s.lastStopAt > 0, "asked", x.asked.map(q => q.question), "spoken", answers(x.voice));
    console.log(x.logs.filter(l => /stop|Carol|held|watch/.test(l)).join("\n"));
    assert.equal(x.s.lastStopAt, -Infinity, "no global stop");
    assert.ok(answers(x.voice).some(c => /flanking/.test(c)), "Sam's question answered aloud");
  });
}

/* P2: Mira's question is being looked up; she says "Okay." (her usual check declines it, ~0.6 s) and, while that check
   runs, "And what if they're prone?" (kept with it, never checked on its own). */
test("(se-12) the asker's addition said while her own declined line is checked is still merged", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Ah okay, thanks Angel.", "And what if they're prone?"],
    hold: a => (/prone/.test(a.bareText) ? { kind: "ask", question: a.bareText } : { kind: "none" }),
    gate: a => (/thanks Angel/.test(a.bareText) ? { toAngel: false, complete: true, stop: false, question: "" } : { toAngel: true, complete: true, stop: false, question: a.bareText }) }));
  const realGate = x.s.gate;
  x.s.gate = async a => { await sleep(/thanks/.test(a.bareText) ? 600 : 100); return realGate(a); };
  let release; const later = new Promise(r => { release = r; });
  x.s.answer = async q => { x.asked.push(q); if (x.asked.length === 1) await later; return { say: `Answer to: ${q.question}`, sources: [], lookups: 1, dollars: 0.02 }; };
  speech(x.voice, "p1");
  await until(() => x.asked.length === 1);
  speech(x.voice, "p1");
  await sleep(200);
  speech(x.voice, "p1");
  await sleep(800);
  release();
  await x.s.answering; await sleep(200); await x.s.answering;
  console.log("gates", x.gates.map(g => g.bareText), "holds", x.holds.map(h => h.bareText), "merged", x.s.counts.merged, "asked", x.asked.map(q => q.question), "spoken", answers(x.voice));
  assert.ok(x.asked.some(q => /prone/.test(q.question)), "her addition is answered");
});

/* P2b: Dana, just answered (reply window), says "Huh." while Mira's question is looked up (the usual check, told it is
   a reply, declines it, ~0.8 s); while it runs Dana adds "Wait, does that work on a prone target too?" */
test("(se-12) a reply's addition said while its declined first part is checked is still asked", async () => {
  const x = await started(setup({ heard: ["Angel, what does stunned do?", "Angel, what does grabbed do?", "Huh.", "Wait, does that work on a prone target too?"],
    hold: a => (/prone/.test(a.bareText) ? { kind: "ask", question: a.bareText } : { kind: "none" }),
    gate: a => (/^Huh\.$/.test(a.bareText) ? { toAngel: false, complete: true, stop: false, question: "" } : { toAngel: true, complete: true, stop: false, question: a.bareText }) }));
  x.voice.speakMs = 100;
  const realGate = x.s.gate;
  x.s.gate = async a => { await sleep(/^Huh/.test(a.bareText) ? 800 : 100); return realGate(a); };
  let release; const later = new Promise(r => { release = r; });
  x.s.answer = async q => { x.asked.push(q); if (x.asked.length === 2) await later; return { say: `Answer to: ${q.question}`, sources: [], lookups: 1, dollars: 0.02 }; };
  speech(x.voice, "gm");
  await until(() => answers(x.voice).length === 1);
  speech(x.voice, "p1");
  await until(() => x.asked.length === 2);
  await until(() => x.s.replyTo?.userId === "gm", 2000);
  speech(x.voice, "gm");
  await sleep(300);
  speech(x.voice, "gm");
  await sleep(900);
  release();
  await x.s.answering; await sleep(300); await x.s.answering;
  console.log("gates", x.gates.map(g => [g.bareText, g.replying]), "holds", x.holds.map(h => h.bareText), "asked", x.asked.map(q => q.question));
  assert.ok(x.asked.some(q => /prone/.test(q.question)), "Dana's follow-up is answered");
});

test("(se-12) someone else's stop said before the asker's addition merged, its check back after: it drops the merged answer, not everything", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Okay, we sorted that out Angel.", "Angel, and with a shield?"],
    gate: a => (/sorted/.test(a.bareText) ? { toAngel: true, complete: true, stop: true, question: "" } : { toAngel: true, complete: true, stop: false, question: a.bareText }) }));
  const realGate = x.s.gate;
  let n = 0;
  x.s.gate = async a => { await sleep(/sorted/.test(a.bareText) ? 700 : n++ === 0 ? 150 : 50); return realGate(a); };
  let release; const later = new Promise(r => { release = r; });
  x.s.answer = async q => { x.asked.push(q); await later; return { say: `Answer to: ${q.question}`, sources: [], lookups: 1, dollars: 0.02 }; };
  speech(x.voice, "p1");
  speech(x.voice, "p2");                          /* said while Mira's own check runs: its check takes 0.7 s */
  await until(() => x.asked.length === 1);
  speech(x.voice, "p1");                          /* Mira adds: merged before Sam's check comes back */
  await until(() => x.s.counts.merged === 1);
  await until(() => x.gates.length === 3);
  await sleep(600);
  release();
  await x.s.answering; await sleep(50);
  assert.equal(x.s.lastStopAt, -Infinity, "no global stop");
  assert.deepEqual(answers(x.voice), [], "the merged answer is not spoken");
});
