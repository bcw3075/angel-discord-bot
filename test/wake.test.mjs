import { test } from "node:test";
import assert from "node:assert/strict";
import { GATE_SYSTEM, FOLLOWUP_SYSTEM, mentionsAngel, isStopRequest, parseGate, gate, gateUser, afterStop, parseHold, holdCheck, holdUser, HOLD_SYSTEM, cleanReady, readyLine, READY_SYSTEM } from "../src/wake.mjs";
import { Claude } from "../src/claude.mjs";
import { scriptedFetch } from "./helpers.mjs";

test("her name and the transcriber's usual misspellings count; other words don't", () => {
  for (const t of ["Angel, what does off-guard do?", "hey angela can I", "Angie?", "at an angle", "Angel's right", "so... ANGEL"]) assert.ok(mentionsAngel(t), t);
  for (const t of ["angelic heritage", "the angels sing", "evangelist", "danger", "change"]) assert.ok(!mentionsAngel(t), t);
});

test('"Angel, stop" and friends are caught without the model', () => {
  for (const t of ["Angel, stop", "angel stop", "Angel please stop", "Angel, that's enough", "Angela, be quiet", "Angel never mind"]) assert.ok(isStopRequest(t), t);
  for (const t of ["stop", "Angel, what stops a grab?", "the angel statue", "Angel, can I stop moving halfway?"]) assert.ok(!isStopRequest(t), t);
});

test("the model's answer is read, even inside a code fence", () => {
  assert.deepEqual(parseGate('{"to_angel": true, "complete": true, "stop": false, "question": "What is off-guard?"}'),
    { toAngel: true, complete: true, stop: false, chat: false, ack: "", question: "What is off-guard?", fallback: false });
  assert.equal(parseGate('{"to_angel": true, "ack": "Stacking, my favourite headache."}').ack, "Stacking, my favourite headache.");
  assert.equal(parseGate('{"to_angel": true, "complete": true, "stop": false, "chat": true, "question": "Thanks!"}').chat, true, "small talk is marked");
  assert.match(GATE_SYSTEM, /answers or reacts to what she said/, "a reply to her counts without her name");
  assert.match(GATE_SYSTEM, /starts with one and then asks something/, "\"Okay. Good. What about stacking?\" is for her (2026-11-14)");
  assert.match(gateUser("x", "Rhea: Okay. What about stacking?", true), /just answered this person/);
  assert.doesNotMatch(gateUser("x", "Rhea: hi"), /just answered/);
  assert.match(FOLLOWUP_SYSTEM, /Lean to yes/, "a follow-up is judged by a check that leans to yes");
  assert.equal(parseGate('```json\n{"to_angel": false, "complete": true, "stop": false, "question": ""}\n```').toAngel, false);
  assert.equal(parseGate('{"to_angel": true, "complete": false, "stop": false, "question": ""}').complete, false);
});

test("an unreadable answer falls back to the plain rule: her name first, then a request", () => {
  assert.equal(parseGate("garbled", "Angel, can I grab him?").toAngel, true);
  assert.equal(parseGate("garbled", "Hey Angel how does flanking work").toAngel, true);
  assert.equal(parseGate("garbled", "the angel statue glows").toAngel, false);
  assert.equal(parseGate("", "Angel?").toAngel, false, "just the name is not yet a request");
});

test("the check calls the gate model once and counts its own cost", async () => {
  const fetchImpl = scriptedFetch([{ body: { content: [{ type: "text", text: '{"to_angel": true, "complete": true, "stop": false, "question": "Can I Grapple?"}' }], usage: { input_tokens: 1000, output_tokens: 20 } } }]);
  const claude = new Claude({ apiKey: "k", prices: { h: [0.1, 0.125, 0.01, 0.5] }, fetchImpl });
  const d = await gate({ claude, model: "h", contextText: "[19:00:00] Dana (GM): It grabs you.", lastText: "Mira: Angel, can I grapple it back?" });
  assert.equal(d.toAngel, true);
  assert.ok(Math.abs(d.dollars - (1000 * 0.1 + 20 * 0.5) / 1e6) < 1e-12);
  const body = JSON.parse(fetchImpl.calls[0].body);
  assert.equal(body.model, "h");
  assert.match(body.messages[0].content, /LAST line:\nMira: Angel, can I grapple it back\?/);
});

