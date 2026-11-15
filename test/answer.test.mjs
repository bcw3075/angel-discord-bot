import { test } from "node:test";
import assert from "node:assert/strict";
import { answerQuestion, systemPrompt, typedAnswer, userMessage, TOOLS } from "../src/answer.mjs";
import { Claude, FieldReader } from "../src/claude.mjs";
import { scriptedFetch, streamEvents, sseBody } from "./helpers.mjs";

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
  assert.deepEqual(last.system[0].cache_control, { type: "ephemeral" }, "the system prompt is cached, 5 minutes unless asked");
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
  assert.equal(r.details, "Yes.", "with no written part, the spoken one is written too");
});

test("short spoken answer, fuller written one (Rhea, 2026-11-14)", async () => {
  const claude = fakeClaude([
    { content: [{ type: "tool_use", id: "b", name: "answer", input: { say: "Not with a shield and a weapon: Grapple needs a free hand.", details: "Grapple needs at least one free hand. A buckler leaves its hand free; that's the GM's call." } }], usage: {} },
  ]);
  const r = await answerQuestion({ claude, aon: fakeAon, model: "m", system: "S", conversation: "", question: "q", asker: "A" });
  assert.equal(r.say, "Not with a shield and a weapon: Grapple needs a free hand.");
  assert.match(r.details, /buckler/);
  const prompt = systemPrompt({});
  assert.match(prompt, /one to three short sentences/);
  assert.match(prompt, /posted in Discord/);
  assert.match(prompt, /bullet points/, "the written part is formatted, not a wall of text");
  const tool = claude.requests[0].tools.find(t => t.name === "answer");
  assert.ok(tool.input_schema.properties.details, "the answer tool has the written part");
});

test("the last round says 'answer now' with the same tools (never a forced tool_choice, which Sonnet 5.5 refuses), and plain text counts as an answer", async () => {
  const loop = Array.from({ length: 2 }, (_, i) => ({ content: [{ type: "tool_use", id: `x${i}`, name: "aon_search", input: { query: "q" } }], usage: {} }));
  const claude = fakeClaude([...loop, { content: [{ type: "tool_use", id: "z", name: "answer", input: { say: "Forced." } }], usage: {} }]);
  const r = await answerQuestion({ claude, aon: fakeAon, model: "m", system: "S", conversation: "", question: "q", asker: "A", maxRounds: 3 });
  assert.equal(r.say, "Forced.");
  assert.equal(claude.requests[2].tool_choice, undefined, "no forced tool choice");
  assert.deepEqual(claude.requests[2].tools, claude.requests[0].tools, "the same tools in every round: her earlier thinking is only accepted back while what came before it is unchanged");
  assert.match(JSON.stringify(claude.requests[2].messages.at(-1).content), /give your answer now/);
  assert.ok(claude.requests.every(r => r.tool_choice === undefined), "never forced in any round");
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
  const usage = { input_tokens: 1e6, output_tokens: 1e5, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 2e6, cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 } };
  const f = scriptedFetch([{ status: 529, body: { error: { message: "Overloaded" } } }, { body: { content: [], usage } }, { status: 400, body: { error: { message: "max_tokens too big" } } }]);
  const c = new Claude({ apiKey: "sk", prices: { m: [2, 2.5, 0.1, 10] }, fetchImpl: f, sleep: async ms => sleeps.push(ms) });
  await c.create({ model: "m" });
  assert.equal(sleeps.length, 1);
  assert.ok(Math.abs(c.spent - (2 + 2.5 + 4 + 0.1 + 1)) < 1e-9, "a 1-hour write is twice the input price, a 5-minute one 1.25 times");
  assert.ok(Math.abs(c.cost("m", { cache_creation_input_tokens: 1e6 }) - 4) < 1e-9, "writes of unknown kind count at the dearer rate");
  assert.ok(Math.abs(new Claude({ prices: { m: [2, 2.5, 0.1, 10, 3] } }).cost("m", { cache_creation: { ephemeral_1h_input_tokens: 1e6 } }) - 3) < 1e-9, "a fifth price wins");
  assert.equal(f.calls[0].init.headers["x-api-key"], "sk");
  await assert.rejects(c.create({ model: "m" }), /Claude answered 400: max_tokens too big/);
  assert.ok(Math.abs(c.cost("unknown", { input_tokens: 5 }) - 5 * 2 / 1e6) < 1e-15, "an unpriced model counts at the dearest price (here the only one), never as free");
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

test("with the 1-hour setting every round asks Claude to keep the prompt for an hour", async () => {
  const claude = fakeClaude([
    { content: [{ type: "tool_use", id: "t1", name: "aon_search", input: { query: "grabbed" } }], usage: { cache_creation_input_tokens: 6000 } },
    { content: [{ type: "tool_use", id: "t2", name: "answer", input: { say: "Held in place.", sources: [] } }], usage: { cache_read_input_tokens: 6000 } },
  ]);
  const r = await answerQuestion({ claude, aon: fakeAon, model: "m", system: "SYS", conversation: "", question: "Grabbed?", asker: "Mira", cacheTtl: "1h" });
  for (const q of claude.requests) assert.deepEqual(q.system[0].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.deepEqual(r.cache, { written: 6000, read: 6000 }, "what npm run ask reports");
});

test("the bot passes its cache setting through to the answering calls (1 hour by default)", async () => {
  const { buildServices } = await import("../src/services.mjs");
  const { DEFAULTS } = await import("../src/config.mjs");
  assert.equal(DEFAULTS.answerCacheTtl, "1h");
  const os = await import("node:os"), fs = await import("node:fs"), path = await import("node:path");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "angel-svc-"));
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: { get: () => null }, body: sseBody(streamEvents([{ type: "tool_use", id: "t", name: "answer", input: { say: "Yes, it does.", sources: [] } }])) };
  };
  const services = buildServices({ ...DEFAULTS, anthropicApiKey: "k", deepgramApiKey: "d" }, { fetchImpl, dataDir });
  const heard = [];
  const r = await services.answer({ conversation: "", question: "Grabbed?", asker: "Mira", via: "text", gmName: "Dana", onSay: t => heard.push(t) });
  assert.deepEqual(sent[0].system[0].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.equal(sent[0].stream, true, "the bot's answering calls are read as they are written");
  assert.equal(heard.join(""), "Yes, it does.", "and what she says is passed on as it comes");
  assert.equal(r.say, "Yes, it does.");
});

