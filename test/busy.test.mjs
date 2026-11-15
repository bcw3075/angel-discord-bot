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
  constructor() { super(); this.spoken = []; this.stops = 0; this.echo = false; this.speakMs = 0; this.periods = []; }
  /* with speakMs set, each clip takes that long and goes in her own speech (the echo window), as live */
  speak(clips) {
    this.spoken.push(...clips.map(String));
    if (!this.speakMs) return Promise.resolve();
    const start = Date.now();
    this.periods.push([start, null]);
    return sleep(this.speakMs * clips.length).then(() => { this.periods.at(-1)[1] = Date.now(); });
  }
  ownSpeech() { return this.periods; }
  stopSpeaking() { this.stops++; }
  inEchoWindow() { return this.echo; }
  ignore() {}
  leave() {}
  talk(userId, speaking, at = Date.now()) { this.emit("talking", { userId, speaking, at }); }
}

const made = [];
afterEach(() => { for (const x of made.splice(0)) { try { x.end(); } catch { /* already ended */ } } });

const FAST = { silenceMs: 0, busyBlipMs: 30, busyPauseMs: 40, busyFirstWaitMs: 400, busyGapMs: 80, busyMaxHoldMs: 1500, ackPhrase: "" };

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
/* someone stops talking, and the end of what they said reaches her as a piece of speech silenceMs later, as it does
   live (a short one here: too short to transcribe, so it takes no line from `heard`) */
const stops = (x, userId) => {
  x.voice.talk(userId, false);
  const at = Date.now();
  setTimeout(() => x.voice.emit("speech", { userId, packets: tonePackets(0.2), startedAt: at - 200, final: true }), x.s.cfg.silenceMs);
};

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
  stops(x, "p2");
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
  stops(x, "p2");
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
  stops(x, "p2");
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
  stops(x, "p2");
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
  stops(x, "p2");
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
  stops(x, "p2");
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
  stops(x, "p2");
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
  stops(x, "p2");
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
  stops(x, "p2");
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
    stops(x, "p2");
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
  stops(x, "p2");
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
  stops(x, "p2");
  await x.s.answering;
});

test("(se-12) 'Angel?' from someone else releases her and keeps room for their question after it", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Angel?", "What does off-guard do?"], hold: a => (a.bareText === "Angel?" ? { kind: "go" } : { kind: "none" }) }));
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.voice.spoken.length === 1);
  speech(x.voice, "gm");
  await until(() => answers(x.voice).length === 1);
  stops(x, "p2");
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
  stops(x, "p2");
  await until(() => answers(x.voice).length === 1, 300);
  await x.s.answering;
  assert.deepEqual(x.voice.spoken, ["clip:Answer to: Angel, what does grabbed do?"]);
});

/* ---- the second review of 0.1.3 ---- */
test("(se-12) a quiet that comes right after a line doesn't release her before that line is heard and judged", async () => {
  for (const [said, kind, want] of [["Oh, and with a shield?", "ask", "merged"], ["Hold on Angel, one sec.", "wait", "held"], ["Never mind, we got it.", "stop", "dropped"]]) {
    const x = await started(setup({ heard: ["Angel, what does grabbed do?", said], hold: a => (a.bareText === said ? { kind, question: kind === "ask" ? "With a shield?" : "" } : { kind: "none" }) }));
    x.voice.talk("p2", true, Date.now() - 500);
    speech(x.voice, "p1");
    await until(() => x.voice.spoken.length === 1);
    /* real timing: hearing and judging the line take longer than the gap */
    const stt = x.s.stt, hold = x.s.hold;
    x.s.stt = async w => { await sleep(250); return stt(w); };
    x.s.hold = async a => { await sleep(250); return hold(a); };
    stops(x, "p2");
    speech(x.voice, "p1");
    await sleep(900);
    const a = answers(x.voice);
    if (want === "merged") assert.deepEqual(a, ["clip:Answer to: Angel, what does grabbed do? Oh, and with a shield?"], said);
    else assert.deepEqual(a, [], `${said}: not released by the quiet`);
    x.s.end();
    await x.s.answering;
  }
});

