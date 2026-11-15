/* A busy table (0.1.3, Rhea's design d-7): she waits for a gap, cuts in with a quick "I'm ready" in her own words if
   the talk goes on, then waits for a gap or a go-ahead; "hold on", a stop, more from the asker and another player's
   question while she waits; a merged question keeps its place in line. Stand-ins for Discord, Deepgram and Claude. */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session } from "../src/session.mjs";
import { DEFAULTS } from "../src/config.mjs";
import { tonePackets, sleep } from "./helpers.mjs";

class FakeVoice extends EventEmitter {
  constructor() { super(); this.spoken = []; this.stops = 0; this.echo = false; }
  speak(clips) { this.spoken.push(...clips.map(String)); return Promise.resolve(); }
  stopSpeaking() { this.stops++; }
  inEchoWindow() { return this.echo; }
  ignore() {}
  leave() {}
  talk(userId, speaking, at = Date.now()) { this.emit("talking", { userId, speaking, at }); }
}

const made = [];
afterEach(() => { for (const x of made.splice(0)) { try { x.end(); } catch { /* already ended */ } } });

const FAST = { busyBlipMs: 30, busyPauseMs: 40, busyFirstWaitMs: 120, busyGapMs: 80, busyMaxHoldMs: 700, ackPhrase: "" };

function setup({ heard = [], hold = () => ({ kind: "none" }), ready = () => ({ text: "Got it, whenever you're ready." }), cfg = {}, gate = a => ({ toAngel: true, complete: true, stop: false, question: a.bareText }) } = {}) {
  const voice = new FakeVoice();
  const posted = [], holds = [], readies = [], asked = [];
  const post = { send: async text => { const m = { text, edits: [], edit: async t => { m.edits.push(t); }, delete: async () => { m.deleted = true; } }; posted.push(m); return m; } };
  const s = new Session({
    cfg: { ...DEFAULTS, ...FAST, ...cfg },
    voice, post,
    stt: async () => ({ text: heard.shift() ?? "", seconds: 1 }),
    tts: async text => [Buffer.from(`clip:${text}`)],
    gate: async a => ({ dollars: 0.0001, ...gate(a) }),
    hold: async a => { holds.push(a); return { dollars: 0.0001, ...hold(a) }; },
    readyLine: async a => { readies.push(a); const r = ready(a); if (r instanceof Error) throw r; return { dollars: 0.0001, ...r }; },
    answer: async q => { asked.push(q); return { say: `Answer to: ${q.question}`, sources: [], lookups: 1, dollars: 0.02 }; },
    speakerOf: id => ({ name: { p1: "Mira", p2: "Sam", gm: "Dana" }[id] ?? id, role: id === "gm" ? "GM" : "player" }),
    log: { info() {}, warn() {}, error() {}, debug() {} },
  });
  made.push(s);
  return { s, voice, posted, holds, readies, asked };
}

const speech = (voice, userId, at = Date.now()) => voice.emit("speech", { userId, packets: tonePackets(1), startedAt: at, final: true });
const until = async (cond, ms = 3000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timed out waiting"); await sleep(5); } };
const answers = voice => voice.spoken.filter(c => c.startsWith("clip:Answer"));

async function started(x) { await x.s.start(); if (x.s.floor) x.s.floor.pollMs = 5; return x; }

test("(se-11) a quiet table: she answers at once, nothing written for a cut-in, nothing held", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?"] }));
  speech(x.voice, "p1");
  await until(() => answers(x.voice).length === 1);
  await x.s.answering;
  assert.equal(x.readies.length, 0, "no cut-in words written");
  assert.equal(x.s.counts.held, 0);
});

test("(se-11) talk that stops within the first moment: she just answers, no cut-in, no quick reaction over it", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?"], cfg: { ackPhrase: "One sec." } }));
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.s.holding);
  x.voice.talk("p2", false);
  await until(() => answers(x.voice).length === 1);
  await x.s.answering;
  assert.deepEqual(x.voice.spoken, ["clip:Answer to: Angel, what does grabbed do?"], "no quick reaction over the talk and no 'I'm ready'");
  assert.equal(x.s.counts.held, 1);
});