test("an answer model with no price is counted at the dearest known price, not as free", () => {
  const c = new Claude({ prices: { cheap: [0.1, 0.125, 0.01, 0.5], dear: [4, 5, 0.2, 20] } });
  assert.ok(Math.abs(c.cost("unknown", { input_tokens: 1e6 }) - 4) < 1e-9);
});

test("Deepgram's voice errors are read out of their JSON too", async () => {
  const { synthesize } = await import("../src/tts.mjs");
  const f = scriptedFetch([{ status: 401, body: { err_code: "INVALID_AUTH", err_msg: "Invalid credentials." } }]);
  await assert.rejects(synthesize("Hello.", { apiKey: "k", fetchImpl: f }), /^Error: Deepgram speak answered 401: Invalid credentials\.$/);
});

/* a real Claude client over a scripted streamed reply */
function streamingClaude(replies, opts = {}) {
  const f = scriptedFetch(replies);
  const c = new Claude({ apiKey: "sk", prices: { m: [2, 2.5, 0.1, 10] }, fetchImpl: f, sleep: async ms => { (opts.sleeps ?? []).push(ms); } });
  return { c, f };
}

test("a streamed reply comes back in the same shape as a plain one, however the pieces are cut", async () => {
  const blocks = [{ type: "text", text: "Here it is: “two” lines\nand é." }, { type: "tool_use", id: "t1", name: "aon_search", input: { query: "grabbed \"condition\"", category: "condition" } }, { type: "tool_use", id: "t2", name: "aon_get", input: {} , rawInput: "" }];
  for (const pieceSize of [1, 7, 37, 100000]) {
    const { c, f } = streamingClaude([{ events: streamEvents(blocks, { usage: { input_tokens: 100, cache_read_input_tokens: 6000 }, outputTokens: 40 }), pieceSize }]);
    const deltas = [];
    const res = await c.stream({ model: "m", max_tokens: 5 }, { onDelta: d => deltas.push(d.delta.type) });
    assert.deepEqual(res.content, [{ type: "text", text: "Here it is: “two” lines\nand é." }, { type: "tool_use", id: "t1", name: "aon_search", input: { query: "grabbed \"condition\"", category: "condition" } }, { type: "tool_use", id: "t2", name: "aon_get", input: {} }], `pieces of ${pieceSize}`);
    assert.deepEqual(res.usage, { input_tokens: 100, cache_read_input_tokens: 6000, output_tokens: 40 }, "the usage of the start and the end together");
    assert.equal(res.stop_reason, "tool_use");
    assert.ok(deltas.includes("text_delta") && deltas.includes("input_json_delta"));
    const sent = JSON.parse(f.calls[0].init.body);
    assert.equal(sent.stream, true);
    assert.equal(sent.tool_choice, undefined, "never a forced tool");
    assert.ok(Math.abs(c.spent - (100 * 2 + 6000 * 0.1 + 40 * 10) / 1e6) < 1e-12, "priced like any call");
  }
});