test("(se-12) after a merge, the held answer's post is not given to the fresh one as 'your last written answer'; nothing more of it is voiced", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Oh, and with a shield?"], hold: a => (/shield/.test(a.bareText) ? { kind: "ask", question: "With a shield?" } : { kind: "none" }) }));
  let n = 0, late = null;
  x.s.answer = async q => {
    x.asked.push(q);
    if (++n === 1) {
      q.onSay("First sentence of the held one. ", {});
      late = async () => { q.onSay("Second sentence of the held one. ", {}); q.onSay("Third. ", { end: true }); };
      return { say: "First sentence of the held one.", details: "DETAILS of the held one", sources: [], lookups: 1, dollars: 0.02 };
    }
    return { say: `Answer to: ${q.question}`, details: "fresh details", sources: [], lookups: 1, dollars: 0.02 };
  };
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.voice.spoken.length === 1);
  await until(() => x.s.lastWritten?.text === "DETAILS of the held one");
  speech(x.voice, "p1");
  await until(() => x.asked.length === 2);
  const voiced = [], tts = x.s.tts;
  x.s.tts = async t => { voiced.push(t); return tts(t); };
  await late();
  stops(x, "p2");
  await x.s.answering;
  assert.doesNotMatch(x.asked[1].conversation, /DETAILS of the held one/);
  assert.ok(!x.voice.spoken.some(c => /held one|Third/.test(c)), "the dropped answer's later sentences are not voiced");
  assert.ok(!voiced.some(t => /held one|Third/.test(t)), "nor paid to be voiced");
  assert.equal(x.s.lastWritten.text, "fresh details");
});

test("(se-12) a typed question held: the asker's own typed line doesn't release her; someone else's does", async () => {
  const x = await started(setup());
  x.voice.talk("p2", true, Date.now() - 500);
  x.s.textQuestion({ userId: "p1", asker: "Mira", text: "what does grabbed do?" });
  await until(() => x.voice.spoken.length === 1);
  x.s.textQuestion({ userId: "p1", asker: "Mira", text: "and restrained?" });
  await sleep(120);
  assert.equal(answers(x.voice).length, 0, "her own follow-up waits its turn");
  x.s.textQuestion({ userId: "gm", asker: "Dana", text: "what is flanking?" });
  await until(() => answers(x.voice).length === 1);
  x.s.end();
  await x.s.answering;
});

test("(se-12) a gap is never shorter than it takes a piece of speech to reach her (silenceMs plus a fifth of a second)", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?"], cfg: { silenceMs: 600, busyGapMs: 80 } }));
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.voice.spoken.length === 1);
  const t0 = Date.now();
  stops(x, "p2");
  await until(() => answers(x.voice).length === 1);
  assert.ok(Date.now() - t0 >= 780, `released after ${Date.now() - t0} ms`);
  await x.s.answering;
});

/* ---- the third review of 0.1.3 ---- */
test("(se-12) the talk stops early in the hold with 'hold on' still being heard: no 'the talk stopped, go ahead'", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Hold on Angel, one sec."], hold: a => (/Hold on/.test(a.bareText) ? { kind: "wait" } : { kind: "none" }), cfg: { busyFirstWaitMs: 300 } }));
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.s.holding);
  const stt = x.s.stt, hold = x.s.hold;
  x.s.stt = async w => { await sleep(300); return stt(w); };
  x.s.hold = async a => { await sleep(300); return hold(a); };
  stops(x, "p2");
  speech(x.voice, "p2");
  await sleep(1000);
  assert.deepEqual(answers(x.voice), [], "held for the go-ahead");
  assert.equal(x.s.holding?.mode, "invite");
  x.s.end();
  await x.s.answering;
});

test("(se-12) someone talking since before the question, ending with 'hold on': heard and judged as said while she waits", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "...so that's my plan, hold on Angel, one sec."], hold: a => (/hold on/.test(a.bareText) ? { kind: "wait" } : { kind: "none" }) }));
  const began = Date.now() - 2000;
  x.voice.talk("p2", true, began);
  speech(x.voice, "p1");
  await until(() => x.s.holding);
  const stt = x.s.stt;
  x.s.stt = async w => { await sleep(200); return stt(w); };
  stops(x, "p2");
  x.voice.emit("speech", { userId: "p2", packets: tonePackets(3), startedAt: began, final: true }); /* one piece of 3 s, begun before the question */
  await sleep(900);
  assert.equal(x.holds.length, 1, "it went to the check while she waits");
  assert.deepEqual(answers(x.voice), []);
  x.s.end();
  await x.s.answering;
});

