import { test } from "node:test";
import assert from "node:assert/strict";
import { answerQuestion, systemPrompt, typedAnswer, userMessage, TOOLS } from "../src/answer.mjs";
import { Claude } from "../src/claude.mjs";
import { scriptedFetch } from "./helpers.mjs";

/* a stand-in Claude that replies from a script and records the requests */
function fakeClaude(replies) {
  const requests = [];
  return {
    requests,
    cost: () => 0.01,
    async create(body) { requests.push(structuredClone(body)); const r = replies.shift(); if (!r) throw new Error("no more replies"); return r; },
  };
}
const fakeAon = {
  calls: [],
  async search(q, o) { this.calls.push(["search", q, o]); return [{ id: "condition-77", name: "Grabbed", url: "https://2e.aonprd.com/Conditions.aspx?ID=77" }]; },
  async get(ref) { this.calls.push(["get", ref]); return { id: ref, name: "Grabbed", url: "https://2e.aonprd.com/Conditions.aspx?ID=77", text: "You're held in place..." }; },
};

test("Angel looks the rule up, then answers through the answer tool", async () => {
  const claude = fakeClaude([
    { content: [{ type: "tool_use", id: "t1", name: "aon_search", input: { query: "grabbed", category: "condition" } }], usage: {} },
    { content: [{ type: "tool_use", id: "t2", name: "aon_get", input: { ref: "condition-77" } }], usage: {} },
    { content: [{ type: "text", text: "Here it is." }, { type: "tool_use", id: "t3", name: "answer", input: { say: "While grabbed you're off-guard and immobilized.", sources: [{ name: "Grabbed", url: "https://2e.aonprd.com/Conditions.aspx?ID=77" }, { name: "Elsewhere", url: "https://example.com/x" }] } }], usage: {} },
  ]);
  const r = await answerQuestion({ claude, aon: fakeAon, model: "m", system: "SYS", conversation: "[19:00:00] Dana (GM): The ogre grabs you.", question: "What does grabbed do?", asker: "Mira", via: "voice" });
  assert.equal(r.say, "While grabbed you're off-guard and immobilized.");
  assert.deepEqual(r.sources, [{ name: "Grabbed", url: "https://2e.aonprd.com/Conditions.aspx?ID=77" }], "only AoN links kept");
  assert.equal(r.rounds, 3);
  assert.equal(r.lookups, 2);
  assert.ok(Math.abs(r.dollars - 0.03) < 1e-9, "each call's own cost added up");
  const last = claude.requests[2];
  assert.equal(last.messages.length, 5, "question, then two rounds of tool use and results");
  assert.equal(last.messages[2].content[0].type, "tool_result");
  assert.equal(last.messages[2].content[0].tool_use_id, "t1");
  assert.equal(last.system[0].cache_control.type, "ephemeral", "the system prompt is cached");
  assert.equal(last.tool_choice, undefined, "not forced before the last round");
  assert.match(claude.requests[0].messages[0].content, /Mira said to you: "What does grabbed do\?"/);
  assert.match(claude.requests[0].messages[0].content, /The ogre grabs you/);
});

test("with no sources given, the pages she read are listed", async () => {
  const claude = fakeClaude([
    { content: [{ type: "tool_use", id: "a", name: "aon_get", input: { ref: "condition-77" } }], usage: {} },
    { content: [{ type: "tool_use", id: "b", name: "answer", input: { say: "Yes." } }], usage: {} },
  ]);
  const r = await answerQuestion({ claude, aon: fakeAon, model: "m", system: "S", conversation: "", question: "q", asker: "A" });
  assert.deepEqual(r.sources, [{ name: "Grabbed", url: "https://2e.aonprd.com/Conditions.aspx?ID=77" }]);
});

test("the last round forces an answer, and plain text counts as one", async () => {
  const loop = Array.from({ length: 2 }, (_, i) => ({ content: [{ type: "tool_use", id: `x${i}`, name: "aon_search", input: { query: "q" } }], usage: {} }));
  const claude = fakeClaude([...loop, { content: [{ type: "tool_use", id: "z", name: "answer", input: { say: "Forced." } }], usage: {} }]);
  const r = await answerQuestion({ claude, aon: fakeAon, model: "m", system: "S", conversation: "", question: "q", asker: "A", maxRounds: 3 });
  assert.equal(r.say, "Forced.");
  assert.deepEqual(claude.requests[2].tool_choice, { type: "tool", name: "answer" });
  const plain = await answerQuestion({ claude: fakeClaude([{ content: [{ type: "text", text: "Just text." }], usage: {} }]), aon: fakeAon, model: "m", system: "S", conversation: "", question: "q", asker: "A" });
  assert.equal(plain.say, "Just text.");
  const empty = await answerQuestion({ claude: fakeClaude([{ content: [{ type: "tool_use", id: "e", name: "answer", input: {} }], usage: {} }]), aon: fakeAon, model: "m", system: "S", conversation: "", question: "q", asker: "A" });
  assert.match(empty.say, /lost my train of thought/);
});