test("a streamed call is sent again only while nothing has been written; a reply that breaks off is still counted", async () => {
  const sleeps = [];
  const ok = streamEvents([{ type: "tool_use", id: "t", name: "answer", input: { say: "Yes." } }]);
  /* refused with 529, then overloaded before a word was written, then a good reply */
  const early = [{ type: "message_start", message: { content: [], usage: { input_tokens: 50 } } }, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }];
  let { c, f } = streamingClaude([{ status: 529, body: { error: { message: "Overloaded" } } }, { events: early }, { events: ok }], { sleeps });
  const res = await c.stream({ model: "m" });
  assert.equal(res.content[0].input.say, "Yes.");
  assert.equal(f.calls.length, 3);
  assert.equal(sleeps.length, 2);
  /* overloaded after she began writing: not sent again (the first words may already be spoken) */
  const late = [...streamEvents([{ type: "tool_use", id: "t", name: "answer", input: { say: "Yes, and there is more." } }], { usage: { input_tokens: 1e6 } }).slice(0, 5), { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }];
  ({ c, f } = streamingClaude([{ events: late }, { events: ok }]));
  const heard = [];
  const err = await c.stream({ model: "m" }, { onDelta: d => heard.push(d.delta.partial_json) }).catch(e => e);
  assert.match(err.message, /Claude's reply broke off: Overloaded/);
  assert.equal(f.calls.length, 1, "not sent again");
  assert.ok(heard.length > 0, "what came before the break was passed on");
  assert.equal(err.usage.input_tokens, 1e6, "what is known of its usage goes with the error");
  assert.equal(err.usage.output_tokens, 6, "what she had written is put at a token per three characters (18 arrived): its count only comes at the end, and the start's placeholder of 1 is not it");
  assert.ok(Math.abs(c.spent - (2 + 6 * 10 / 1e6)) < 1e-12, "and both are counted");
  /* the time limit passes while the reply is being read: not sent again, and said plainly */
  const late2 = Object.assign(new Error("aborted"), { name: "TimeoutError" });
  ({ c, f } = streamingClaude([{ events: ok, pieceSize: 20, breakAfter: 6, breakWith: late2 }, { events: ok }]));
  await assert.rejects(c.stream({ model: "m" }), /took longer than 45 s/);
  assert.equal(f.calls.length, 1);
  /* a reply with Windows line ends reads the same */
  ({ c } = streamingClaude([{ events: ok, crlf: true, pieceSize: 3 }]));
  assert.equal((await c.stream({ model: "m" })).content[0].input.say, "Yes.");
  /* the connection drops half way, and a reply that just ends */
  ({ c } = streamingClaude([{ events: ok, pieceSize: 20, breakAfter: 6 }]));
  await assert.rejects(c.stream({ model: "m" }), /Claude's reply broke off: socket hang up/);
  ({ c } = streamingClaude([{ events: ok.slice(0, -1) }]));
  await assert.rejects(c.stream({ model: "m" }), /broke off before it was finished/);
  ({ c } = streamingClaude([{ status: 400, body: { error: { message: "tool_choice not supported" } } }]));
  await assert.rejects(c.stream({ model: "m" }), /Claude answered 400: tool_choice not supported/);
  let calls = 0;
  const slow = new Claude({ apiKey: "k", prices: {}, fetchImpl: async () => { calls++; const e = new Error("aborted"); e.name = "TimeoutError"; throw e; }, sleep: async () => {} });
  await assert.rejects(slow.stream({ model: "m" }), /took longer than 45 s/);
  assert.equal(calls, 1, "a timed-out call is not sent again");
});

test("one field is read out of JSON that is still being written", () => {
  const whole = JSON.stringify({ note: { say: "not this one" }, list: ["say", "nor this"], say: "She said \"no\".\nTab\there, a \\ and é ☺ 😀 done", details: "**bold** say: \"x\"", sources: [{ name: "say", url: "u" }] }).replace("é", "\\u00e9");
  for (const size of [1, 2, 3, 5, 11, 1000]) {
    const r = new FieldReader("say");
    let out = "";
    for (let i = 0; i < whole.length; i += size) out += r.feed(whole.slice(i, i + size));
    assert.equal(out, "She said \"no\". Tab here, a \\ and é ☺ 😀 done", `pieces of ${size}: escapes undone, line breaks as spaces, only the top-level say`);
    assert.equal(r.text, out);
    assert.equal(r.done, true);
  }
  const cut = new FieldReader("say");
  cut.feed('{"say": "Half a sent');
  assert.equal(cut.text, "Half a sent", "an unfinished value gives what there is");
  assert.equal(cut.done, false);
  const none = new FieldReader("say");
  none.feed('{"details": "say", "x": {"say": "no"}}');
  assert.equal(none.text, "");
  const t0 = performance.now();
  new FieldReader("say").feed('{"say": "' + "\\\\\\\"{[:,".repeat(40000) + '"}');
  assert.ok(performance.now() - t0 < 500, "plain steps: a long odd value is still quick");
});

test("what she says is passed on while the rest of the answer is still being written", async () => {
  const input = { say: "Grabbed means off-guard and immobilized. Escape is one action.", details: "**Off-guard and immobilized.**\n- Escape: one action", sources: [{ name: "Grabbed", url: "https://2e.aonprd.com/Conditions.aspx?ID=77" }] };
  const order = [], ends = [];
  const given = {}; /* the second reply's body reports how much of it is still to come */
  const { c: c2, f: f2 } = streamingClaude([
    { events: streamEvents([{ type: "tool_use", id: "t1", name: "aon_search", input: { query: "grabbed" } }]) },
    { events: streamEvents([{ type: "text", text: "Got it." }, { type: "tool_use", id: "t2", name: "answer", input }], { jsonPiece: 6 }), pieceSize: 50, gapMs: 1, given },
  ]);
  const leftAt = [];
  const done = answerQuestion({ claude: c2, aon: fakeAon, model: "m", system: "S", conversation: "", question: "Grabbed?", asker: "Mira", onSay: (t, o) => { if (o?.end) ends.push(given.left); else { order.push(t); leftAt.push(given.left); } } });
  done.then(() => order.push("<done>"));
  const r = await done;
  await null;
  assert.equal(order.at(-1), "<done>");
  assert.ok(leftAt[0] > 1500, `her first words are passed on while most of the reply has not arrived yet (${leftAt[0]} bytes still to come)`);
  assert.equal(ends.length, 1, "told once that all she will say is written");
  assert.ok(ends[0] > 500, `and that comes before the written answer and the pages (${ends[0]} bytes still to come)`);
  assert.equal(order.slice(0, -1).join(""), input.say, "all of say, and nothing of the text before the tool or of details");
  assert.ok(order.length > 5, "in pieces, as written");
  assert.equal(r.say, input.say);
  assert.equal(r.details, input.details);
  assert.equal(r.rounds, 2);
  assert.equal(r.lookups, 1);
  const tools = JSON.parse(f2.calls[1].init.body).tools;
  assert.equal(tools.find(t => t.name === "answer").eager_input_streaming, true, "the answer tool's input is asked for as written");
  assert.equal(tools.find(t => t.name === "aon_search").eager_input_streaming, undefined, "the lookups stay checked by the API");
  assert.ok(Math.abs(r.dollars - c2.spent) < 1e-12, "each round's own cost");
});

test("an answer cut short still says what she had written; one that breaks off reports its cost", async () => {
  /* out of tokens inside details: the JSON never closes */
  let { c } = streamingClaude([{ events: streamEvents([{ type: "tool_use", id: "t", name: "answer", rawInput: '{"say": "Yes, with a free hand.", "details": "**Yes' }], { stop: "max_tokens" }) }]);
  const heard = [];
  const r = await answerQuestion({ claude: c, aon: fakeAon, model: "m", system: "S", conversation: "", question: "q", asker: "A", onSay: t => heard.push(t) });
  assert.equal(r.say, "Yes, with a free hand.");
  assert.equal(heard.join(""), "Yes, with a free hand.");
  assert.equal(r.details, "Yes, with a free hand.", "with no written part, the spoken one is written");
  /* two answer calls in one reply: only the first is passed on to be spoken, and it is the answer */
  ({ c } = streamingClaude([{ events: streamEvents([{ type: "tool_use", id: "a", name: "answer", input: { say: "The first one." } }, { type: "tool_use", id: "b", name: "answer", input: { say: "A second one." } }]) }]));
  heard.length = 0;
  const twice = await answerQuestion({ claude: c, aon: fakeAon, model: "m", system: "S", conversation: "", question: "q", asker: "A", onSay: t => heard.push(t) });
  assert.equal(heard.join(""), "The first one.");
  assert.equal(twice.say, "The first one.");
  /* the second round breaks off: the first round and what is known of the second are both counted */
  const broken = streamEvents([{ type: "tool_use", id: "t2", name: "answer", input: { say: "Yes." } }], { usage: { input_tokens: 1e6 } }).slice(0, 3);
  ({ c } = streamingClaude([{ events: streamEvents([{ type: "tool_use", id: "t1", name: "aon_search", input: { query: "q" } }], { usage: { input_tokens: 5e5 }, outputTokens: 0 }) }, { events: broken }]));
  const err = await answerQuestion({ claude: c, aon: fakeAon, model: "m", system: "S", conversation: "", question: "q", asker: "A" }).catch(e => e);
  assert.match(err.message, /broke off/);
  assert.ok(Math.abs(err.dollars - (3 + 10 / 1e6)) < 1e-12, "$1 for the first round and $2 for what the broken one had read (and the start's one token of writing)");
});

test("lookups asked for in one turn run together, and searches ask for the top entries' text", async () => {
  let running = 0, most = 0;
  const seen = [];
  const slowAon = {
    async search(q, o) { seen.push(o); running++; most = Math.max(most, running); await new Promise(r => setTimeout(r, 20)); running--; return [{ id: `s-${q}`, name: q }]; },
    async get(ref) { running++; most = Math.max(most, running); await new Promise(r => setTimeout(r, 5)); running--; return { id: ref, name: "Grabbed", url: "https://2e.aonprd.com/Conditions.aspx?ID=77", text: "t" }; },
  };
  const claude = fakeClaude([
    { content: [{ type: "tool_use", id: "a", name: "aon_search", input: { query: "one" } }, { type: "tool_use", id: "b", name: "aon_get", input: { ref: "condition-77" } }, { type: "tool_use", id: "c", name: "aon_search", input: { query: "two" } }], usage: {} },
    { content: [{ type: "tool_use", id: "d", name: "answer", input: { say: "Yes." } }], usage: {} },
  ]);
  const r = await answerQuestion({ claude, aon: slowAon, model: "m", system: "S", conversation: "", question: "q", asker: "A" });
  assert.equal(most, 3, "all three at once");
  assert.equal(r.lookups, 3);
  const results = claude.requests[1].messages[2].content;
  assert.deepEqual(results.map(x => x.tool_use_id), ["a", "b", "c"], "the results go back in the order asked");
  assert.match(results[0].content, /s-one/);
  assert.match(results[2].content, /s-two/);
  assert.equal(seen[0].withText, 3);
  assert.deepEqual(r.sources, [{ name: "Grabbed", url: "https://2e.aonprd.com/Conditions.aspx?ID=77" }], "the page she read is still listed when she names none");
});

test("their own words are the question and the check's reading only a hint; only pages the lookups gave are posted; a lookup is tried twice", async () => {
  assert.match(userMessage({ conversation: "", question: "Angel, what does grabbed do?", asker: "Mira", via: "voice", meaning: "What does the grabbed condition do?" }), /Mira said to you: "Angel, what does grabbed do\?"\n\(Their words come from a speech transcriber.*first reading of what they want: "What does the grabbed condition do\?"\. Go by their own words/);
  assert.doesNotMatch(userMessage({ conversation: "", question: "q", asker: "A", via: "text" }), /first reading/);
  let tries = 0;
  const flaky = { async search() { tries++; if (tries === 1) throw new Error("socket hang up"); return [{ id: "c-77", name: "Grabbed", url: "https://2e.aonprd.com/Conditions.aspx?ID=77" }]; }, async get() { throw new Error("Archives of Nethys answered 503"); } };
  const claude = fakeClaude([
    { content: [{ type: "tool_use", id: "s", name: "aon_search", input: { query: "grabbed" } }, { type: "tool_use", id: "g", name: "aon_get", input: { ref: "c-1" } }], usage: {} },
    { content: [{ type: "tool_use", id: "f", name: "answer", input: { say: "Yes.", sources: [{ name: "Grabbed", url: "https://2e.aonprd.com/Conditions.aspx?ID=77" }, { name: "Made up", url: "https://2e.aonprd.com/Conditions.aspx?ID=999" }] } }], usage: {} },
  ]);
  const r = await answerQuestion({ claude, aon: flaky, model: "m", system: "S", conversation: "", question: "q", asker: "A", meaning: "m" });
  assert.equal(tries, 2, "the search worked at the second try");
  assert.equal(r.failedLookups, 1, "the page that failed twice is counted");
  assert.match(claude.requests[1].messages[2].content[1].content, /lookup failed: Archives of Nethys answered 503.*say plainly that you couldn't check/);
  assert.deepEqual(r.sources, [{ name: "Grabbed", url: "https://2e.aonprd.com/Conditions.aspx?ID=77" }], "a link no lookup gave is not posted");
  assert.match(typedAnswer({ asker: "A", question: "q", say: "Yes.", sources: r.sources, unchecked: true }), /Yes\.\n-# ⚠️ I couldn't reach Archives of Nethys for part of this.*\n-# \[Grabbed\]/);
});

test("a lookup that ran out of time is not tried again", async () => {
  let tries = 0;
  const slow = { async search() { tries++; throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); }, async get() { return null; } };
  const claude = fakeClaude([{ content: [{ type: "tool_use", id: "s", name: "aon_search", input: { query: "q" } }], usage: {} }, { content: [{ type: "tool_use", id: "f", name: "answer", input: { say: "Couldn't check." } }], usage: {} }]);
  const r = await answerQuestion({ claude, aon: slow, model: "m", system: "S", conversation: "", question: "q", asker: "A" });
  assert.equal(tries, 1);
  assert.equal(r.failedLookups, 1);
});

test("her thinking comes back whole from a streamed reply and goes back to Claude with the lookups' results (live 2026-11-14)", async () => {
  const thought = { type: "thinking", thinking: "Stacking: circumstance penalties don't stack with each other. Let me check.", signature: "c2lnbmF0dXJl" };
  const hidden = { type: "redacted_thinking", data: "b3BhcXVl" };
  const { c, f } = streamingClaude([
    { events: streamEvents([thought, hidden, { type: "tool_use", id: "t1", name: "aon_search", input: { query: "circumstance penalty" } }]), pieceSize: 23 },
    { events: streamEvents([{ type: "tool_use", id: "t2", name: "answer", input: { say: "They don't stack." } }]) },
  ]);
  const heard = [];
  const r = await answerQuestion({ claude: c, aon: fakeAon, model: "m", system: "S", conversation: "", question: "What about stacking?", asker: "Rhea", onSay: t => heard.push(t) });
  assert.equal(r.say, "They don't stack.");
  const back = JSON.parse(f.calls[1].init.body).messages[1].content;
  assert.deepEqual(back[0], thought, "the thinking and its signature, as written");
  assert.deepEqual(back[1], hidden);
  assert.equal(back[2].type, "tool_use");
  assert.equal(heard.join(""), "They don't stack.", "her thinking is never spoken");
});

test("asked for another lookup on the last round, she is told no and gets one more round to answer; nothing more is looked up", async () => {
  const search = i => ({ content: [{ type: "tool_use", id: `x${i}`, name: "aon_search", input: { query: "q" } }], usage: {} });
  const counting = { n: 0, async search() { this.n++; return [{ id: "a", name: "A" }]; }, async get() { return null; } };
  let claude = fakeClaude([search(0), search(1), search(2), { content: [{ type: "tool_use", id: "z", name: "answer", input: { say: "From what I have." } }], usage: {} }]);
  const r = await answerQuestion({ claude, aon: counting, model: "m", system: "S", conversation: "", question: "q", asker: "A", maxRounds: 3 });
  assert.equal(r.say, "From what I have.");
  assert.equal(r.rounds, 4);
  assert.equal(counting.n, 2, "the lookup asked for on the last round is not run");
  assert.match(claude.requests[3].messages.at(-1).content[0].content, /Not looked up.*Give your answer now/);
  assert.equal(claude.requests[3].messages.at(-1).content[0].tool_use_id, "x2");
  /* still no answer: her apology, never an endless loop */
  claude = fakeClaude([search(0), search(1), search(2), search(3)]);
  const lost = await answerQuestion({ claude, aon: counting, model: "m", system: "S", conversation: "", question: "q", asker: "A", maxRounds: 3 });
  assert.match(lost.say, /lost my train of thought/);
  assert.equal(claude.requests.length, 4);
});

test("a streamed answer Claude refuses before she has spoken is worked out again the plain way; after she has spoken it is not", async () => {
  const plainReply = input => ({ body: { content: [{ type: "tool_use", id: "p", name: "answer", input }], usage: { input_tokens: 1e5 } } });
  /* round 1 streamed, round 2 refused with a 400; then the plain way: a lookup round and the answer */
  let { c, f } = streamingClaude([
    { events: streamEvents([{ type: "tool_use", id: "t1", name: "aon_search", input: { query: "q" } }], { usage: { input_tokens: 1e5 }, outputTokens: 0 }) },
    { status: 400, body: { error: { message: "messages.1.content.0.thinking: each thinking block must contain thinking" } } },
    { body: { content: [{ type: "thinking", thinking: "", signature: "c2ln" }, { type: "tool_use", id: "p1", name: "aon_search", input: { query: "q" } }], usage: { input_tokens: 1e5 } } },
    plainReply({ say: "They don't stack." }),
  ]);
  const heard = [];
  const r = await answerQuestion({ claude: c, aon: fakeAon, model: "m", system: "S", conversation: "", question: "q", asker: "A", onSay: t => heard.push(t) });
  assert.equal(r.say, "They don't stack.");
  assert.match(r.fellBack, /each thinking block must contain thinking/, "said in the log by the session");
  assert.deepEqual(f.calls.map(x => JSON.parse(x.init.body).stream === true), [true, true, false, false]);
  assert.deepEqual(JSON.parse(f.calls[3].init.body).messages[1].content[0], { type: "thinking", thinking: "", signature: "c2ln" }, "the plain way sends Claude's reply back exactly as it came");
  assert.equal(JSON.parse(f.calls[2].init.body).messages.length, 1, "started again from the question");
  assert.equal(r.lookups, 1, "counted for the answer that was given");
  assert.ok(Math.abs(r.dollars - 0.6) < 1e-9, "every call that ran is paid for and counted: three of 100,000 tokens in");
  assert.equal(heard.length, 0, "nothing was passed on to be spoken from the plain way");
  /* refused after she began to speak: not started again (she would say it twice) */
  ({ c, f } = streamingClaude([{ events: streamEvents([{ type: "tool_use", id: "t", name: "answer", input: { say: "Yes, and there is more to it." } }]).slice(0, 6) }, plainReply({ say: "x" })]));
  const err = await answerQuestion({ claude: c, aon: fakeAon, model: "m", system: "S", conversation: "", question: "q", asker: "A", onSay: t => heard.push(t) }).catch(e => e);
  assert.match(err.message, /broke off/);
  assert.equal(f.calls.length, 1);
  /* a refusal that isn't a 400 is not started again either */
  ({ c, f } = streamingClaude([{ status: 401, body: { error: { message: "invalid x-api-key" } } }, plainReply({ say: "x" })]));
  await assert.rejects(answerQuestion({ claude: c, aon: fakeAon, model: "m", system: "S", conversation: "", question: "q", asker: "A" }), /401/);
  assert.equal(f.calls.length, 1);
});

test("a kind of piece the code doesn't know is still kept in a streamed reply", async () => {
  const events = [
    { type: "message_start", message: { content: [], usage: { input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: [] } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "See " } },
    { type: "content_block_delta", index: 0, delta: { type: "citations_delta", citation: { cited_text: "x" } } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "new_kind", note: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "note_delta", note: "kept " } },
    { type: "content_block_delta", index: 1, delta: { type: "note_delta", note: "whole" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }, { type: "message_stop" },
  ];
  const { c } = streamingClaude([{ events }]);
  const res = await c.stream({ model: "m" });
  assert.deepEqual(res.content, [{ type: "text", text: "See ", citations: [{ cited_text: "x" }] }, { type: "new_kind", note: "kept whole" }]);
});

test("a reply cut off at its limit is asked once more with twice the room; a lookup cut mid-way is never run", async () => {
  const cutLookup = streamEvents([{ type: "thinking", thinking: "", signature: "c2ln" }, { type: "tool_use", id: "t1", name: "aon_search", rawInput: '{"query": "retrib' }], { stop: "max_tokens" });
  const searched = [];
  const aon = { async search(q) { searched.push(q); return [{ id: "a", name: "A" }]; }, async get() { return null; } };
  let { c, f } = streamingClaude([{ events: cutLookup }, { events: streamEvents([{ type: "tool_use", id: "t1", name: "aon_search", input: { query: "retributive strike" } }]) }, { events: streamEvents([{ type: "tool_use", id: "t2", name: "answer", input: { say: "In the aura." } }]) }]);
  const r = await answerQuestion({ claude: c, aon, model: "m", maxTokens: 1000, system: "S", conversation: "", question: "q", asker: "A" });
  assert.equal(r.say, "In the aura.");
  assert.deepEqual(searched, ["retributive strike"], "the cut request was not run with nothing in it");
  assert.deepEqual(f.calls.map(x => JSON.parse(x.init.body).max_tokens), [1000, 2000, 1000]);
  assert.equal(JSON.parse(f.calls[1].init.body).messages.length, 1, "nothing of the cut reply is kept");
  assert.equal(r.rounds, 2, "the second try is the same round");
  /* cut again at twice the room: her fallback line, no lookup with nothing in it */
  ({ c, f } = streamingClaude([{ events: cutLookup }, { events: cutLookup }]));
  const lost = await answerQuestion({ claude: c, aon, model: "m", system: "S", conversation: "", question: "q", asker: "A" });
  assert.match(lost.say, /lost my train of thought/);
  assert.equal(searched.length, 1);
  /* cut inside the written part after all she says came through: taken as it is, not asked again */
  ({ c, f } = streamingClaude([{ events: streamEvents([{ type: "tool_use", id: "t", name: "answer", rawInput: '{"say": "Yes, with a free hand.", "details": "**Yes' }], { stop: "max_tokens" }) }]));
  const part = await answerQuestion({ claude: c, aon, model: "m", system: "S", conversation: "", question: "q", asker: "A", onSay: () => {} });
  assert.equal(part.say, "Yes, with a free hand.");
  assert.equal(f.calls.length, 1);
  /* the bot gives her at least 3,000 tokens of room whatever an old config says */
  const { buildServices } = await import("../src/services.mjs");
  const { DEFAULTS } = await import("../src/config.mjs");
  const os = await import("node:os"), fs = await import("node:fs"), path = await import("node:path");
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, headers: { get: () => null }, body: sseBody(streamEvents([{ type: "tool_use", id: "t", name: "answer", input: { say: "Yes." } }])) }; };
  await buildServices({ ...DEFAULTS, maxAnswerTokens: 1500, anthropicApiKey: "k", deepgramApiKey: "d" }, { fetchImpl, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "angel-svc-")) }).answer({ conversation: "", question: "q", asker: "A", via: "text" });
  assert.equal(sent[0].max_tokens, 3000);
});