test("(se-11) talk that goes on: a quick 'I'm ready' in her own words, then the answer at the gap; written at once", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?"] }));
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.voice.spoken.length === 1);
  assert.deepEqual(x.voice.spoken, ["clip:Got it, whenever you're ready."], "she cuts in");
  assert.equal(x.readies.length, 1, "one call wrote her words");
  assert.match(x.readies[0].question, /grabbed/, "it is told the question");
  assert.match(x.posted[0].edits.at(-1) ?? "", /Answer to/, "the written answer is posted while she waits");
  await sleep(150);
  assert.equal(answers(x.voice).length, 0, "still talking: she waits");
  x.voice.talk("p2", false);
  await until(() => answers(x.voice).length === 1);
  await x.s.answering;
  const said = x.s.transcript.lines.filter(l => l.kind === "angel").map(l => l.text);
  assert.deepEqual(said, ["Got it, whenever you're ready.", "Answer to: Angel, what does grabbed do?"], "both in the transcript, in order");
  // her last words go along next time, so the next one is different
  x.voice.talk("p2", true, Date.now() - 500);
  x.voice.talk("p1", false);
  await x.s.ask({ question: "And restrained?", asker: "Mira", via: "voice", userId: "p1", at: Date.now() });
  await until(() => x.readies.length === 2);
  assert.deepEqual(x.readies[1].earlier, ["Got it, whenever you're ready."]);
});

test("(se-11) no gap for the whole hold: the spoken answer is let go, the post says so, the asker can reply without her name", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?"] }));
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.s.counts.letGo === 1, 3000);
  await x.s.answering;
  assert.equal(answers(x.voice).length, 0, "never said aloud");
  assert.match(x.posted[0].edits.at(-1), /Answer to[\s\S]*didn't get a gap/, "the post has the answer and the note");
  assert.equal(x.s.replyTo?.userId, "p1", "the reply window opens");
  assert.ok(!x.s.transcript.lines.some(l => l.kind === "angel" && /Answer to/.test(l.text)), "not in the transcript as said");
  assert.equal(x.s.holding, null);
});

test("(se-12) a go-ahead while she waits: she answers though the table is still busy", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Yeah, go ahead Angel."], hold: a => (/go ahead/.test(a.bareText) ? { kind: "go" } : { kind: "none" }) }));
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.voice.spoken.length === 1);
  speech(x.voice, "gm");
  await until(() => answers(x.voice).length === 1);
  await x.s.answering;
  assert.equal(x.holds.length, 1, "the line said while she waits is checked");
  assert.equal(x.holds[0].asker, "Mira");
  assert.match(x.holds[0].question, /grabbed/);
  assert.equal(x.holds[0].cutIn, "Got it, whenever you're ready.", "the check knows what she said");
  assert.equal(x.s.counts.letGo, 0);
});

test("(se-12) 'hold on' before the cut-in: no cut-in, and quiet alone doesn't release her; a go-ahead does", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Hold on Angel.", "Okay, go."], hold: a => (/Hold on/.test(a.bareText) ? { kind: "wait" } : /go/.test(a.bareText) ? { kind: "go" } : { kind: "none" }), cfg: { busyFirstWaitMs: 400 } }));
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.s.holding);
  speech(x.voice, "gm");
  await until(() => x.s.holding?.mode === "invite");
  x.voice.talk("p2", false);
  await sleep(250);
  assert.deepEqual(x.voice.spoken, [], "no 'I'm ready' after hold on, and the quiet didn't release her");
  speech(x.voice, "gm");
  await until(() => answers(x.voice).length === 1);
  await x.s.answering;
});