test("(se-12) a piece stuck in hearing stops holding her up after thirty seconds", async () => {
  const x = await started(setup());
  x.s.hearingNow.set(99, { end: Date.now() + 1000, added: Date.now() });
  assert.equal(x.s.stillHearing(Date.now() - 1), true);
  x.s.hearingNow.set(99, { end: Date.now() + 1000, added: Date.now() - 31000 });
  assert.equal(x.s.stillHearing(Date.now() - 1), false);
});

test("(se-12) after a merge or a stop, what she said for the question is her reaction and her 'I'm ready', not the answer", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Never mind."], hold: a => (/Never/.test(a.bareText) ? { kind: "stop" } : { kind: "none" }) }));
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.voice.spoken.length === 1);
  speech(x.voice, "gm");
  await x.s.answering;
  assert.equal(x.s.lastSaid, "Got it, whenever you're ready.");
});

test("(se-12) the talk stops while her 'I'm ready' is being written, with 'hold on' still being heard: no 'go ahead' when her words are ready", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Hold on Angel."], hold: a => (/Hold on/.test(a.bareText) ? { kind: "wait" } : { kind: "none" }), cfg: { busyFirstWaitMs: 50 } }));
  x.s.readyLine = async () => { await sleep(700); return { text: "Ready when you are." }; };
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.s.holding);
  await sleep(100); /* past the first wait: her words are being written */
  const stt = x.s.stt, hold = x.s.hold;
  /* heard and judged only after her words are ready, and the talk stopped well before that */
  x.s.stt = async w => { await sleep(500); return stt(w); };
  x.s.hold = async a => { await sleep(500); return hold(a); };
  stops(x, "p2");
  speech(x.voice, "p2");
  await sleep(1400);
  assert.deepEqual(answers(x.voice), []);
  x.s.end();
  await x.s.answering;
});

/* ---- the fourth review of 0.1.3: real-like timing (a piece reaches her silenceMs after the talk stops) ---- */
const REAL = { silenceMs: 300, busyPauseMs: 40, busyFirstWaitMs: 700, busyGapMs: 80, busyMaxHoldMs: 5000 };

test("(se-12) 'hold on' that stopped longer ago than a breath, its piece still on its way: she doesn't go ahead", async () => {
  /* live: a piece reaches her 0.9 s after the talk stops, but the talk counts as over after 0.4 s */
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Hold on Angel, one sec."], hold: a => (/Hold on/.test(a.bareText) ? { kind: "wait" } : { kind: "none" }), cfg: { ...REAL, silenceMs: 800, busyFirstWaitMs: 700 } }));
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.s.holding);
  await sleep(200);
  x.voice.talk("p2", false); /* the first wait runs out 0.5 s after this, before the piece comes */
  setTimeout(() => speech(x.voice, "p2", Date.now() - 1500), 800);
  await sleep(1600);
  assert.deepEqual(answers(x.voice), [], "held: the 'hold on' was heard before any quiet counted");
  assert.equal(x.s.holding?.mode, "invite");
  x.s.end();
  await x.s.answering;
});

test("(se-12) a trickle of clicks too short to be words doesn't block the gap", async () => {
  /* live lengths: a click of 0.1 s is under a blip and under the shortest piece ever transcribed; 0.45 s apart (no
     breath joins them into talk, but closer than the any-sound margin review 4 removed) */
  const x = await started(setup({ heard: ["Angel, what does grabbed do?"], cfg: { ...REAL, busyBlipMs: 500, minUtteranceMs: 400 } }));
  x.voice.talk("p2", true, Date.now() - 800);
  speech(x.voice, "p1");
  await until(() => x.voice.spoken.length === 1);
  stops(x, "p2");
  let on = true;
  (async () => { while (on) { x.voice.talk("p3", true); await sleep(100); x.voice.talk("p3", false); await sleep(450); } })();
  await until(() => answers(x.voice).length === 1, 4000);
  on = false;
  await x.s.answering;
});

test("(se-12) the talk stops as she would cut in, a line is judged nothing for her, the talk starts again: she cuts in then", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "So I move up."], cfg: { ...REAL, silenceMs: 800, busyFirstWaitMs: 700, busyGapMs: 1500 } }));
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.s.holding);
  await sleep(200);
  x.voice.talk("p2", false); /* the first wait ends 0.5 s later: not talking, the piece not come: no cut-in */
  setTimeout(() => speech(x.voice, "p2", Date.now() - 1000), 800);
  await sleep(900);           /* past the first wait; the line has come and is judged nothing for her; no gap yet */
  assert.deepEqual(x.voice.spoken, [], "no cut-in while nobody talks");
  x.voice.talk("p2", true);
  await until(() => x.voice.spoken.length === 1, 3000);
  assert.deepEqual(x.voice.spoken, ["clip:Got it, whenever you're ready."], "her 'I'm ready', once the talk is back");
  stops(x, "p2");
  await until(() => answers(x.voice).length === 1, 4000);
  await x.s.answering;
});