test("cut off after she began to speak: what she said is returned marked as cut; a cut plain reply or a cut text reply is never taken as whole; a garbled lookup is never run", async () => {
  const searched = [];
  const aon = { async search(q) { searched.push(q); return [{ id: "a", name: "A", url: "https://2e.aonprd.com/a" }]; }, async get() { return null; } };
  /* streamed, cut inside say after pieces were passed on */
  let { c, f } = streamingClaude([{ events: streamEvents([{ type: "tool_use", id: "t", name: "answer", rawInput: '{"say": "You can Strike twice but only if' }], { stop: "max_tokens" }) }, { events: [] }]);
  const heard = [];
  const r = await answerQuestion({ claude: c, aon, model: "m", system: "S", conversation: "", question: "q", asker: "A", onSay: t => heard.push(t) });
  assert.equal(r.cut, true);
  assert.equal(r.say, "You can Strike twice but only if");
  assert.equal(f.calls.length, 1, "not asked again: she would say it twice");
  /* the same cut with nobody listening yet (nothing passed on): asked again with twice the room */
  ({ c, f } = streamingClaude([{ events: streamEvents([{ type: "tool_use", id: "t", name: "answer", rawInput: '{"say": "You can Strike twice but only if' }], { stop: "max_tokens" }) }, { events: streamEvents([{ type: "tool_use", id: "t", name: "answer", input: { say: "You can Strike twice." } }]) }]));
  const again = await answerQuestion({ claude: c, aon, model: "m", system: "S", conversation: "", question: "q", asker: "A" });
  assert.equal(again.say, "You can Strike twice.");
  assert.equal(again.cut, undefined);
  /* the plain way: a cut answer with part of say is not whole */
  let plain = fakeClaude([{ stop_reason: "max_tokens", content: [{ type: "tool_use", id: "t", name: "answer", input: { say: "Stunned means you lose" } }], usage: {} }, { content: [{ type: "tool_use", id: "t", name: "answer", input: { say: "Stunned means you lose actions." } }], usage: {} }]);
  assert.equal((await answerQuestion({ claude: plain, aon, model: "m", system: "S", conversation: "", question: "q", asker: "A" })).say, "Stunned means you lose actions.");
  /* a text reply cut twice is not an answer */
  plain = fakeClaude([{ stop_reason: "max_tokens", content: [{ type: "text", text: "Stunned means you lose" }], usage: {} }, { stop_reason: "max_tokens", content: [{ type: "text", text: "Stunned means you lose" }], usage: {} }]);
  assert.match((await answerQuestion({ claude: plain, aon, model: "m", system: "S", conversation: "", question: "q", asker: "A" })).say, /lost my train of thought/);
  /* a lookup whose JSON didn't parse (not cut) is not run; she is told and can ask again */
  ({ c, f } = streamingClaude([
    { events: streamEvents([{ type: "tool_use", id: "bad", name: "aon_search", rawInput: '{"query": "grab"bed"}' }, { type: "tool_use", id: "good", name: "aon_search", input: { query: "grabbed" } }]) },
    { events: streamEvents([{ type: "tool_use", id: "t", name: "answer", input: { say: "Held." } }]) },
  ]));
  const g = await answerQuestion({ claude: c, aon, model: "m", system: "S", conversation: "", question: "q", asker: "A" });
  assert.deepEqual(searched, ["grabbed"], "never a search for nothing");
  assert.equal(g.lookups, 1);
  const results = JSON.parse(f.calls[1].init.body).messages[2].content;
  assert.match(results[0].content, /garbled and was not run/);
  assert.equal(results[0].tool_use_id, "bad");
});