test("(se-12) 'hold on' after the cut-in, with no go-ahead: let go at the limit", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Not now."], hold: () => ({ kind: "wait" }) }));
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.voice.spoken.length === 1);
  speech(x.voice, "gm");
  await until(() => x.s.holding?.mode === "invite");
  x.voice.talk("p2", false);
  await until(() => x.s.counts.letGo === 1, 3000);
  await x.s.answering;
  assert.equal(answers(x.voice).length, 0);
});

test("(se-12) a stop while she waits drops the spoken answer; the written one stays", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Never mind, we got it."], hold: () => ({ kind: "stop" }) }));
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.voice.spoken.length === 1);
  speech(x.voice, "gm");
  await x.s.answering;
  await sleep(30);
  assert.equal(answers(x.voice).length, 0);
  assert.equal(x.s.holding, null);
  assert.match(x.posted[0].edits.at(-1), /Answer to/);
  assert.doesNotMatch(x.posted[0].edits.at(-1), /didn't get a gap/, "a stop isn't a let-go");
  assert.equal(x.s.counts.letGo, 0);
});

test("(se-12) 'Angel, stop' said aloud while she waits works at once, and a stop from before the question doesn't drop it", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Angel, stop."] }));
  x.voice.talk("p2", true, Date.now() - 500);
  const asked = Date.now();
  speech(x.voice, "p1", asked);
  await until(() => x.voice.spoken.length === 1);
  x.s.stop(asked - 1000);
  await sleep(30);
  assert.ok(x.s.holding, "an older stop doesn't end the hold");
  speech(x.voice, "gm");
  await x.s.answering;
  assert.equal(answers(x.voice).length, 0);
  assert.equal(x.holds.length, 0, "the stop phrase needs no check");
});

test("(se-12) the asker adds to the question while she waits: one fresh answer to all of it, the held one never spoken", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Oh, and if I have a shield?"], hold: a => (/shield/.test(a.bareText) ? { kind: "ask", question: "Does a shield change grabbed?" } : { kind: "none" }) }));
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.voice.spoken.length === 1);
  speech(x.voice, "p1");
  await until(() => x.asked.length === 2);
  x.voice.talk("p2", false);
  await until(() => answers(x.voice).length === 1);
  await x.s.answering;
  assert.equal(x.asked[1].question, "Angel, what does grabbed do? Oh, and if I have a shield?", "their words joined");
  assert.deepEqual(answers(x.voice), ["clip:Answer to: Angel, what does grabbed do? Oh, and if I have a shield?"], "only the fresh answer is spoken");
  assert.equal(x.s.counts.merged, 1);
});

test("(se-12) another player's question while she waits: the held answer first, then theirs", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Angel, how does flanking work?"], hold: a => (/flanking/.test(a.bareText) ? { kind: "ask", question: "How does flanking work?" } : { kind: "none" }) }));
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.voice.spoken.length === 1);
  speech(x.voice, "gm");
  await until(() => answers(x.voice).length === 1);
  assert.deepEqual(answers(x.voice), ["clip:Answer to: Angel, what does grabbed do?"], "the question was a go-ahead for the held answer, though the table is busy");
  // theirs waits for a gap of its own, like any answer
  x.voice.talk("p2", false);
  await until(() => answers(x.voice).length === 2);
  await x.s.answering;
  assert.deepEqual(answers(x.voice), ["clip:Answer to: Angel, what does grabbed do?", "clip:Answer to: Angel, how does flanking work?"]);
});

test("(se-12) her words can't be written: no cut-in, she waits for the gap all the same", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?"], ready: () => new Error("busy") }));
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.readies.length === 1);
  await sleep(200);
  assert.deepEqual(x.voice.spoken, [], "never a stock line instead");
  x.voice.talk("p2", false);
  await until(() => answers(x.voice).length === 1);
  await x.s.answering;
});