test("(se-12) an answer unsaid with nothing said for it leaves her last words as they were", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?"] }));
  x.s.readyLine = async () => { await sleep(2000); return { text: "Late." }; };
  x.s.lastSaid = "her earlier answer";
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.s.holding);
  x.s.stop();
  await x.s.answering;
  assert.equal(x.s.lastSaid, "her earlier answer");
});

/* ---- the fifth review of 0.1.3 (live lengths: blip 0.5 s, shortest piece 0.4 s, a piece 0.8 s after the talk) ---- */
const LIVE = { ...REAL, silenceMs: 800, busyBlipMs: 500, minUtteranceMs: 400, busyFirstWaitMs: 700, busyGapMs: 1000 };

test("(se-12) a 'hold on' begun during her 'I'm ready' is waited for, not talked over", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Hold on Angel."], hold: a => (/Hold on/.test(a.bareText) ? { kind: "wait" } : { kind: "none" }), cfg: LIVE }));
  x.voice.speakMs = 600;
  x.voice.talk("p2", true, Date.now() - 800);
  speech(x.voice, "p1");
  await until(() => x.voice.spoken.length === 1, 3000); /* her cut-in, playing */
  await sleep(300);
  x.voice.talk("p3", true);    /* starts over her */
  stops(x, "p2");
  await sleep(1000);           /* her cut-in ended 0.7 s ago */
  x.voice.talk("p3", false);
  setTimeout(() => speech(x.voice, "p3", Date.now() - 1800), 800);
  await sleep(1600);
  assert.deepEqual(answers(x.voice), [], "the 'hold on' was heard first");
  assert.equal(x.s.holding?.mode, "invite");
  x.s.end();
  await x.s.answering;
});

test("(se-12) a line just said and not yet heard: her 'I'm ready' may land on it (Rhea's choice), her answer never does", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Hold on Angel."], hold: a => (/Hold on/.test(a.bareText) ? { kind: "wait" } : { kind: "none" }), cfg: LIVE }));
  x.voice.talk("p2", true, Date.now() - 800);
  speech(x.voice, "p1");
  await until(() => x.s.holding);
  await sleep(500);
  x.voice.talk("p2", false);   /* 0.2 s before the first wait ends: still "talking" then, but just said */
  setTimeout(() => speech(x.voice, "p2", Date.now() - 1800), 800);
  await sleep(1500);
  assert.deepEqual(answers(x.voice), [], "no answer over it");
  assert.equal(x.s.holding?.mode, "invite");
  x.s.end();
  await x.s.answering;
});

test("(se-12) 'Wait... wait.' in two short bursts reaches her as one piece and is waited for", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Wait... wait."], hold: a => (/Wait/.test(a.bareText) ? { kind: "wait" } : { kind: "none" }), cfg: { ...LIVE, busyGapMs: 1500 } }));
  x.voice.talk("p2", true, Date.now() - 800);
  speech(x.voice, "p1");
  await until(() => x.voice.spoken.length === 1, 3000);
  stops(x, "p2");
  await sleep(200);
  x.voice.talk("p3", true); await sleep(250); x.voice.talk("p3", false);
  await sleep(600);
  x.voice.talk("p3", true); await sleep(250); x.voice.talk("p3", false);
  setTimeout(() => speech(x.voice, "p3", Date.now() - 1100), 800);
  await sleep(1400);
  assert.deepEqual(answers(x.voice), []);
  assert.equal(x.s.holding?.mode, "invite");
  x.s.end();
  await x.s.answering;
});

test("(se-12) talk that comes back while her words are still being written: a gap still releases her, not her words", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "So I move up."], cfg: LIVE }));
  x.s.readyLine = async () => { await sleep(5000); return { text: "Late." }; };
  x.voice.talk("p2", true, Date.now() - 800);
  speech(x.voice, "p1");
  await until(() => x.s.holding);
  await sleep(200);
  x.voice.talk("p2", false);   /* 0.5 s before the first wait ends: not talking then, nothing heard yet: no cut-in */
  setTimeout(() => speech(x.voice, "p2", Date.now() - 1500), 800);
  await sleep(1000);
  x.voice.talk("p2", true); await sleep(600); stops(x, "p2"); /* a little more, then quiet */
  const t0 = Date.now();
  await until(() => answers(x.voice).length === 1, 4000);
  assert.ok(Date.now() - t0 < 2500, "released by the gap, not when her words came");
  await x.s.answering;
});

