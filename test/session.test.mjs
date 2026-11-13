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