test("when the gate model can't be reached the fallback still decides", async () => {
  const claude = new Claude({ apiKey: "k", prices: {}, fetchImpl: scriptedFetch([{ status: 400, body: { error: { message: "bad" } } }]) });
  const d = await gate({ claude, model: "h", contextText: "", lastText: "Angel, what's a DC?" });
  assert.equal(d.fallback, true);
  assert.match(d.error, /400/);
  assert.equal(gateUser("", "x").includes("(none)"), true);
});

test("a stop is her name first and little after it; a question or the story after a stop word is not", () => {
  for (const t of ["Angel, never mind that, how does flanking work?", "Angel, enough damage to drop it?", "Angel stop. What does stunned do?", "the angel, quiet as death, raises its sword"]) assert.equal(isStopRequest(t), false, t);
  for (const t of ["okay Angel, stop", "Angel, that's enough, thank you", "Angel stop please", "Angel, stop!"]) assert.equal(isStopRequest(t), true, t);
  /* her name last (short round of 2026-11-21) */
  for (const t of ["Never mind, Angel.", "stop, Angel", "Okay, that's enough, Angel!", "never mind now, angel", "Please stop, Angela."]) assert.equal(isStopRequest(t), true, t);
  for (const t of ["Never mind, Angel, how does flanking work?", "I said stop the angel", "Stop the ritual, Angel?", "never mind the angel", "stop"]) assert.equal(isStopRequest(t), false, t);
});

test("when the check can't be reached, the fallback reads what was said, not the speaker's name before it", async () => {
  const claude = new Claude({ apiKey: "k", prices: {}, fetchImpl: scriptedFetch([{ status: 529, body: "busy" }, { status: 529, body: "busy" }, { status: 529, body: "busy" }]), sleep: async () => {} });
  const d = await gate({ claude, model: "h", contextText: "", lastText: "Mira: Angel, what does grabbed do?", bareText: "Angel, what does grabbed do?" });
  assert.equal(d.fallback, true);
  assert.equal(d.toAngel, true);
  assert.match(d.error, /529/);
});

test("no text, however odd, makes the readers slow (a slow regex would freeze every session)", async () => {
  const { typedQuestion } = await import("../src/commands.mjs");
  const { speakable } = await import("../src/speech.mjs");
  /* 4000 characters: Discord's longest message; each shape once tripped a regex like ours somewhere */
  const n = 4000;
  const odd = [" ".repeat(n), ",".repeat(n), "angel ".repeat(n / 6), "angel,".repeat(n / 6), "hey ".repeat(n / 4), "hey angel ".repeat(n / 10),
    "{".repeat(n), "[".repeat(n), "[a](".repeat(n / 4), "\n".repeat(n), " \n".repeat(n / 2), "-".repeat(n), "+".repeat(n),
    "angel " + "please ".repeat(n / 7), "Angel," + " ".repeat(n) + "x", "!".repeat(n) + "angel"];
  const readers = { isStopRequest, mentionsAngel, parseGate: t => parseGate(t, t), parseHold: t => parseHold(t, t), cleanReady, typedQuestion: t => typedQuestion(t, "123"), speakable };
  for (const [name, read] of Object.entries(readers)) {
    for (const [i, text] of odd.entries()) {
      const t0 = performance.now();
      read(text);
      const ms = performance.now() - t0;
      assert.ok(ms < 50, `${name} took ${ms.toFixed(0)} ms on odd text #${i}`);
    }
  }
});

test("a follow-up goes to the leaning-yes check, anything else to the general one", async () => {
  const seen = [];
  const claude = { create: async r => { seen.push(r.system[0].text); return { content: [{ type: "text", text: '{"to_angel": true}' }], usage: {} }; }, cost: () => 0 };
  await gate({ claude, model: "m", contextText: "", lastText: "Rhea: Okay. What about stacking?", replying: true });
  await gate({ claude, model: "m", contextText: "", lastText: "Rhea: Angel, hi" });
  assert.equal(seen[0], FOLLOWUP_SYSTEM);
  assert.equal(seen[1], GATE_SYSTEM);
});

test("the check gets a short time limit and one more try; a reply cut off at its limit is reported, not passed in silence", async () => {
  const seen = [];
  const claude = { cost: () => 0.002, async create(body, opts) { seen.push([body, opts]); return { stop_reason: "max_tokens", content: [{ type: "text", text: '{"to_angel": true, "complete": true, "question": "How does the champion\'s reaction' }], usage: {} }; } };
  const d = await gate({ claude, model: "h", contextText: "", lastText: "Rhea: How about this, tell me how it works, Angel", bareText: "How about this, tell me how it works, Angel" });
  assert.deepEqual(seen[0][1], { timeoutMs: 8000, retries: 1, maxWaitMs: 1500 });
  assert.equal(d.dollars, 0.002, "the cut-off call was still paid for and is counted");
  assert.equal(seen[0][0].max_tokens, 600, "room for a long question written back");
  assert.match(d.error, /cut off/, "said in the log by the session");
  assert.equal(d.fallback, true);
});