test("a failed lookup is told to Claude instead of stopping the answer", async () => {
  const brokenAon = { async search() { throw new Error("Archives of Nethys answered 503"); }, async get() { return null; } };
  const claude = fakeClaude([
    { content: [{ type: "tool_use", id: "s", name: "aon_search", input: { query: "q" } }], usage: {} },
    { content: [{ type: "tool_use", id: "f", name: "answer", input: { say: "I couldn't check, but..." } }], usage: {} },
  ]);
  const r = await answerQuestion({ claude, aon: brokenAon, model: "m", system: "S", conversation: "", question: "q", asker: "A" });
  assert.match(claude.requests[1].messages[2].content[0].content, /lookup failed: Archives of Nethys answered 503/);
  assert.equal(r.say, "I couldn't check, but...");
});

test("the system prompt carries the house rules and the GM; the tools are the three", () => {
  const s = systemPrompt({ houseRules: "Hero Point rule text.", gmName: "Dana" });
  assert.match(s, /House rules for this table:\nHero Point rule text\./);
  assert.match(s, /The GM \(Dana\) has the final say/);
  assert.match(systemPrompt(), /\(none given\)/);
  assert.deepEqual(TOOLS.map(t => t.name), ["aon_search", "aon_get", "answer"]);
  assert.match(userMessage({ conversation: "", question: "q", asker: "Tobin", via: "text" }), /Tobin typed to you/);
});

test("the typed copy names who asked, links the pages and stays under 2,000 characters", () => {
  const t = typedAnswer({ asker: "Tobin", question: "Flanking?", say: "Yes.", sources: [{ name: "Off-Guard", url: "https://2e.aonprd.com/Conditions.aspx?ID=58" }] });
  assert.equal(t, "**Tobin asked:** Flanking?\nYes.\n-# [Off-Guard](<https://2e.aonprd.com/Conditions.aspx?ID=58>)");
  const long = typedAnswer({ asker: "R", question: "q".repeat(500), say: "x".repeat(5000), sources: [{ name: "A", url: "https://2e.aonprd.com/a" }] });
  assert.ok(long.length <= 2000, `${long.length}`);
  assert.ok(long.includes("…"));
});

test("the Claude client retries overload, reports other errors plainly, and prices calls", async () => {
  const sleeps = [];
  const f = scriptedFetch([{ status: 529, body: { error: { message: "Overloaded" } } }, { body: { content: [], usage: { input_tokens: 1e6, output_tokens: 1e5, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 } } }, { status: 400, body: { error: { message: "max_tokens too big" } } }]);
  const c = new Claude({ apiKey: "sk", prices: { m: [2, 2.5, 0.1, 10] }, fetchImpl: f, sleep: async ms => sleeps.push(ms) });
  await c.create({ model: "m" });
  assert.equal(sleeps.length, 1);
  assert.ok(Math.abs(c.spent - (2 + 2.5 + 0.1 + 1)) < 1e-9);
  assert.equal(f.calls[0].init.headers["x-api-key"], "sk");
  await assert.rejects(c.create({ model: "m" }), /Claude answered 400: max_tokens too big/);
  assert.equal(c.cost("unknown", { input_tokens: 5 }), 0);
});

test("a timed-out Claude call is not sent again; a failed answer still reports what its rounds cost", async () => {
  let calls = 0;
  const slow = async () => { calls++; const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; };
  const c = new Claude({ apiKey: "k", prices: { m: [1, 1, 1, 1] }, fetchImpl: slow, sleep: async () => {} });
  await assert.rejects(c.create({ model: "m" }), /took longer than 45 s/);
  assert.equal(calls, 1);
  const claude = fakeClaude([{ content: [{ type: "tool_use", id: "s", name: "aon_search", input: { query: "q" } }], usage: {} }]);
  const err = await answerQuestion({ claude, aon: fakeAon, model: "m", system: "S", conversation: "", question: "q", asker: "A" }).catch(e => e);
  assert.match(err.message, /no more replies/);
  assert.ok(Math.abs(err.dollars - 0.01) < 1e-9, "the round that ran is counted");
});