test("(se-12) her own 'I'm ready' coming back through a mic is not checked", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Got it, whenever you're ready."] }));
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.voice.spoken.length === 1);
  x.voice.echo = true;
  speech(x.voice, "p2");
  await sleep(60);
  assert.equal(x.holds.length, 0);
  x.voice.echo = false;
  x.voice.talk("p2", false);
  await until(() => answers(x.voice).length === 1);
  await x.s.answering;
});

test("(se-12) the session ending while she waits: nothing more is said", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?"] }));
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.voice.spoken.length === 1);
  x.s.end();
  await x.s.answering;
  assert.equal(answers(x.voice).length, 0);
  assert.equal(x.s.holding, null);
});

test("(se-13) busyTable false: she speaks over the talk at once, as before 0.1.3", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?"], cfg: { busyTable: false } }));
  assert.equal(x.s.floor, null);
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => answers(x.voice).length === 1);
  await x.s.answering;
  assert.equal(x.readies.length, 0);
});

test("(se-13) a merged question keeps its place in line ahead of another player's waiting question (Rhea, d-7)", async () => {
  const x = await started(setup());
  let release;
  const gateOpen = new Promise(r => { release = r; });
  x.s.answer = async q => { x.asked.push(q); if (x.asked.length === 1) await gateOpen; return { say: `Answer to: ${q.question}`, sources: [], lookups: 1, dollars: 0.02 }; };
  const t = Date.now();
  // Dana's question is being worked out; Mira's waits behind it; then Sam's; then Mira adds a line
  x.s.ask({ question: "Q-dana", asker: "Dana", via: "voice", userId: "gm", at: t });
  x.s.ask({ question: "Q-mira", asker: "Mira", via: "voice", userId: "p1", at: t + 1 });
  x.s.ask({ question: "Q-sam", asker: "Sam", via: "voice", userId: "p2", at: t + 2 });
  x.s.ask({ question: "and more", asker: "Mira", via: "voice", userId: "p1", at: t + 3 });
  release();
  await until(() => answers(x.voice).length === 3);
  await x.s.answering;
  assert.deepEqual(answers(x.voice), ["clip:Answer to: Q-dana", "clip:Answer to: Q-mira and more", "clip:Answer to: Q-sam"]);
});

test("(se-11) small talk let go: it was only going to be spoken, so it is typed with the note", async () => {
  const x = await started(setup({ heard: ["Angel, how are you tonight?"], gate: a => ({ toAngel: true, complete: true, stop: false, chat: true, question: a.bareText }) }));
  x.s.answer = async q => ({ say: `Answer to: ${q.question}`, sources: [], lookups: 0, dollars: 0.01 });
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.s.counts.letGo === 1, 3000);
  await x.s.answering;
  assert.equal(x.posted.length, 1, "typed after all");
  assert.match(x.posted[0].text, /Answer to: Angel, how are you tonight\?[\s\S]*didn't get a gap/);
});

/* ---- the review of 0.1.3 ---- */
test("(se-12) 'never mind' read while she waits drops only the held answer: another player's question waiting behind it is answered", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Never mind, we figured it out."], hold: a => (/Never mind/.test(a.bareText) ? { kind: "stop" } : { kind: "none" }) }));
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.voice.spoken.length === 1);
  x.s.ask({ question: "Q-sam", asker: "Sam", via: "voice", userId: "p2", at: Date.now() });
  speech(x.voice, "gm", Date.now() + 20); /* said after Sam asked */
  await until(() => x.s.holding?.asker === "Sam" || answers(x.voice).length > 0);
  x.voice.talk("p2", false);
  await until(() => answers(x.voice).length === 1);
  await x.s.answering;
  assert.deepEqual(answers(x.voice), ["clip:Answer to: Q-sam"]);
});