test("a call the table is waiting on doesn't sit out a long 'try again later'", async () => {
  const sleeps = [];
  const f = scriptedFetch([{ status: 429, headers: { "retry-after": "20" }, body: { error: { message: "slow down" } } }, { body: { content: [], usage: {} } }]);
  const c = new Claude({ apiKey: "k", prices: {}, fetchImpl: f, sleep: async ms => sleeps.push(ms) });
  await c.create({ model: "m" }, { retries: 1, maxWaitMs: 1500 });
  assert.deepEqual(sleeps, [1500]);
});

test("their own words after a stop are cut out for the question that follows it", () => {
  assert.equal(afterStop("Angel, stop. What does stunned do?"), "What does stunned do?");
  assert.equal(afterStop("okay Angel, that's enough, thanks - how does flanking work?"), "how does flanking work?", "the politeness that goes with the stop is not part of the question");
  assert.equal(afterStop("Angel, stop please. What does stunned do?"), "What does stunned do?");
  assert.equal(afterStop("Angel, stop. Thanksgiving dinner rules?"), "Thanksgiving dinner rules?", "only whole words are dropped");
  assert.equal(afterStop("Angel, stop please."), "");
  assert.equal(afterStop("Angel, never mind that, how does flanking work?"), "how does flanking work?");
  assert.equal(afterStop("Angel, stop. Item bonuses, how do they stack?"), "Item bonuses, how do they stack?", "a word that only starts with one of them stays");
  assert.equal(afterStop("Angel, what does stop do?"), "", "no stop at the start: nothing to cut");
  const t0 = performance.now();
  afterStop("Angel, stop " + "'".repeat(50000));
  assert.ok(performance.now() - t0 < 100);
});

test("(wk-11) while she waits: the check's verdict is read; an unreadable one falls back to the plain rule", () => {
  assert.deepEqual(parseHold('```json\n{"kind": "go", "chat": false, "question": ""}\n```'), { kind: "go", chat: false, complete: true, adds: false, question: "", fallback: false });
  /* a go-ahead that also finishes the question (field test 2026-11-21); only a go-ahead can add */
  assert.equal(parseHold('{"kind": "go", "adds": true, "question": "Can I go back to it?"}').adds, true);
  assert.equal(parseHold('{"kind": "go", "adds": "yes"}').adds, false, "only a real true");
  assert.equal(parseHold('{"kind": "wait", "adds": true}').adds, false);
  assert.match(HOLD_SYSTEM, /"adds": true or false/);
  /* only the start of a question, the rest to come (review 12 of 0.1.3); a missing flag means whole */
  assert.equal(parseHold('{"kind": "ask", "complete": false, "question": ""}').complete, false);
  assert.equal(parseHold("", "Angel, what about flanking?").complete, true);
  assert.equal(parseHold('{"kind": "ask", "chat": true, "question": "How are you?"}').question, "How are you?");
  assert.equal(parseHold('{"kind": "maybe"}', "hm").kind, "none", "an unknown kind is not trusted");
  assert.equal(parseHold("", "Angel, stop.").kind, "stop");
  assert.equal(parseHold("", "Angel, what about flanking?").kind, "ask");
  assert.equal(parseHold("", "Okay Angel.").kind, "go", "her name alone invites her");
  assert.equal(parseHold("", "So I move ten feet.").kind, "none");
});

