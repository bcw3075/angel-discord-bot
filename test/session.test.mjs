/* The whole flow of a session with stand-ins for Discord's voice channel, Deepgram and Claude: real Opus packets go
   in, and what Angel types and says comes out. */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session, echoOf, ACKS, summaryText } from "../src/session.mjs";
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

/* every session a test makes is ended after it, which frees its Opus decoders: opusscript's memory grows with each one
   kept, and past a point decoding fails quietly and speech counts as silence (2026-11-15, two later tests failing) */
const made = [];
afterEach(() => { for (const x of made.splice(0)) { try { x.end(); } catch { /* already ended */ } } });

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
  made.push(s);
  return { s, voice, posted, gates, asked };
}

const speech = (voice, userId, seconds = 1, at = Date.now()) => voice.emit("speech", { userId, packets: tonePackets(seconds), startedAt: at, final: true });
const settle = async () => { for (let i = 0; i < 20; i++) await sleep(5); };

test("a spoken question is checked, answered in the channel and spoken aloud", async () => {
  const { s, voice, posted, gates, asked } = setup({ heard: ["Angel, what does grabbed do?"], gate: () => ({ toAngel: true, complete: true, stop: false, question: "What does the grabbed condition do?", ack: "Grabbed, a classic. Checking." }) });
  await s.start();
  speech(voice, "p1");
  await settle(); await s.answering;
  assert.equal(gates.length, 1);
  assert.equal(gates[0].lastText, "Mira: Angel, what does grabbed do?");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].question, "Angel, what does grabbed do?", "the answer is worked out from their own words");
  assert.equal(asked[0].meaning, "What does the grabbed condition do?", "the check's reading goes along as a hint");
  assert.equal(asked[0].via, "voice");
  assert.match(asked[0].conversation, /Mira: Angel, what does grabbed do\?/, "the conversation goes with the question");
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /Looking it up/, "a placeholder at once");
  assert.match(posted[0].edits[0], /^\*\*Mira asked:\*\* What does the grabbed condition do\?\nAnswer to: .*\n-# \[Grabbed\]/);
  assert.deepEqual(voice.spoken.map(String), ["clip:Grabbed, a classic. Checking.", "clip:Answer to: Angel, what does grabbed do?"], "her own quick reaction from the check, then the answer");
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
  const heard = ["Angel, how are you feeling having a voice?", "That's funny. Good. You were listening.", "Pass me the dice.", "Ha, nice.", "One more.", "And another.", "Too many."];
  const { s, voice, posted, gates } = setup({ heard, gate: a => /dice/.test(a.lastText) ? { toAngel: false } : { toAngel: true, complete: true, stop: false, chat: true, question: a.bareText } });
  s.answer = async q => ({ say: `Answer to: ${q.question}`, sources: [], lookups: 0, dollars: 0.01 });
  await s.start();
  speech(voice, "p1");
  await settle(); await s.answering; await settle();
  assert.equal(posted.length, 0, "small talk isn't posted in the channel");
  assert.deepEqual(voice.spoken.map(String), ["clip:Answer to: Angel, how are you feeling having a voice?"], "no 'let me check' for small talk");
  assert.equal(s.replyTo.userId, "p1", "the window opens once she has finished");
  // her reply without her name, same person, after she finished: checked and answered
  speech(voice, "p1");
  await settle(); await s.answering; await settle();
  assert.equal(gates.length, 2, "the reply went to the check");
  assert.equal(gates[0].replying, false);
  assert.equal(gates[1].replying, true, "the check is told it's a follow-up");
  assert.equal(voice.spoken.length, 2, "and she answered it");
  // someone else without her name: not even checked
  speech(voice, "p2");
  await settle(); await s.answering;
  assert.equal(gates.length, 2, "another player's line isn't checked");
  // speech that began before her answer ended doesn't count as a reply
  speech(voice, "p1", 1, s.replyTo.from - 1000);
  await settle(); await s.answering;
  assert.equal(gates.length, 2, "said before she finished: not a reply");
  // at most three unnamed replies in a row: the fourth needs her name
  for (let i = 0; i < 3; i++) { speech(voice, "p1"); await settle(); await s.answering; await settle(); }
  assert.equal(gates.length, 4, "two more replies checked, then the window stays shut");
  // "Angel, stop" closes the window
  s.replyTo = { userId: "p1", from: Date.now(), turn: 0 };
  s.stop();
  assert.equal(s.replyTo, null);
});

test("rules follow-ups without her name never use up the reply window; only small talk counts (Rhea, 2026-11-15)", async () => {
  // her live round: a named question, then "Okay. How does weakness...", "Can you elaborate?", "Yes please", then
  // "How hard was it to look all that up?" (small talk) was left unanswered under the old count of three
  const heard = ["Angel, does leftover resistance carry over?", "And weakness?", "Can you elaborate?", "Yes please", "How hard was that to look up?", "Ha, fair.", "One more.", "Too many."];
  const { s, voice, gates } = setup({ heard, gate: a => (/look up|Ha|more|many/.test(a.lastText) ? { toAngel: true, complete: true, stop: false, chat: true, question: a.bareText } : { toAngel: true, complete: true, stop: false, question: a.bareText }) });
  const told = [];
  s.answer = async q => { told.push(q.lastReply === true); return { say: `Answer to: ${q.question}`, sources: [], lookups: /look up|Ha|more|many/.test(q.question) ? 0 : 1, dollars: 0.01 }; };
  await s.start();
  for (let i = 0; i < 8; i++) { speech(voice, "p1"); await settle(); await s.answering; await settle(); }
  assert.equal(gates.length, 7, "the named question, three rules follow-ups and three small-talk replies are checked; the eighth line is not");
  assert.equal(voice.spoken.filter(c => String(c).startsWith("clip:Answer to: How hard")).length, 1, "the small-talk question after three rules follow-ups is answered");
  assert.equal(s.replyTo, null, "three small-talk replies in a row close the window");
  assert.deepEqual(told, [false, false, false, false, false, false, true], "only the reply that closes the window is told to say so, in her own words (Rhea, 2026-11-15: no stock line)");
});