/* ---- the sixth review of 0.1.3 ---- */
test("(se-12) talk with ordinary breaths (shorter than a piece's silence): she still cuts in while they talk (Rhea: 'Yes, cut in anyway')", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?"], cfg: LIVE }));
  x.voice.talk("p2", true, Date.now() - 800);
  speech(x.voice, "p1");
  let on = true;
  /* a breath before the first wait ends, then 0.7 s of talk and 0.6 s breaths: never a pause that ends a piece */
  (async () => { await sleep(200); while (on) { x.voice.talk("p2", false); await sleep(600); x.voice.talk("p2", true); await sleep(700); } })();
  try {
    await until(() => x.voice.spoken.length === 1, 6000);
    assert.deepEqual(x.voice.spoken, ["clip:Got it, whenever you're ready."]);
  } finally { on = false; }
  x.s.end();
  await x.s.answering;
});

test("(se-12) a trickle of clicks with live timing (joined into one never-ending piece) stops holding her up after the cap", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?"], cfg: { ...LIVE, busyMaxHoldMs: 8000 } }));
  x.s.unheardCapMs = 1500;
  x.voice.talk("p2", true, Date.now() - 800);
  speech(x.voice, "p1");
  await until(() => x.voice.spoken.length === 1, 3000);
  stops(x, "p2");
  let on = true;
  (async () => { while (on) { x.voice.talk("p3", true); await sleep(100); x.voice.talk("p3", false); await sleep(450); } })();
  try { await until(() => answers(x.voice).length === 1, 6000); } finally { on = false; }
  await x.s.answering;
});

/* ---- the seventh review of 0.1.3 ---- */
test("(se-12) long talk (over the 10 s cap) ending in 'hold on': her answer doesn't start before it has reached her and been judged", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "...and that's the plan, hold on, Angel."], hold: a => (/hold on/.test(a.bareText) ? { kind: "wait" } : { kind: "none" }), cfg: { ...LIVE, busyFirstWaitMs: 1500 } }));
  x.s.unheardCapMs = 1000; /* the cap reached, as after 10 s of talk */
  const began = Date.now() - 3000;
  x.voice.talk("p2", true, began);
  speech(x.voice, "p1");
  await until(() => x.s.holding);
  await sleep(1000);
  const stt = x.s.stt, hold = x.s.hold;
  x.s.stt = async w => { await sleep(400); return stt(w); };
  x.s.hold = async a => { await sleep(500); return hold(a); };
  x.voice.talk("p2", false);  /* 0.5 s before the first wait ends: not talking then, its piece not come */
  setTimeout(() => x.voice.emit("speech", { userId: "p2", packets: tonePackets(4), startedAt: began, final: true }), 800);
  await sleep(2200);
  assert.deepEqual(answers(x.voice), [], "the 'hold on' was judged first");
  assert.equal(x.s.holding?.mode, "invite");
  x.s.end();
  await x.s.answering;
});

test("(se-12) the end of someone else's talk over 30 s, its first part held because it named her: judged while she waits", async () => {
  const x = await started(setup({ heard: ["Angel, what does grabbed do?", "Angel, so the first thing is this long story", "and anyway hold on, Angel."], hold: a => (/hold on/.test(a.bareText) ? { kind: "wait" } : { kind: "none" }) }));
  x.voice.talk("p2", true, Date.now() - 500);
  speech(x.voice, "p1");
  await until(() => x.voice.spoken.length === 1);
  const t = Date.now();
  x.voice.emit("speech", { userId: "p2", packets: tonePackets(1), startedAt: t, final: false }); /* cut at 30 s, still talking */
  await until(() => x.s.pending.get("p2")?.held);
  x.voice.emit("speech", { userId: "p2", packets: tonePackets(1), startedAt: t + 1000, final: true });
  await until(() => x.holds.length === 1);
  assert.match(x.holds[0].bareText, /long story and anyway hold on/, "all of it, to the check while she waits");
  await until(() => x.s.holding?.mode === "invite");
  x.s.end();
  await x.s.answering;
});
