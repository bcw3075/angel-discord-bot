import { test } from "node:test";
import assert from "node:assert/strict";
import { GATE_SYSTEM, mentionsAngel, isStopRequest, parseGate, gate, gateUser } from "../src/wake.mjs";
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
    { toAngel: true, complete: true, stop: false, chat: false, question: "What is off-guard?", fallback: false });
  assert.equal(parseGate('{"to_angel": true, "complete": true, "stop": false, "chat": true, "question": "Thanks!"}').chat, true, "small talk is marked");
  assert.match(GATE_SYSTEM, /answers or reacts to what she said/, "a reply to her counts without her name");
  assert.match(GATE_SYSTEM, /starts with one and then asks something/, "\"Okay. Good. What about stacking?\" is for her (2026-11-14)");
  assert.match(gateUser("x", "Rhea: Okay. What about stacking?", true), /just answered this person/);
  assert.doesNotMatch(gateUser("x", "Rhea: hi"), /just answered/);
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
  const readers = { isStopRequest, mentionsAngel, parseGate: t => parseGate(t, t), typedQuestion: t => typedQuestion(t, "123"), speakable };
  for (const [name, read] of Object.entries(readers)) {
    for (const [i, text] of odd.entries()) {
      const t0 = performance.now();
      read(text);
      const ms = performance.now() - t0;
      assert.ok(ms < 50, `${name} took ${ms.toFixed(0)} ms on odd text #${i}`);
    }
  }
});