test("review 8: a named question in two parts counts as named, with its own count; a failed small-talk answer doesn't count", async () => {
  // another player's window is open at two small-talk replies; Mira names her in a first part the check calls unfinished
  const { s, voice, gates, asked } = setup({ heard: ["Angel, um", "how are you doing today?"], gate: a => (/um$/.test(a.lastText) ? { toAngel: true, complete: false, stop: false, question: "" } : { toAngel: true, complete: true, stop: false, chat: true, question: "how are you?" }) });
  s.answer = async q => { asked.push(q); return { say: `Answer to: ${q.question}`, sources: [], lookups: 0, dollars: 0.01 }; };
  await s.start();
  s.replyTo = { userId: "p9", from: Date.now(), turn: 2 };
  speech(voice, "p1"); await settle();
  speech(voice, "p1"); await settle(); await s.answering; await settle();
  assert.equal(gates.length, 2);
  assert.equal(gates[1].replying, false, "told it is a named question, not a reply");
  assert.equal(asked.at(-1)?.lastReply, false, "not told to ask for her name: she was named");
  assert.equal(s.replyTo?.userId, "p1", "and her own reply window opens");
  assert.equal(s.replyTo.turn, 0, "with the count started again");
  // an unnamed line taken as the rest of this speaker's waiting line counts from their own window, not another player's
  const c = setup({ heard: ["how are you doing?"], gate: () => ({ toAngel: true, complete: true, stop: false, chat: true, question: "how are you?" }) });
  const cAsked = [];
  c.s.answer = async q => { cAsked.push(q); return { say: `Answer to: ${q.question}`, sources: [], lookups: 0, dollars: 0.01 }; };
  await c.s.start();
  c.s.replyTo = { userId: "p9", from: Date.now(), turn: 2 };
  c.s.pending.set("p1", { text: "so", at: Date.now(), timer: null, byName: false });
  speech(c.voice, "p1"); await settle(); await c.s.answering; await settle();
  assert.equal(cAsked.at(-1)?.lastReply, false, "another player's count isn't hers");
  assert.equal(c.s.replyTo?.userId, "p1");
  // a small-talk reply whose answer fails doesn't use one up, so the window doesn't close silently on it
  const b = setup({ heard: ["one more thing"], gate: () => ({ toAngel: true, complete: true, stop: false, chat: true, question: "one more thing" }) });
  b.s.answer = async () => { throw new Error("overloaded"); };
  await b.s.start();
  b.s.replyTo = { userId: "p1", from: Date.now() - 10, turn: 2 };
  speech(b.voice, "p1", 1, Date.now()); await settle(); await b.s.answering; await settle();
  assert.equal(b.s.replyTo?.turn, 2, "the failed answer isn't counted");
});

test("review 9: the third small-talk reply closes the window even when her voice failed, or when only the written part failed", async () => {
  const a = setup({ heard: ["ha, fair"], gate: () => ({ toAngel: true, complete: true, stop: false, chat: true, question: "ha" }) });
  a.s.tts = async () => { throw new Error("Deepgram is down"); };
  a.s.answer = async () => ({ say: "Ha. Use my name next time, I'll be around.", sources: [], lookups: 0, dollars: 0.01 });
  await a.s.start();
  a.s.replyTo = { userId: "p1", from: Date.now() - 10, turn: 2 };
  speech(a.voice, "p1", 1, Date.now()); await settle(); await a.s.answering; await settle();
  assert.equal(a.s.replyTo, null, "closed though nothing was spoken");
  const b = setup({ heard: ["ha, fair"], gate: () => ({ toAngel: true, complete: true, stop: false, chat: true, question: "ha" }) });
  b.s.answer = async q => { q.onSay?.("Ha, fair. Grab me by name next time.", { end: true }); throw new Error("the written part broke off"); };
  await b.s.start();
  b.s.replyTo = { userId: "p1", from: Date.now() - 10, turn: 2 };
  speech(b.voice, "p1", 1, Date.now()); await settle(); await b.s.answering; await settle();
  assert.ok(b.voice.spoken.some(c => /Grab me by name/.test(String(c))), "all she had to say was spoken");
  assert.equal(b.s.replyTo, null, "so it counts and the window closes, as she said");
});

test("the log gives the gaps between the clips of a spoken answer (Rhea, 2026-11-15: a choppy-sounding answer)", async () => {
  const lines = [];
  const { s, voice } = setup({ heard: ["Angel, can I grapple?"], gate: () => ({ toAngel: true, complete: true, stop: false, question: "Can I grapple?" }) });
  s.log = { info: m => lines.push(m), warn() {}, error() {}, debug() {} };
  // only the answer's own clips (the ones with onStart) are timed here; each lasts 1 s and the next starts 0.25 s later
  voice.periods = [];
  let clock = 0;
  voice.speak = (clips, { onStart } = {}) => {
    if (onStart) { onStart(); clock = Math.max(clock, Date.now()); voice.periods.push([clock, clock + 1000]); clock += 1250; }
    // the next answer's first clip, already playing when this answer's timing line is written (review 8)
    if (voice.periods.length === 2) voice.periods.push([clock + 5000, clock + 6000]);
    return Promise.resolve();
  };
  s.answer = async ({ onSay }) => { onSay?.("First sentence here. "); onSay?.("Second one.", { end: true }); return { say: "First sentence here. Second one.", sources: [], lookups: 1, dollars: 0.01 }; };
  await s.start();
  speech(voice, "p1");
  await settle(); await s.answering; await settle();
  const timing = lines.find(m => m.startsWith("timing for"));
  assert.match(timing ?? "", /2 clips, gaps between them 0\.25 s(?!, )/, "the timing line lists the gap");
});

