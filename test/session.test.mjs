/* The whole flow of a session with stand-ins for Discord's voice channel, Deepgram and Claude: real Opus packets go
   in, and what Angel types and says comes out. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session, summaryText } from "../src/session.mjs";
import { DEFAULTS } from "../src/config.mjs";
import { tonePackets, sleep } from "./helpers.mjs";

class FakeVoice extends EventEmitter {
  constructor() { super(); this.spoken = []; this.stops = 0; this.left = false; this.echo = false; this.ignored = []; }
  speak(clips) { this.spoken.push(...clips); return Promise.resolve(); }
  stopSpeaking() { this.stops++; }
  inEchoWindow() { return this.echo; }
  lastSpokeEnd(since = 0) { return this.end ?? since; }
  ignore(id) { this.ignored.push(id); }
  leave() { this.left = true; }
}

function setup({ heard = [], gate = () => ({ toAngel: true, complete: true, stop: false, question: "" }), cfg = {} } = {}) {
  const voice = new FakeVoice();
  const posted = [];
  const post = { send: async text => { const m = { text, edits: [], edit: async t => { m.edits.push(t); } }; posted.push(m); return m; } };
  const gates = [], asked = [];
  const s = new Session({
    cfg: { ...DEFAULTS, ...cfg },
    voice, post,
    stt: async () => ({ text: heard.shift() ?? "", seconds: 1 }),
    tts: async text => [Buffer.from(`clip:${text}`)],
    gate: async args => { gates.push(args); return { dollars: 0.0001, ...gate(args) }; },
    answer: async q => { asked.push(q); return { say: `Answer to: ${q.question}`, sources: [{ name: "Grabbed", url: "https://2e.aonprd.com/Conditions.aspx?ID=77" }], dollars: 0.02 }; },
    speakerOf: id => ({ name: id === "gm" ? "Dana" : "Mira", role: id === "gm" ? "GM" : "player" }),
    log: { info() {}, warn() {}, error() {}, debug() {} },
  });
  return { s, voice, posted, gates, asked };
}

const speech = (voice, userId, seconds = 1, at = Date.now()) => voice.emit("speech", { userId, packets: tonePackets(seconds), startedAt: at, final: true });
const settle = async () => { for (let i = 0; i < 20; i++) await sleep(5); };

test("a spoken question is checked, answered in the channel and spoken aloud", async () => {
  const { s, voice, posted, gates, asked } = setup({ heard: ["Angel, what does grabbed do?"], gate: () => ({ toAngel: true, complete: true, stop: false, question: "What does the grabbed condition do?" }) });
  await s.start();
  speech(voice, "p1");
  await settle(); await s.answering;
  assert.equal(gates.length, 1);
  assert.equal(gates[0].lastText, "Mira: Angel, what does grabbed do?");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].question, "What does the grabbed condition do?");
  assert.equal(asked[0].via, "voice");
  assert.match(asked[0].conversation, /Mira: Angel, what does grabbed do\?/, "the conversation goes with the question");
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /Looking it up/, "a placeholder at once");
  assert.match(posted[0].edits[0], /^\*\*Mira asked:\*\* What does the grabbed condition do\?\nAnswer to: .*\n-# \[Grabbed\]/);
  assert.deepEqual(voice.spoken.map(String), ["clip:One sec, let me check.", "clip:Answer to: What does the grabbed condition do?"], "the 'checking' phrase, then the full answer");
  assert.equal(s.transcript.lines.at(-1).kind, "angel", "her answer is in the transcript");
  const st = s.status();
  assert.equal(st.questions, 1);
  assert.ok(st.costs.claude > 0.02 && st.costs.stt > 0 && st.costs.tts > 0);
});

test("the short answer is spoken and the fuller one written (Rhea, 2026-11-14)", async () => {
  const { s, voice, posted } = setup({ heard: ["Angel, can I grapple?"], gate: () => ({ toAngel: true, complete: true, stop: false, question: "Can I grapple?" }) });
  s.answer = async () => ({ say: "Only with a free hand.", details: "Grapple needs a free hand; a buckler leaves its hand free.", sources: [], dollars: 0.01 });
  await s.start();
  speech(voice, "p1");
  await settle(); await s.answering;
  assert.deepEqual(voice.spoken.map(String).slice(1), ["clip:Only with a free hand."], "only the short answer is spoken");
  assert.match(posted[0].edits[0], /buckler/, "the written answer is the fuller one");
  assert.equal(s.transcript.lines.at(-1).text, "Only with a free hand.", "the transcript has what she said");
});

test("the person she just answered can reply without her name for a while; banter gets a spoken reply only (Rhea, 2026-11-14)", async () => {
  const heard = ["Angel, how are you feeling having a voice?", "That's funny. Good. You were listening.", "Pass me the dice.", "Ha, nice."];
  const { s, voice, posted, gates } = setup({ heard, gate: a => /dice/.test(a.lastText) ? { toAngel: false } : { toAngel: true, complete: true, stop: false, chat: true, question: a.bareText } });
  await s.start();
  speech(voice, "p1");
  await settle(); await s.answering;
  assert.equal(posted.length, 0, "small talk isn't posted in the channel");
  assert.deepEqual(voice.spoken.map(String), ["clip:Answer to: Angel, how are you feeling having a voice?"], "no 'let me check' for small talk");
  // her reply without her name, by the same person, right after she spoke: checked and answered
  voice.end = Date.now();
  speech(voice, "p1");
  await settle(); await s.answering;
  assert.equal(gates.length, 2, "the reply went to the check");
  assert.equal(voice.spoken.length, 2, "and she answered it");
  // someone else without her name: not even checked
  speech(voice, "p2");
  await settle(); await s.answering;
  assert.equal(gates.length, 2, "another player's line isn't checked");
  // the same person after the window: not checked
  voice.end = Date.now() - 60000;
  s.replyTo.at = Date.now() - 60000;
  speech(voice, "p1");
  await settle(); await s.answering;
  assert.equal(gates.length, 2, "too late to count as a reply");
});

test("talk that only mentions an angel in the story is not answered", async () => {
  const { s, voice, gates, asked } = setup({ heard: ["the angel statue starts to glow"], gate: () => ({ toAngel: false, complete: true, stop: false, question: "" }) });
  await s.start();
  speech(voice, "gm");
  await settle();
  assert.equal(gates.length, 1);
  assert.equal(asked.length, 0);
});

test("lines that don't name her cost nothing beyond the transcript", async () => {
  const { s, voice, gates } = setup({ heard: ["I swing my axe at the goblin"] });
  await s.start();
  speech(voice, "p1");
  await settle();
  assert.equal(gates.length, 0);
  assert.equal(s.transcript.lines.length, 1);
});

test('"Angel?" then the question: one answer, with both parts', async () => {
  const { s, voice, asked, gates } = setup({
    heard: ["Angel?", "can I grapple twice in one turn?"],
    gate: ({ lastText }) => lastText.endsWith("Angel?") ? { toAngel: true, complete: false, stop: false, question: "" } : { toAngel: true, complete: true, stop: false, question: "Can I Grapple twice in one turn?" },
  });
  await s.start();
  speech(voice, "p1");
  await settle();
  assert.equal(asked.length, 0, "waits for the rest");
  speech(voice, "p1");
  await settle(); await s.answering;
  assert.equal(gates[1].lastText, "Mira: Angel? can I grapple twice in one turn?");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].question, "Can I Grapple twice in one turn?");
});

test('"Angel, stop" stops her at once, without the check', async () => {
  const { s, voice, gates } = setup({ heard: ["Angel, stop"] });
  await s.start();
  speech(voice, "gm");
  await settle();
  assert.equal(voice.stops, 1);
  assert.equal(gates.length, 0);
});

test("speech that began while she was talking is not taken as a question (her own voice coming back)", async () => {
  const { s, voice, gates } = setup({ heard: ["Angel says you are off-guard"] });
  await s.start();
  voice.echo = true;
  speech(voice, "p1");
  await settle();
  assert.equal(gates.length, 0);
});

test("short or quiet sounds are skipped before anything is paid for", async () => {
  let sttCalls = 0;
  const { s, voice } = setup();
  s.stt = async () => { sttCalls++; return { text: "x", seconds: 1 }; };
  await s.start();
  voice.emit("speech", { userId: "p1", packets: tonePackets(0.2), startedAt: Date.now() });
  voice.emit("speech", { userId: "p1", packets: tonePackets(1, { amp: 0 }), startedAt: Date.now() });
  await settle();
  assert.equal(sttCalls, 0);
  assert.equal(s.status().skipped, 2);
});

test("at the spending cap she stops, says so once, and pays for nothing more", async () => {
  const { s, voice, posted, gates } = setup({ heard: ["Angel, one?", "Angel, two?"], cfg: { maxSessionDollars: 0.00001 } });
  await s.start();
  speech(voice, "p1");
  await settle();
  speech(voice, "p1");
  await settle();
  assert.equal(s.status().capped, true);
  assert.equal(posted.filter(p => /spending cap/.test(p.text)).length, 1);
  assert.equal(gates.length, 0);
});

test("a typed question past the cap still gets a reply saying so", async () => {
  const { s } = setup({ cfg: { maxSessionDollars: 0 } });
  await s.start();
  const replies = [];
  await s.textQuestion({ userId: "p1", asker: "Mira", text: "flanking?", reply: { send: async t => { replies.push(t); return {}; } } });
  assert.equal(replies.length, 1);
  assert.match(replies[0], /spending cap \(\$0\)/);
});

test("a typed question is answered without the check and goes to where it was asked", async () => {
  const { s, gates, asked } = setup();
  await s.start();
  const replies = [];
  await s.textQuestion({ userId: "p1", asker: "Mira", text: "how does flanking work?", reply: { send: async t => { replies.push(t); return { edit: async e => replies.push(e) }; } } });
  assert.equal(gates.length, 0);
  assert.equal(asked[0].via, "text");
  assert.match(replies[1], /Answer to: how does flanking work\?/);
  assert.equal(s.transcript.lines[0].kind, "text");
});

test("when answering fails she apologises in the channel instead of going silent", async () => {
  const { s, voice, posted } = setup({ heard: ["Angel, what's a DC?"] });
  s.answer = async () => { throw new Error("Claude answered 500"); };
  await s.start();
  speech(voice, "p1");
  await settle(); await s.answering;
  assert.match(posted[0].edits[0], /couldn't reach my rules brain/);
});

test("ending the session leaves the channel and sums it up", async () => {
  const { s, voice } = setup();
  await s.start();
  const st = s.end();
  assert.equal(voice.left, true);
  assert.equal(s.end().lines, st.lines, "ending twice is harmless");
  assert.match(summaryText({ ...st, minutes: 200, questions: 1 }), /Session over: 200 min, 0 transcript lines, 1 question\. Cost about \$/);
});

test("with speaking turned off she only types", async () => {
  const { s, voice, posted } = setup({ heard: ["Angel, what is off-guard?"], cfg: { speak: false } });
  await s.start();
  speech(voice, "p1");
  await settle(); await s.answering;
  assert.equal(voice.spoken.length, 0);
  assert.equal(posted[0].edits.length, 1);
});

test('"Angel, stop" while she looks something up: the answer is typed but not spoken, and the next queued question is dropped', async () => {
  let release;
  const { s, voice, posted } = setup({ heard: ["Angel, what's grabbed?", "Angel, and restrained?", "Angel, never mind"], gate: ({ bareText }) => ({ toAngel: true, complete: true, stop: false, question: bareText }) });
  s.answer = q => new Promise(r => { release = () => r({ say: `Answer to: ${q.question}`, sources: [], dollars: 0.01 }); });
  await s.start();
  speech(voice, "p1"); await settle();
  speech(voice, "p1"); await settle();
  assert.equal(posted.length, 1, "the second waits its turn");
  speech(voice, "p1"); await settle();
  assert.equal(voice.stops, 1);
  release(); await settle(); await s.answering;
  assert.match(posted[0].edits[0], /Answer to: Angel, what's grabbed\?/, "the first answer is still typed");
  assert.deepEqual(voice.spoken.map(String), ["clip:One sec, let me check."], "but not spoken");
  assert.equal(posted.length, 1, "the queued question was dropped, not answered");
});

test("what the speaker says while the check runs is kept as the rest of the question", async () => {
  let open;
  const { s, voice, asked } = setup({ heard: ["Hey Angel, quick one", "what does off-guard do?"] });
  s.gate = () => new Promise(r => { open = () => r({ toAngel: true, complete: false, stop: false, question: "", dollars: 0 }); });
  await s.start();
  speech(voice, "p1"); await settle();
  speech(voice, "p1"); await settle();
  open(); await settle(); await s.answering;
  assert.equal(asked.length, 1);
  assert.equal(asked[0].question, "Hey Angel, quick one what does off-guard do?");
});

test("the check is given the bare words for its fallback, and a failed check is logged", async () => {
  const warnings = [];
  const { s, voice, gates } = setup({ heard: ["Angel, what's a DC?"], gate: () => ({ toAngel: false, complete: true, stop: false, question: "", error: "Claude answered 529" }) });
  s.log = { ...s.log, warn: m => warnings.push(m) };
  await s.start();
  speech(voice, "p1"); await settle();
  assert.equal(gates[0].bareText, "Angel, what's a DC?");
  assert.equal(gates[0].lastText, "Mira: Angel, what's a DC?");
  assert.ok(warnings.some(w => /check failed \(Claude answered 529\)/.test(w)));
});

test("what a failed answer's rounds cost is counted; the cap is checked again before each answer", async () => {
  const { s, voice, posted } = setup({ heard: ["Angel, one?", "Angel, two?"], cfg: { maxSessionDollars: 0.5 } });
  s.answer = async () => { const e = new Error("boom"); e.dollars = 0.6; throw e; };
  await s.start();
  speech(voice, "p1"); await settle();
  speech(voice, "p1"); await settle(); await s.answering;
  assert.ok(s.costs.claude >= 0.6, "the failed rounds count");
  assert.equal(s.status().capped, true);
  assert.equal(posted.filter(p => /Looking it up/.test(p.text)).length, 1, "the second question isn't looked up past the cap");
});

test("the bot's daily cap stops a session too", async () => {
  let over = false;
  const { s, voice, gates, posted } = setup({ heard: ["Angel, one?"] });
  s.dailyOver = () => over;
  await s.start();
  over = true;
  speech(voice, "p1"); await settle();
  assert.equal(gates.length, 0);
  assert.match(posted[0].text, /today's spending cap/);
});

test('"Angel, stop" said while the check on a question runs: the question is dropped', async () => {
  let open;
  const { s, voice, asked } = setup({ heard: ["Angel, what's grabbed?", "Angel, stop"] });
  s.gate = () => new Promise(r => { open = () => r({ toAngel: true, complete: true, stop: false, question: "What's grabbed?", dollars: 0 }); });
  await s.start();
  speech(voice, "p1", 1, Date.now()); await settle();
  speech(voice, "p2", 1, Date.now() + 5); await settle();
  assert.equal(voice.stops, 1);
  open(); await settle(); await s.answering;
  assert.equal(asked.length, 0, "the stop came after the question, so it covers it");
});

test("what the speaker adds while the check runs is kept even when the check called the question finished", async () => {
  let open;
  const { s, voice, asked } = setup({ heard: ["Angel, what does off-guard do?", "and does it stack?"] });
  s.gate = () => new Promise(r => { open = () => r({ toAngel: true, complete: true, stop: false, question: "What does off-guard do?", dollars: 0 }); });
  await s.start();
  speech(voice, "p1"); await settle();
  speech(voice, "p1"); await settle();
  open(); await settle(); await s.answering;
  assert.equal(asked[0].question, "What does off-guard do? and does it stack?");
});

test("a typed question still waiting when the session ends is told so, not left hanging", async () => {
  let release;
  const { s, voice } = setup({ heard: ["Angel, what's grabbed?"] });
  s.answer = q => new Promise(r => { release = () => r({ say: `Answer to: ${q.question}`, sources: [], dollars: 0.01 }); });
  await s.start();
  speech(voice, "p1"); await settle();
  const replies = [];
  const reply = { send: async t => { replies.push(t); return { edit: async () => {} }; } };
  s.textQuestion({ userId: "p2", asker: "Tobin", text: "and restrained?", reply });
  s.end();
  release(); await settle(); await s.answering;
  assert.match(replies.at(-1), /The session ended before I got to "and restrained\?"/);
});

test('"Angel, stop" during the check on an unfinished question: what they say next is not taken as the rest of it', async () => {
  let open;
  const { s, voice, asked } = setup({ heard: ["Angel, quick one", "Angel, stop", "anyway, back to the door"] });
  let calls = 0;
  /* the first check waits; any later one answers at once that it's a whole question */
  s.gate = () => (calls++ ? Promise.resolve({ toAngel: true, complete: true, stop: false, question: "", dollars: 0 })
    : new Promise(r => { open = () => r({ toAngel: true, complete: false, stop: false, question: "", dollars: 0 }); }));
  await s.start();
  speech(voice, "p1", 1, Date.now()); await settle();
  speech(voice, "p2", 1, Date.now() + 5); await settle();
  open(); await settle();
  speech(voice, "p1", 1, Date.now() + 10); await settle(); await s.answering;
  assert.equal(asked.length, 0);
  assert.equal(calls, 1, "the next line wasn't treated as the rest of a question");
});