test("(se-12) a merge while she waits leaves one written answer: the held one's post is taken away, also while it is still being written", async () => {
  for (const slow of [false, true]) {
    const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Oh, and with a shield?"], hold: a => (/shield/.test(a.bareText) ? { kind: "ask", question: "With a shield?" } : { kind: "none" }) }));
    let first = true;
    x.s.answer = async q => {
      x.asked.push(q);
      if (first) { first = false; q.onSay?.("Grabbed makes you off-guard. ", {}); if (slow) await sleep(1500); }
      return { say: `Answer to: ${q.question}`, sources: [], lookups: 1, dollars: 0.02 };
    };
    x.voice.talk("p2", true, Date.now() - 500);
    speech(x.voice, "p1");
    await until(() => x.voice.spoken.length === 1);
    const t0 = Date.now();
    speech(x.voice, "p1");
    x.voice.talk("p2", false);
    await until(() => answers(x.voice).length === 1);
    assert.ok(Date.now() - t0 < 700, "the fresh answer doesn't wait for the dropped one to be written");
    await x.s.answering;
    await sleep(20);
    assert.equal(x.posted[0].deleted, true, `the held answer's post goes (${slow ? "still being written" : "already written"})`);
    assert.equal(x.posted.filter(m => !m.deleted).length, 1, "one written answer");
    assert.match(x.posted.find(m => !m.deleted).edits.at(-1), /shield/);
    await until(() => x.s.costs.claude >= 0.04); /* both answers' cost counted, the dropped one when its call ends */
  }
});

test("(se-12) her quick reaction coming back through a mic while she waits is not checked", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Hang on, pulling the page."], cfg: { ackPhrase: "x" }, gate: a => ({ toAngel: true, complete: true, stop: false, question: a.bareText, ack: "Hang on, pulling the page." }) }));
  let release;
  const wait = new Promise(r => { release = r; });
  x.s.answer = async q => { await wait; return { say: `Answer to: ${q.question}`, sources: [], lookups: 1, dollars: 0.02 }; };
  speech(x.voice, "p1");
  await until(() => x.voice.spoken.length === 1); // her quick reaction, the table quiet
  x.voice.talk("p2", true, Date.now() - 500);
  release();
  await until(() => x.s.holding);
  x.voice.echo = true;
  speech(x.voice, "p2");
  await sleep(60);
  assert.equal(x.holds.length, 0);
  x.voice.echo = false;
  x.voice.talk("p2", false);
  await until(() => answers(x.voice).length === 1);
  await x.s.answering;
});

test("(se-12) a typed question from someone else while she waits is a go-ahead", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?"] }));
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.voice.spoken.length === 1);
  x.s.textQuestion({ userId: "gm", asker: "Dana", role: "GM", text: "what is flanking?" });
  await until(() => answers(x.voice).length === 1);
  assert.deepEqual(answers(x.voice), ["clip:Answer to: Angel, what does grabbed do?"]);
  x.voice.talk("p2", false);
  await x.s.answering;
});

test("(se-12) 'Angel?' from someone else releases her and keeps room for their question after it", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Angel?", "What does off-guard do?"], hold: a => (a.bareText === "Angel?" ? { kind: "go" } : { kind: "none" }) }));
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.voice.spoken.length === 1);
  speech(x.voice, "gm");
  await until(() => answers(x.voice).length === 1);
  x.voice.talk("p2", false);
  speech(x.voice, "gm");
  await until(() => answers(x.voice).length === 2);
  await x.s.answering;
  assert.equal(answers(x.voice)[1], "clip:Answer to: Angel? What does off-guard do?");
});

test("(se-12) a pause while her words are still being written: she just answers, no cut-in", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?"], cfg: { busyFirstWaitMs: 40, busyGapMs: 5000 } }));
  x.s.readyLine = async () => { await sleep(400); return { text: "Ready!" }; };
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.s.holding);
  await sleep(80);
  x.voice.talk("p2", false);
  await until(() => answers(x.voice).length === 1, 300);
  await x.s.answering;
  assert.deepEqual(x.voice.spoken, ["clip:Answer to: Angel, what does grabbed do?"]);
});