test("small talk that looked something up, or wasn't spoken, is posted after all", async () => {
  const { s, voice, posted } = setup({ heard: ["Angel, fun fact?"], gate: () => ({ toAngel: true, complete: true, stop: false, chat: true, question: "fun fact?" }) });
  s.answer = async () => ({ say: "Grabbed makes you off-guard.", details: "Grabbed: off-guard and immobilized.", sources: [{ name: "Grabbed", url: "https://2e.aonprd.com/Conditions.aspx?ID=77" }], lookups: 1, dollars: 0.01 });
  await s.start();
  speech(voice, "p1");
  await settle(); await s.answering;
  assert.equal(posted.length, 1, "a rules answer the check called small talk is still posted");
  const b = setup({ heard: ["Angel, hi!"], gate: () => ({ toAngel: true, complete: true, stop: false, chat: true, question: "hi" }) });
  b.s.tts = async () => { throw new Error("Deepgram answered 500"); };
  await b.s.start();
  speech(b.voice, "p1");
  await settle(); await b.s.answering;
  assert.equal(b.posted.length, 1, "small talk she couldn't say is posted instead");
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
  assert.equal(asked[0].question, "Angel? can I grapple twice in one turn?");
  assert.equal(asked[0].meaning, "Can I Grapple twice in one turn?");
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
  // another player's question waits its turn (the same person's would be answered with the first: see "said more")
  speech(voice, "p2"); await settle();
  assert.equal(posted.length, 1, "the second waits its turn");
  speech(voice, "p1"); await settle();
  assert.equal(voice.stops, 1);
  release(); await settle(); await s.answering;
  assert.match(posted[0].edits[0], /Answer to: Angel, what's grabbed\?/, "the first answer is still typed");
  assert.equal(voice.spoken.length, 1, "only her quick reaction, the answer not spoken");
  assert.ok(ACKS.includes(String(voice.spoken[0]).replace("clip:", "")), "no reaction from the check: one of the varied lines");
  assert.equal(posted.length, 1, "the queued question was dropped, not answered");
});

test("the same person says more before she begins her reply: one reply to all of it (Rhea, 2026-11-15)", async () => {
  // her live round: "Interesting." then, 3 s later, "How hard is it for you to search?" got two replies
  const releases = [];
  const { s, voice, posted, asked } = setup({ heard: ["Angel, interesting.", "How hard is it for you to search?"], gate: ({ bareText }) => ({ toAngel: true, complete: true, stop: false, chat: true, question: bareText }) });
  // the dropped reply goes on being written in the background: none of it may be spoken
  s.answer = q => { asked.push(q); return new Promise(r => releases.push(() => { q.onSay?.(`Answer to: ${q.question}`, { end: true }); r({ say: `Answer to: ${q.question}`, sources: [], lookups: 0, dollars: 0.01 }); })); };
  await s.start();
  speech(voice, "p1"); await settle();
  s.replyTo = { userId: "p1", from: Date.now() - 10, turn: 0 };
  speech(voice, "p1", 1, Date.now()); await settle();
  assert.equal(asked.length, 2, "the fuller question is worked out at once, without waiting for the dropped one");
  assert.equal(asked[1].question, "Angel, interesting. How hard is it for you to search?", "with everything they said");
  releases[1](); await settle(); releases[0](); await settle(); await s.answering; await settle();
  assert.equal(voice.spoken.map(c => String(c).replace("clip:", "")).join(" "), "Answer to: Angel, interesting. How hard is it for you to search?", "one reply, the dropped one never spoken");
  assert.equal(posted.length, 0, "small talk: nothing posted");
  assert.equal(s.status().merged, 1);
  assert.ok(s.costs.claude >= 0.02, "the dropped reply's cost still counts");
  assert.equal(s.transcript.lines.filter(l => l.kind === "angel").length, 1, "one reply in the transcript");
});

test("said more once she has begun speaking: the new line waits its turn and gets its own reply", async () => {
  const { s, voice, asked } = setup({ heard: ["Angel, what does grabbed do?", "And restrained?"], gate: ({ bareText }) => ({ toAngel: true, complete: true, stop: false, question: bareText }) });
  let release;
  s.answer = q => { asked.push(q); if (asked.length > 1) return Promise.resolve({ say: `Answer to: ${q.question}`, sources: [], lookups: 1, dollars: 0.01 });
    q.onSay?.("Grabbed makes you off-guard. "); return new Promise(r => { release = () => r({ say: "Grabbed makes you off-guard. And immobilized.", sources: [], lookups: 1, dollars: 0.01 }); }); };
  await s.start();
  speech(voice, "p1"); await settle();
  s.replyTo = { userId: "p1", from: Date.now() - 10, turn: 0 };
  speech(voice, "p1", 1, Date.now()); await settle();
  release(); await settle(); await s.answering; await settle(); await s.answering;
  assert.equal(asked.length, 2);
  assert.equal(asked[1].question, "And restrained?", "not merged: she had begun");
  assert.ok(voice.spoken.some(c => /Answer to: And restrained/.test(String(c))), "and answered after");
  assert.equal(s.status().merged, 0);
});

test("a rules reply dropped for a fuller question takes its 'looking it up' post away and gives no second quick reaction", async () => {
  const releases = [];
  const deleted = [];
  const { s, voice, posted, asked } = setup({ heard: ["Angel, what does grabbed do?", "Angel, and restrained?"], gate: ({ bareText }) => ({ toAngel: true, complete: true, stop: false, question: bareText, ack: "On it." }) });
  s.post = { send: async text => { const m = { text, edits: [], edit: async t => { m.edits.push(t); }, delete: async () => { deleted.push(text); } }; posted.push(m); return m; } };
  s.answer = q => { asked.push(q); return new Promise(r => releases.push(() => r({ say: `Answer to: ${q.question}`, details: "d", sources: [], lookups: 1, dollars: 0.01 }))); };
  await s.start();
  speech(voice, "p1"); await settle();
  speech(voice, "p1"); await settle();
  releases[1](); await settle(); releases[0](); await settle(); await s.answering; await settle();
  assert.equal(deleted.length, 1, "the first placeholder is taken away");
  assert.equal(voice.spoken.filter(c => !/^clip:Answer to/.test(String(c))).length, 1, "her quick reaction once, not twice");
  assert.match(posted.at(-1).edits[0], /^\*\*Mira asked:\*\* Angel, what does grabbed do\? Angel, and restrained\?\n/, "one post, for all of it");
  assert.equal(asked.at(-1).question, "Angel, what does grabbed do? Angel, and restrained?");
});

test("review 10: three lines merged give one quick reaction; an answer in hand is never dropped; a stop after the first line cancels the merge; no merge over the cap", async () => {
  // three lines before she begins: her quick reaction once
  {
    const releases = [];
    const { s, voice, asked } = setup({ heard: ["Angel, what's grabbed?", "Angel, and restrained?", "Angel, and paralyzed?"], gate: ({ bareText }) => ({ toAngel: true, complete: true, stop: false, question: bareText, ack: "On it." }) });
    s.answer = q => { asked.push(q); return new Promise(r => releases.push(() => r({ say: `Answer to: ${q.question}`, details: "d", sources: [], lookups: 1, dollars: 0.01 }))); };
    await s.start();
    for (let i = 0; i < 3; i++) { speech(voice, "p1"); await settle(); }
    assert.equal(asked.at(-1).question, "Angel, what's grabbed? Angel, and restrained? Angel, and paralyzed?");
    releases.forEach(r => r()); await settle(); await s.answering; await settle();
    assert.equal(voice.spoken.filter(c => !/^clip:Answer to/.test(String(c))).length, 1, "one quick reaction for all three");
  }
  // voice off: once the answer is in hand (its post still going out), a new line is not merged into it
  {
    let editing;
    const { s, voice, posted, asked } = setup({ heard: ["Angel, what's grabbed?", "Angel, and restrained?"], gate: ({ bareText }) => ({ toAngel: true, complete: true, stop: false, question: bareText }), cfg: { speak: false } });
    s.post = { send: async text => { const m = { text, edits: [], edit: t => new Promise(r => { editing = () => { m.edits.push(t); r(); }; }) }; posted.push(m); return m; } };
    s.answer = async q => { asked.push(q); return { say: `Answer to: ${q.question}`, details: `Answer to: ${q.question}`, sources: [], lookups: 1, dollars: 0.01 }; };
    await s.start();
    speech(voice, "p1"); await settle();
    speech(voice, "p1"); await settle();
    editing(); await settle(); editing(); await settle(); await s.answering;
    assert.equal(asked.length, 2);
    assert.equal(asked[1].question, "Angel, and restrained?", "not merged: the first answer was already in hand");
    assert.equal(s.status().merged, 0);
  }
  // a stop said after the first line (heard only after the second was merged) cancels all of it
  {
    const releases = [];
    const { s, voice, asked } = setup({ heard: ["Angel, what's grabbed?", "Angel, and restrained?"], gate: ({ bareText }) => ({ toAngel: true, complete: true, stop: false, question: bareText }) });
    s.answer = q => { asked.push(q); return new Promise(r => releases.push(() => r({ say: `Answer to: ${q.question}`, sources: [], lookups: 1, dollars: 0.01 }))); };
    await s.start();
    const t = Date.now();
    speech(voice, "p1", 1, t); await settle();
    speech(voice, "p1", 1, t + 4000); await settle();
    s.stop(t + 2000);
    releases.forEach(r => r()); await settle(); await s.answering; await settle();
    assert.equal(voice.spoken.filter(c => /Answer to/.test(String(c))).length, 0, "nothing of either is spoken");
  }
  // the new line comes in the very moment the first answer arrives: the first is still dropped, not posted
  {
    const releases = [];
    const { s, voice, posted, asked } = setup({ heard: ["Angel, what's grabbed?"], gate: ({ bareText }) => ({ toAngel: true, complete: true, stop: false, question: bareText }) });
    s.answer = q => { asked.push(q); return new Promise(r => releases.push(() => r({ say: `Answer to: ${q.question}`, details: `Answer to: ${q.question}`, sources: [], lookups: 1, dollars: 0.01 }))); };
    await s.start();
    speech(voice, "p1"); await settle();
    releases[0]();
    s.ask({ question: "Angel, and restrained?", asker: "Mira", via: "voice", userId: "p1", at: Date.now() });
    await settle(); releases[1](); await settle(); await s.answering; await settle();
    assert.equal(posted.filter(m => m.edits.some(e => /Answer to: Angel, what's grabbed\?\s*$/.test(e))).length, 0, "the first answer alone is not posted");
    assert.ok(posted.some(m => m.edits.some(e => e.includes("Answer to: Angel, what's grabbed? Angel, and restrained?"))), "the merged one is");
  }
  // over the cap when the line is added: the first question keeps its answer
  {
    const releases = [];
    const { s, voice, asked, posted } = setup({ heard: ["Angel, what's grabbed?", "Angel, and restrained?"], gate: ({ bareText }) => ({ toAngel: true, complete: true, stop: false, question: bareText, dollars: 0.6 }), cfg: { maxSessionDollars: 1 } });
    s.answer = q => { asked.push(q); return new Promise(r => releases.push(() => r({ say: `Answer to: ${q.question}`, sources: [], lookups: 1, dollars: 0.01 }))); };
    await s.start();
    speech(voice, "p1"); await settle();
    speech(voice, "p1"); await settle();
    releases.forEach(r => r()); await settle(); await s.answering; await settle();
    assert.equal(s.status().merged, 0, "no merge past the cap");
    // past the cap she doesn't begin speaking (as before), but the first question's written answer still comes
    assert.ok(posted.some(m => (m.edits[0] ?? "").includes("Answer to: Angel, what's grabbed?")), "the first is still answered in writing");
  }
});

test("a stop only the check read into a line is logged and leaves the reply window open; \"Angel, stop\" closes it (live 2026-11-15)", async () => {
  // "Cut me off there." was read as a stop: her answer wasn't spoken and the lines after it went unheard
  const lines = [];
  const { s, voice, asked } = setup({ heard: ["Cut me off there.", "I'm curious how their power differs."], gate: ({ lastText }) => (/Cut me off/.test(lastText) ? { toAngel: true, complete: true, stop: true, chat: true, question: "" } : { toAngel: true, complete: true, stop: false, question: "How does their power differ?" }) });
  s.answer = async q => { asked.push(q); return { say: `Answer to: ${q.question}`, sources: [], lookups: 1, dollars: 0.01 }; };
  s.log = { info: m => lines.push(m), warn() {}, error() {}, debug() {} };
  await s.start();
  // the window from her last answer is nearly used up
  s.replyTo = { userId: "p1", from: Date.now() - s.cfg.replyWindowMs + 50, turn: 2 };
  speech(voice, "p1", 1, Date.now()); await settle(); await s.answering;
  assert.equal(voice.stops, 1, "she stops");
  assert.ok(lines.some(m => /read as "stop"/.test(m)), "and the log says why");
  assert.equal(s.replyTo?.userId, "p1", "the window stays open: a wrong reading doesn't end the conversation");
  assert.ok(s.replyTo.from >= Date.now() - 1000, "a fresh minute from now, not what was left");
  assert.equal(s.replyTo.turn, 2, "with the small-talk count kept");
  await sleep(80);
  speech(voice, "p1", 1, Date.now()); await settle(); await s.answering;
  assert.equal(asked.at(-1)?.question, "I'm curious how their power differs.", "her next line without the name is answered");
  // "okay, that's enough, thanks" read as not for her but a stop: from the person she is talking with, she still stops
  const c = setup({ heard: ["Okay that's enough, thanks."], gate: () => ({ toAngel: false, complete: true, stop: true, question: "" }) });
  await c.s.start();
  c.s.replyTo = { userId: "p1", from: Date.now() - 10, turn: 0 };
  speech(c.voice, "p1", 1, Date.now()); await settle(); await c.s.answering;
  assert.equal(c.voice.stops, 1, "she stops");
  // from someone she isn't talking with, a line the check calls not for her does nothing
  const d = setup({ heard: ["that's enough of that goblin"], gate: () => ({ toAngel: false, complete: true, stop: true, question: "" }) });
  await d.s.start();
  speech(d.voice, "p2", 1, Date.now()); await settle();
  assert.equal(d.voice.stops, 0);
  const b = setup({ heard: ["Angel, stop."] });
  const bl = [];
  b.s.log = { info: m => bl.push(m), warn() {}, error() {}, debug() {} };
  await b.s.start();
  b.s.replyTo = { userId: "p1", from: Date.now() - 10, turn: 0 };
  speech(b.voice, "p1", 1, Date.now()); await settle();
  assert.equal(b.s.replyTo, null, "her name and stop: the window closes");
  assert.ok(bl.some(m => /said stop/.test(m)));
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
  assert.equal(asked[0].question, "Angel, what does off-guard do? and does it stack?");
  assert.equal(asked[0].meaning, "What does off-guard do? and does it stack?");
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

test("a reply right after she stops isn't taken for her echo unless its words are hers (2026-11-14)", async () => {
  assert.equal(echoOf("No, it doesn't stack with other circumstance penalties", "No, it doesn't stack with other circumstance penalties. Only the worst applies."), true);
  assert.equal(echoOf("Nice. And does that stack with other circumstance penalties?", "Off-guard means you take a minus 2 circumstance penalty to AC."), false);
  const { s, voice, gates } = setup({ heard: ["Angel, what's off-guard?", "Nice. And does that stack?", "Off-guard means minus two"], gate: () => ({ toAngel: true, complete: true, stop: false, question: "q" }) });
  s.answer = async () => ({ say: "Off-guard means minus two to AC.", sources: [], lookups: 0, dollars: 0.01 });
  await s.start();
  speech(voice, "p1"); await settle(); await s.answering; await settle();
  voice.echo = true; /* both next lines begin just after she stopped */
  speech(voice, "p1"); await settle(); await s.answering; await settle();
  assert.equal(gates.length, 2, "the quick reply was checked");
  speech(voice, "p1"); await settle(); await s.answering;
  assert.equal(gates.length, 2, "her own words coming back were not");
});

/* an answer that is written slowly: `say` arrives in pieces through onSay, then the rest takes `tail` to finish */
const written = (say, { details = "**Written.**", piece = 9, tail = async () => {}, fail = null, extra = {}, end = false } = {}) => async q => {
  for (let i = 0; i < say.length; i += piece) { q.onSay?.(say.slice(i, i + piece)); await sleep(1); }
  if (end) q.onSay?.("", { end: true });
  await tail();
  if (fail) { const e = new Error(fail); e.dollars = 0.01; throw e; }
  return { say, details, sources: [], rounds: 2, lookups: 1, dollars: 0.02, ...extra };
};
const SAY = "Grabbed means off-guard and immobilized. Escape takes one action. Ask if you want the details.";

test("she starts speaking as soon as her first sentence is written; the post waits for the whole answer (Rhea, 2026-11-14)", async () => {
  const { s, voice, posted } = setup({ heard: ["Angel, what does grabbed do?"], gate: () => ({ toAngel: true, complete: true, stop: false, question: "What does grabbed do?", ack: "Ooh, grabbed." }) });
  let release, midway;
  s.answer = written(SAY, { tail: () => new Promise(r => { midway = { spoken: voice.spoken.map(String), edits: posted[0]?.edits.length, said: s.lastSaid }; release = r; }) });
  const infos = [];
  s.log.info = m => infos.push(m);
  await s.start();
  speech(voice, "p1");
  await settle();
  assert.deepEqual(midway.spoken, ["clip:Ooh, grabbed.", "clip:Grabbed means off-guard and immobilized.", "clip:Escape takes one action."], "her reaction, then each whole sentence, while the answer is still being written");
  assert.equal(midway.edits, 0, "the written answer isn't posted yet");
  assert.equal(midway.said, "Grabbed means off-guard and immobilized. Escape takes one action.", "what she is saying counts as hers for the echo check at once");
  release(); await settle(); await s.answering;
  assert.deepEqual(voice.spoken.map(String).slice(3), ["clip:Ask if you want the details."], "the last sentence once the answer is whole, and nothing twice");
  assert.match(posted[0].edits[0], /\*\*Written\.\*\*/);
  assert.equal(s.transcript.lines.at(-1).text, SAY, "the transcript has all she said, once");
  assert.equal(s.lastSaid, SAY);
  assert.ok(Math.abs(s.costs.tts - s.ttsCost("Ooh, grabbed." + SAY.replaceAll(". ", ".")) - s.ttsCost(DEFAULTS.ackPhrase)) < 1e-9, "each piece of voice is paid for once");
  assert.ok(infos.some(m => /timing for Mira's question: first words written \d+\.\d s, her answer began aloud .* whole answer written \d+\.\d s after it was taken up \(taken up -?\d+\.\d s after they stopped talking\); 2 round\(s\), 1 lookup\(s\)$/.test(m)), `the times go in the log: ${infos.join(" | ")}`);
  assert.ok(infos.some(m => /Mira can reply without her name/.test(m)), "the reply window opens after her answer");
});

test("the pieces are spoken in the order written, even when a later one is ready first", async () => {
  const { s, voice } = setup({ heard: ["Angel, what does grabbed do?"], cfg: { ackPhrase: "" } });
  s.tts = async text => { await sleep(/^Grabbed/.test(text) ? 40 : 1); return [Buffer.from(`clip:${text}`)]; };
  s.answer = written(SAY);
  await s.start();
  speech(voice, "p1");
  await settle(); await s.answering;
  assert.deepEqual(voice.spoken.map(String), ["clip:Grabbed means off-guard and immobilized.", "clip:Escape takes one action.", "clip:Ask if you want the details."]);
});

test('"Angel, stop" while she is speaking an answer still being written: the rest is not spoken, the answer is still typed', async () => {
  const { s, voice, posted } = setup({ heard: ["Angel, what does grabbed do?", "Angel, stop"], cfg: { ackPhrase: "" } });
  let release;
  s.answer = written(SAY, { piece: 45, tail: () => new Promise(r => { release = r; }) });
  await s.start();
  speech(voice, "p1"); await settle();
  assert.equal(voice.spoken.length, 2, "the first two sentences are out, the last is still to come");
  speech(voice, "p1"); await settle();
  assert.equal(voice.stops, 1);
  release(); await settle(); await s.answering;
  assert.equal(voice.spoken.length, 2, "nothing more after the stop");
  assert.match(posted[0].edits[0], /Written/, "the answer is still typed");
  assert.equal(s.replyTo ?? null, null, "no reply window after a stop");
});

test("an answer that fails after she began: what she said and the apology are both in the transcript", async () => {
  const { s, voice, posted } = setup({ heard: ["Angel, what does grabbed do?"], cfg: { ackPhrase: "" } });
  s.answer = written("Grabbed means off-guard and immobilized. And then", { fail: "Claude's reply broke off" });
  await s.start();
  speech(voice, "p1");
  await settle(); await s.answering;
  assert.deepEqual(voice.spoken.map(String), ["clip:Grabbed means off-guard and immobilized.", "clip:Sorry, I couldn't reach my rules brain just then. Give it a moment and ask me again?"]);
  assert.equal(s.transcript.lines.at(-1).text, "Grabbed means off-guard and immobilized. Sorry, I couldn't reach my rules brain just then. Give it a moment and ask me again?");
  assert.match(posted[0].edits[0], /Sorry/);
  assert.ok(Math.abs(s.costs.claude - 0.0101) < 1e-9, "the failed rounds are counted");
});

test("with speakAsWritten off, or an answer that isn't written piece by piece, she speaks it whole as before", async () => {
  let { s, voice } = setup({ heard: ["Angel, what does grabbed do?"], cfg: { ackPhrase: "", speakAsWritten: false } });
  let given;
  s.answer = async q => { given = q.onSay; return written(SAY)(q); };
  await s.start();
  speech(voice, "p1");
  await settle(); await s.answering;
  assert.equal(given, null, "nothing asks for the pieces");
  assert.deepEqual(voice.spoken.map(String), [`clip:${SAY}`]);
  ({ s, voice } = setup({ heard: ["Angel, what does grabbed do?"], cfg: { ackPhrase: "" } }));
  await s.start();
  speech(voice, "p1");
  await settle(); await s.answering;
  assert.deepEqual(voice.spoken.map(String), ["clip:Answer to: Angel, what does grabbed do?"], "an answer that came whole is spoken whole");
});

test("the reply window opens when her spoken answer ends, not when it was written", async () => {
  const { s, voice } = setup({ heard: ["Angel, what does grabbed do?"], cfg: { ackPhrase: "" } });
  const ends = [];
  voice.speak = function (clips, { onStart } = {}) { this.spoken.push(...clips); onStart?.(); return new Promise(r => ends.push(r)); };
  s.answer = written(SAY);
  await s.start();
  speech(voice, "p1");
  await settle(); await s.answering;
  assert.equal(voice.spoken.length, 3);
  assert.equal(s.replyTo ?? null, null, "written and queued, but she is still talking");
  ends[0](); ends[1](); await settle();
  assert.equal(s.replyTo ?? null, null, "the last sentence is still playing");
  ends[2](); await settle();
  assert.equal(s.replyTo?.userId, "p1");
});

test("the cap is asked before she begins an answer, never in the middle of one", async () => {
  const { s, voice, posted } = setup({ heard: ["Angel, what does grabbed do?", "Angel, and prone?"], cfg: { ackPhrase: "", maxSessionDollars: 0.021 } });
  s.answer = written(SAY, { tail: async () => { s.costs.claude += 1; } });
  await s.start();
  speech(voice, "p1");
  await settle(); await s.answering;
  assert.equal(voice.spoken.length, 3, "the answer she had begun is finished although the cap was passed while she wrote it");
  speech(voice, "p1");
  await settle(); await s.answering;
  assert.equal(voice.spoken.length, 3, "past the cap nothing more is spoken");
  assert.ok(posted.some(m => /spending cap/.test(m.text)), "and she says so");
});

test("small talk spoken as written is not posted; if her voice fails it is typed instead", async () => {
  let { s, voice, posted } = setup({ heard: ["Angel, how are you?"], gate: () => ({ toAngel: true, complete: true, stop: false, chat: true, question: "How are you?" }) });
  s.answer = written("Never better. I do love a good rules argument.", { extra: { lookups: 0 } });
  await s.start();
  speech(voice, "p1");
  await settle(); await s.answering;
  assert.deepEqual(voice.spoken.map(String), ["clip:Never better. I do love a good rules argument."], "a very short first sentence stays with the next");
  assert.equal(posted.length, 0);
  ({ s, voice, posted } = setup({ heard: ["Angel, how are you?"], gate: () => ({ toAngel: true, complete: true, stop: false, chat: true, question: "How are you?" }) }));
  s.tts = async () => { throw new Error("Deepgram is down"); };
  s.answer = written("Never better. I do love a good rules argument.", { extra: { lookups: 0 } });
  await s.start();
  speech(voice, "p1");
  await settle(); await s.answering;
  assert.equal(voice.spoken.length, 0);
  assert.equal(posted.length, 1, "typed, since it couldn't be spoken");
});

test('"Angel, stop" while a sentence is still being turned into voice: it is never played', async () => {
  const { s, voice } = setup({ heard: ["Angel, what does grabbed do?", "Angel, stop"], cfg: { ackPhrase: "" } });
  const making = [];
  s.tts = text => new Promise(r => making.push(() => r([Buffer.from(`clip:${text}`)])));
  s.answer = written(SAY);
  await s.start();
  speech(voice, "p1"); await settle();
  assert.ok(making.length >= 2, "sentences are on their way to the voice");
  speech(voice, "p1"); await settle();
  assert.equal(voice.stops, 1);
  for (const done of making) done();
  await settle(); await s.answering;
  assert.equal(voice.spoken.length, 0, "ready after the stop, so not played");
  assert.equal(s.replyTo ?? null, null);
});

test("her last sentence, or her only one, is spoken as soon as all she will say is written, not when the whole answer is", async () => {
  for (const say of ["It's a plus 2 circumstance bonus to AC.", "Yes. It gives a minus 2 penalty.", SAY]) {
    const { s, voice, posted } = setup({ heard: ["Angel, what does grabbed do?"], cfg: { ackPhrase: "" } });
    let release, midway;
    s.answer = written(say, { end: true, tail: async () => { await settle(); midway = voice.spoken.map(String).join(" ").replaceAll("clip:", ""); await new Promise(r => { release = r; }); } });
    await s.start();
    speech(voice, "p1");
    for (let i = 0; i < 40 && !release; i++) await settle();
    assert.equal(midway, say, "all of it is out while the written answer is still being written");
    assert.equal(posted[0].edits.length, 0);
    release(); await settle(); await s.answering;
    assert.equal(voice.spoken.map(String).join(" ").replaceAll("clip:", ""), say, "and nothing is said twice when the answer is whole");
  }
});

test("a say that holds nothing still gets her spoken apology; a stop pays for no more voice; a session that ends mid-answer says no more", async () => {
  let { s, voice } = setup({ heard: ["Angel, what does grabbed do?"], cfg: { ackPhrase: "" } });
  s.answer = async q => { q.onSay?.(" "); q.onSay?.("", { end: true }); return { say: "Sorry, I lost my train of thought there. Could you ask me again?", sources: [], dollars: 0.01 }; };
  await s.start();
  speech(voice, "p1");
  await settle(); await s.answering;
  assert.deepEqual(voice.spoken.map(String), ["clip:Sorry, I lost my train of thought there. Could you ask me again?"]);

  /* stopped while she writes: the sentences written after the stop are never sent to be made into voice */
  let made = 0, release;
  ({ s, voice } = setup({ heard: ["Angel, what does grabbed do?", "Angel, stop"], cfg: { ackPhrase: "" } }));
  s.tts = async text => { made++; return [Buffer.from(`clip:${text}`)]; };
  s.answer = async q => { q.onSay("Grabbed means off-guard and immobilized. "); await new Promise(r => { release = r; }); q.onSay("Escape takes one action. And more. "); q.onSay("", { end: true }); return { say: SAY, sources: [], dollars: 0.01 }; };
  await s.start();
  speech(voice, "p1"); await settle();
  assert.equal(made, 1);
  speech(voice, "p1"); await settle();
  release(); await settle(); await s.answering;
  assert.equal(made, 1, "nothing more is paid for after the stop");
  assert.equal(voice.spoken.length, 1);

  /* the session ends while she writes */
  made = 0; release = null;
  let posted;
  ({ s, voice, posted } = setup({ heard: ["Angel, what does grabbed do?"] }));
  s.tts = async text => { made++; return [Buffer.from(`clip:${text}`)]; };
  s.answer = async q => { q.onSay("Grabbed means off-guard and immobilized. "); await new Promise(r => { release = r; }); q.onSay("Escape takes one action. "); q.onSay("", { end: true }); return { say: SAY, details: "**Written.**", sources: [], dollars: 0.01 }; };
  await s.start();
  speech(voice, "p1"); await settle();
  const before = made, spokenBefore = voice.spoken.length;
  s.end();
  release(); await settle(); await s.answering;
  assert.equal(made, before, "no voice is made after the session ended");
  assert.equal(voice.spoken.length, spokenBefore);
  assert.match(posted[0].edits[0], /Written/, "the answer she had is still typed");
  assert.equal(s.replyTo ?? null, null);
});

test("an answer that breaks off after she said all of it: no apology on top, and the post says the written details are missing", async () => {
  const { s, voice, posted } = setup({ heard: ["Angel, what does grabbed do?"], cfg: { ackPhrase: "" } });
  s.answer = written(SAY, { end: true, fail: "Claude took longer than 45 s" });
  await s.start();
  speech(voice, "p1");
  await settle(); await s.answering;
  assert.equal(voice.spoken.map(String).join(" ").replaceAll("clip:", ""), SAY, "what she said, and no apology after it");
  assert.equal(s.transcript.lines.at(-1).text, SAY);
  assert.match(posted[0].edits[0], /Grabbed means off-guard[\s\S]*lost the written details/);
  assert.ok(s.replyTo, "she did answer, so they can reply");
});

test("one speaker's lines are taken in the order said, even when a later piece is transcribed first", async () => {
  const { s, voice, asked } = setup({ gate: ({ bareText }) => ({ toAngel: true, complete: /\?$/.test(bareText), stop: false, question: "" }) });
  /* the first half ("Angel, about grabbed") comes back from the transcriber after the second half */
  const texts = [["Angel, about grabbed", 60], ["can they still attack?", 1]];
  s.stt = async () => { const [text, ms] = texts.shift(); await sleep(ms); return { text, seconds: 1 }; };
  await s.start();
  const t = Date.now();
  speech(voice, "p1", 1, t);
  speech(voice, "p1", 1, t + 1500);
  for (let i = 0; i < 6; i++) await settle();
  await s.answering;
  assert.equal(asked.length, 1, "one question, not a lost second half and a first half left waiting");
  assert.equal(asked[0].question, "Angel, about grabbed can they still attack?");
  /* another speaker isn't held up by them */
  assert.equal(s.heardOrder.size, 0, "nothing is kept once the lines are handed over");
});

test("her last written answer goes along with the next question; a failed lookup is said in the post", async () => {
  const { s, voice, posted, asked } = setup({ heard: ["Angel, what does grabbed do?", "Angel, what about the second one?"], cfg: { ackPhrase: "" } });
  let n = 0;
  s.answer = async q => { asked.push(q); return n++ ? { say: "That one.", details: "**That one.**", sources: [], lookups: 1, failedLookups: 1, dollars: 0.01 } : { say: "Two things.", details: "**Two things.**\n- Off-guard\n- Immobilized", sources: [], lookups: 1, failedLookups: 0, dollars: 0.01 }; };
  await s.start();
  speech(voice, "p1"); await settle(); await s.answering;
  assert.doesNotMatch(asked[0].conversation, /last written answer/);
  assert.doesNotMatch(posted[0].edits[0], /couldn't reach Archives/);
  speech(voice, "p1"); await settle(); await s.answering;
  assert.match(asked[1].conversation, /Your last written answer in the text channel \(the table can see it\):\n\*\*Two things\.\*\*\n- Off-guard\n- Immobilized$/);
  assert.match(posted[1].edits[0], /couldn't reach Archives of Nethys for part of this/);
});

test('"Angel, stop. What does stunned do?": the question goes on without the stop in it; a stop is heard even while an earlier piece is still being transcribed', async () => {
  let { s, voice, asked } = setup({ heard: ["Angel, stop. What does stunned do?"], gate: () => ({ toAngel: true, complete: true, stop: true, question: "What does stunned do?" }) });
  await s.start();
  speech(voice, "p1"); await settle(); await s.answering;
  assert.equal(voice.stops, 1);
  assert.equal(asked[0].question, "What does stunned do?", "their own words from after the stop, which is already done");
  assert.equal(asked[0].meaning, "What does stunned do?");
  /* the first piece's transcription hangs; "Angel, stop" said after it is acted on at once, and once */
  let slow;
  ({ s, voice, asked } = setup({}));
  const texts = [new Promise(r => { slow = () => r({ text: "so anyway the ogre", seconds: 1 }); }), Promise.resolve({ text: "Angel, stop", seconds: 1 })];
  s.stt = () => texts.shift();
  await s.start();
  const t = Date.now();
  speech(voice, "p1", 1, t); speech(voice, "p1", 1, t + 1500);
  await settle();
  assert.equal(voice.stops, 1, "stopped while the earlier piece is still out");
  slow(); await settle();
  assert.equal(voice.stops, 1, "and not a second time when its turn comes");
  assert.equal(s.transcript.lines.length, 2, "both lines are in the transcript");
});

test("only a checked rules answer is kept as her last written answer", async () => {
  const { s, voice, asked } = setup({ heard: ["Angel, one?", "Angel, two?", "Angel, three?", "Angel, four?"], cfg: { ackPhrase: "", speak: false }, gate: ({ bareText }) => ({ toAngel: true, complete: true, stop: false, chat: /two/.test(bareText), question: bareText }) });
  const replies = [{ say: "A.", details: "**Unchecked.**", sources: [], lookups: 1, failedLookups: 1, dollars: 0 }, { say: "B.", details: "**Chatter.**", sources: [], lookups: 1, failedLookups: 0, dollars: 0 }, { say: "Lost.", details: "Lost.", sources: [], lookups: 0, dollars: 0 }, { say: "C.", details: "**C.**", sources: [], lookups: 2, dollars: 0 }];
  s.answer = async q => { asked.push(q); return replies.shift(); };
  await s.start();
  for (let i = 0; i < 4; i++) { speech(voice, "p1"); await settle(); await s.answering; }
  assert.doesNotMatch(asked[3].conversation, /last written answer/, "nor an answer that looked nothing up (her fallback line)");
  assert.doesNotMatch(asked[1].conversation, /last written answer/, "one a lookup failed for is not handed back as her answer");
  assert.doesNotMatch(asked[2].conversation, /last written answer/, "nor is small talk");
  assert.equal(s.lastWritten.text, "**C.**");
});

test("an answer cut off part way through what she was saying: she says so, the post says so, and it isn't kept as her last answer", async () => {
  const { s, voice, posted } = setup({ heard: ["Angel, can I strike twice?"], cfg: { ackPhrase: "" } });
  s.answer = async q => { q.onSay("You can Strike twice. But only if "); return { say: "You can Strike twice. But only if", details: "You can Strike twice. But only if", cut: true, sources: [], lookups: 1, dollars: 0.01 }; };
  await s.start();
  speech(voice, "p1"); await settle(); await s.answering;
  assert.deepEqual(voice.spoken.map(String), ["clip:You can Strike twice.", "clip:But only if", "clip:Sorry, I got cut off there. Ask me again?"]);
  assert.match(posted[0].edits[0], /But only if …\n-# \(I got cut off part way through this answer\. Ask me again\.\)/);
  assert.match(s.transcript.lines.at(-1).text, /But only if … Sorry, I got cut off there/);
  assert.equal(s.lastWritten, null);
});

test("an answer whose written part was lost is posted with a note and not kept; with speaking off nothing is asked for piece by piece", async () => {
  let { s, voice, posted } = setup({ heard: ["Angel, can I grapple?"], cfg: { ackPhrase: "" } });
  s.answer = async q => { q.onSay("Only with a free hand. "); q.onSay("", { end: true }); return { say: "Only with a free hand.", details: "Only with a free hand.", detailsLost: true, sources: [], lookups: 1, dollars: 0.01 }; };
  await s.start();
  speech(voice, "p1"); await settle(); await s.answering;
  assert.deepEqual(voice.spoken.map(String), ["clip:Only with a free hand."]);
  assert.match(posted[0].edits[0], /Only with a free hand\.\n-# \(I lost the written details/);
  assert.equal(s.lastWritten, null);
  let given = "unset";
  ({ s, voice, posted } = setup({ heard: ["Angel, can I grapple?"], cfg: { speak: false } }));
  s.answer = async q => { given = q.onSay; return { say: "Yes.", sources: [], dollars: 0.01 }; };
  await s.start();
  speech(voice, "p1"); await settle(); await s.answering;
  assert.equal(given, null, "so a reply cut off can still be asked again");
});

test("a long question cut into pieces while they are still talking is not checked or answered until they finish (live 2026-11-14)", async () => {
  const { s, voice, gates, asked } = setup({ heard: ["Angel, thanks. I'd like you to look up how the reaction works when the hit has multiple different damage", "types. Like fire, lightning and acid.", "How does the damage reduction apply to that attack?"], gate: ({ bareText }) => ({ toAngel: true, complete: true, stop: false, question: "" }) });
  const infos = [];
  s.log.info = m => infos.push(m);
  await s.start();
  const t = Date.now();
  /* the first two pieces were cut at the 30-second limit: the speaker went on talking */
  voice.emit("speech", { userId: "p1", packets: tonePackets(1), startedAt: t, final: false });
  await settle();
  assert.equal(gates.length, 0, "no check on a piece that isn't the whole question");
  assert.equal(asked.length, 0, "and no answer over the top of them");
  assert.ok(infos.some(m => /Mira is still talking: waiting for the rest/.test(m)));
  voice.emit("speech", { userId: "p1", packets: tonePackets(1), startedAt: t + 30000, final: false });
  await settle();
  assert.equal(gates.length, 0);
  voice.emit("speech", { userId: "p1", packets: tonePackets(1), startedAt: t + 60000, final: true });
  await settle(); await s.answering;
  assert.equal(gates.length, 1, "one check, on the whole of it");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].question, "Angel, thanks. I'd like you to look up how the reaction works when the hit has multiple different damage types. Like fire, lightning and acid. How does the damage reduction apply to that attack?");
  /* a long piece that doesn't name her is only transcript, cut or not */
  const other = setup({ heard: ["and so the dragon said to the knight"] });
  await other.s.start();
  other.voice.emit("speech", { userId: "p1", packets: tonePackets(1), startedAt: Date.now(), final: false });
  await settle();
  assert.equal(other.s.pending.size, 0);
});

test("a held long question whose rest is too short to hear is checked and answered, not dropped (review 7)", async () => {
  const { s, voice, gates, asked } = setup({ heard: ["Angel, I'd like to know how resistance works against fire and cold?", ""], cfg: { maxUtteranceSeconds: 5, followUpMs: 1000 } });
  await s.start();
  const t = Date.now();
  voice.emit("speech", { userId: "p1", packets: tonePackets(1), startedAt: t, final: false });
  await settle();
  voice.emit("speech", { userId: "p1", packets: tonePackets(0.2), startedAt: t + 5000, final: true });
  await settle(); await s.answering;
  assert.equal(gates.length, 1, "checked once");
  assert.equal(asked.length, 1, "and answered");
  assert.equal(s.pending.size, 0);
  s.end();
});

test("a stop said during the first piece of a long question cancels it (review 7)", async () => {
  const { s, voice, asked } = setup({ heard: ["Angel, how does resistance work with", "several damage types?"] });
  await s.start();
  const t = Date.now() - 40000;
  voice.emit("speech", { userId: "p1", packets: tonePackets(1), startedAt: t, final: false });
  s.stop(t + 10000);
  await settle();
  voice.emit("speech", { userId: "p1", packets: tonePackets(1), startedAt: t + 30000, final: true });
  await settle(); await s.answering;
  assert.equal(asked.length, 0);
  s.end();
});

test("a named question said in two pieces counts as named, not as a reply (review 7)", async () => {
  const { s, voice, gates } = setup({ heard: ["Angel, how does resistance work with", "several damage types?"] });
  await s.start();
  const t = Date.now();
  voice.emit("speech", { userId: "p1", packets: tonePackets(1), startedAt: t, final: false });
  await settle();
  voice.emit("speech", { userId: "p1", packets: tonePackets(1), startedAt: t + 30000, final: true });
  await settle(); await s.answering;
  assert.equal(gates.at(-1).replying, false, "the check for a named question");
  assert.equal(s.replyTo?.turn, 0, "her name was said: the reply count starts again");
  s.end();
});