test("(wk-11) the check while she waits is told whose answer she holds and what she said; it counts its own cost", async () => {
  const seen = [];
  const claude = { create: async (r, o) => { seen.push({ r, o }); return { content: [{ type: "text", text: '{"kind": "wait"}' }], usage: { input_tokens: 10 } }; }, cost: () => 0.0002 };
  const v = await holdCheck({ claude, model: "m", contextText: "[x] Sam: hi", lastText: "Dana: hold on Angel", bareText: "hold on Angel", asker: "Mira", question: "What does grabbed do?", cutIn: "Got it, whenever." });
  assert.deepEqual([v.kind, v.dollars], ["wait", 0.0002]);
  assert.equal(seen[0].r.system[0].text, HOLD_SYSTEM);
  assert.match(seen[0].r.messages[0].content, /LAST line:\nDana: hold on Angel/);
  assert.match(seen[0].r.messages[0].content, /Mira's question: "What does grabbed do\?"\. She said: "Got it, whenever\."/);
  /* while she still looks it up, the check is told so (review 12 of 0.1.3) */
  await holdCheck({ claude, model: "m", contextText: "", lastText: "Dana: hold on Angel", bareText: "hold on Angel", asker: "Mira", question: "What does grabbed do?", ready: false });
  assert.match(seen[1].r.messages[0].content, /Angel is looking up the answer to Mira's question/);
  assert.match(seen[0].r.messages[0].content, /Angel is holding her answer to Mira's question/);
  assert.equal(seen[0].o.timeoutMs, 8000, "the table is waiting: a short limit");
  const down = { create: async () => { throw new Error("overloaded"); }, cost: () => 0 };
  const f = await holdCheck({ claude: down, model: "m", lastText: "Dana: go ahead Angel", bareText: "go ahead Angel" });
  assert.equal(f.kind, "go");
  assert.equal(f.error, "overloaded");
  assert.match(holdUser("", "x"), /holding her answer to someone's question/);
});

test("(wk-12) her 'I'm ready' words: written by one short call, told her last few, cleaned; nothing usable is empty, never a stock line", async () => {
  let req;
  const claude = { create: async r => { req = r; return { content: [{ type: "text", text: '"Got it, whenever you\'re ready."' }], usage: {} }; }, cost: () => 0.0001 };
  const r = await readyLine({ claude, model: "m", question: "What does grabbed do?", asker: "Mira", earlier: ["Ready when you are."] });
  assert.deepEqual(r, { text: "Got it, whenever you're ready.", dollars: 0.0001 });
  assert.equal(req.system, READY_SYSTEM);
  assert.match(req.messages[0].content, /Mira's question: What does grabbed do\?[\s\S]*"Ready when you are\."/);
  assert.ok(req.max_tokens <= 60);
  assert.equal(cleanReady(""), "");
  assert.equal(cleanReady("word ".repeat(20)), "", "too long to be a quick cut-in");
  assert.equal(cleanReady("  “Okay, I’ve got it.”  "), "Okay, I’ve got it.");
});

test("(wk-11) the plain rule while she waits: 'hold on' is a wait, her name alone is a go-ahead (review of 0.1.3)", () => {
  assert.equal(parseHold("", "Hold on Angel.").kind, "wait");
  assert.equal(parseHold("", "Angel, hold on?").kind, "wait");
  assert.equal(parseHold("", "Angel?").kind, "go");
  assert.equal(parseHold("", "Okay Angel, go ahead.").kind, "go");
  assert.equal(parseHold("", "Angel, what about flanking?").kind, "ask");
  assert.equal(parseHold("", "wait, so I move here").kind, "none", "not to her");
});

/* ---- 0.1.3, the self-test of 2026-11-15 (wk-13): "Hey Angel, quick one." cut the check off and the plain rule said go ---- */
test("(wk-14) the plain rule: her name with only words that announce a question is the start of one, not a go-ahead", () => {
  for (const t of ["Hey Angel, quick one.", "Angel, quick question", "Angel, got a sec?", "Angela, quick one", "Hey Angel, I have a question.", "Okay Angel, one more thing",
    /* the review of the fix (2026-11-16) */
    "Angel, I've got a question", "Angel, I've got a quick question.", "Angel, quick question for you", "Alright Angel, quick one", "Sorry Angel, quick question", "Angel, I have one more question", "Angel, do you have a sec?"]) {
    const v = parseHold("", t);
    assert.deepEqual([v.kind, v.complete, v.question], ["ask", false, ""], t);
  }
  /* the rest of the line must be all call: anything more is read as before */
  assert.equal(parseHold("", "Hold on Angel, quick question").kind, "wait", "a hold-on stays a wait");
  assert.equal(parseHold("", "Angel?").kind, "go", "her name alone still invites her");
  assert.deepEqual([parseHold("", "Angel, quick one: does grab need a free hand?").kind, parseHold("", "Angel, quick one: does grab need a free hand?").complete], ["ask", true]);
  assert.equal(parseHold("", "A quick question for the GM").kind, "none", "not to her");
});

test("(wk-14) a reply cut off at the limit: a whole verdict before the cut still counts, a broken one falls back", async () => {
  const reply = text => ({ cost: () => 0.0003, async create(body) { this.body = body; return { stop_reason: "max_tokens", content: [{ type: "text", text }], usage: {} }; } });
  const whole = reply('{"kind": "ask", "chat": false, "complete": false, "question": ""}\nThe line only opens a question {they will finish it}, so');
  const v = await holdCheck({ claude: whole, model: "m", lastText: "Sam: Hey Angel, quick one.", bareText: "Hey Angel, quick one." });
  assert.deepEqual([v.kind, v.complete, v.fallback, v.error], ["ask", false, false, undefined]);
  assert.ok(whole.body.max_tokens >= 600, "room enough for the verdict");
  const broken = reply('{"kind": "go", "chat": false, "comp');
  const f = await holdCheck({ claude: broken, model: "m", lastText: "Sam: go ahead Angel", bareText: "go ahead Angel" });
  assert.deepEqual([f.kind, f.fallback, f.error], ["go", true, "its reply was cut off"]);
  assert.equal(f.dollars, 0.0003, "a cut-off reply is still paid for");
  assert.equal(v.cutOff, true, "a used cut-off reply is marked, so the log shows it");
  /* it changed its mind before the cut: the first verdict is not trusted (review of the fix) */
  const turned = reply('{"kind": "go", "chat": false, "complete": true, "question": ""} actually they only opened one: {"kind": "ask", "comp');
  const g = await holdCheck({ claude: turned, model: "m", lastText: "Sam: Hey Angel, quick one.", bareText: "Hey Angel, quick one." });
  assert.deepEqual([g.kind, g.complete, g.fallback, g.error], ["ask", false, true, "its reply was cut off"]);
});

test("(wk-14) the check's prompt names the bare call and asks for the JSON alone", () => {
  assert.match(HOLD_SYSTEM, /"Hey Angel, quick one"[^\n]*is "ask" with complete false, not "go"/);
  assert.match(HOLD_SYSTEM, /JSON object alone, on one line, and nothing after it/);
});

test("(wk-14) the plain rule's call words are quick on odd text", () => {
  for (const text of ["angel quick ".repeat(400), "quick one ".repeat(400), "angel " + "a ".repeat(2000), "got a sec ".repeat(400) + "angel"]) {
    const t0 = performance.now();
    parseHold("", text);
    assert.ok(performance.now() - t0 < 50);
  }
});

/* Test Angel.cmd, 2026-11-16: "Hold on, I wasn't done." ran the "was that for me?" check past its limit too */
test("(wk-9) the 'was that for me?' check cut off: a whole verdict before the cut is used and marked; else the plain rule, with the reply's start for the report", async () => {
  const reply = text => ({ cost: () => 0.0004, create: async () => ({ stop_reason: "max_tokens", content: [{ type: "text", text }], usage: {} }) });
  const used = await gate({ claude: reply('{"to_angel": true, "complete": true, "stop": false, "chat": true, "question": "Hold on, I wasn\'t done."}\nThis line is a reply to her'), model: "m", lastText: "Rhea: Hold on, I wasn't done.", bareText: "Hold on, I wasn't done.", replying: true });
  assert.deepEqual([used.toAngel, used.stop, used.fallback, used.cutOff, used.error], [true, false, false, true, undefined]);
  const turned = await gate({ claude: reply('{"to_angel": true, "complete": true} no wait: {"to_angel": false, "comp'), model: "m", lastText: "Rhea: Hold on, I wasn't done.", bareText: "Hold on, I wasn't done.", replying: true });
  assert.deepEqual([turned.fallback, turned.error, turned.cutOff], [true, "its reply was cut off", undefined], "it changed its mind: not trusted");
  assert.equal(turned.replyStart, '{"to_angel": true, "complete": true} no wait: {"to_angel": false, "comp');
  assert.equal(turned.dollars, 0.0004);
  /* words with braces after a whole verdict don't hide it (review 19) */
  const braces = await gate({ claude: reply('{"to_angel": true, "complete": true, "stop": false, "chat": true, "question": "x"}\nNote: the format {"..."} requires'), model: "m", lastText: "Rhea: hm", bareText: "hm", replying: true });
  assert.deepEqual([braces.toAngel, braces.fallback, braces.cutOff], [true, false, true]);
  assert.equal(parseGate('{"nested": 1} and {"other": 2}', "Angel?").fallback, true, "the second pass takes only a real verdict");
  const long = await gate({ claude: reply("x\n ".repeat(400)), model: "m", lastText: "Rhea: hm", bareText: "hm" });
  assert.ok(long.replyStart.length <= 160 && !/\n/.test(long.replyStart), "one short line");
});

test("(wk-3) talk about her commands is not for her (live round 2026-11-16: 'So slash angel space I m' woke her)", () => {
  assert.match(GATE_SYSTEM, /when they talk about her commands \("type slash angel join", "do \/angel iam and your name"/);
});
