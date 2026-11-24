/* Direct-message replies with a stand-in Claude: only contacts with notes are answered, from their notes; requests,
   bugs and unanswered questions are saved for the owner and sent to her; both sides are kept; the limits hold. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DirectReplies, readReply, systemPromptDm } from "../src/dm.mjs";
import { AngelBot } from "../src/bot.mjs";
import { DEFAULTS } from "../src/config.mjs";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const GM = "123456789012345678";

function setup({ answer = { reply: "It's under **Games**.", kind: "answer", forOwner: "" }, contacts, notes = "Games: create a game under **Games**.", fail = false, ...extra } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "angel-dm-"));
  fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify(contacts ?? { "table-gm": { user: GM, notes: "site.md", about: "runs the game" }, _owner: "Sam" }));
  if (notes !== null) { fs.mkdirSync(path.join(dir, "notes")); fs.writeFileSync(path.join(dir, "notes", "site.md"), notes); }
  const calls = [], owner = [], spends = [];
  const claude = {
    spent: 0,
    async create(body) {
      calls.push(body);
      if (fail) throw new Error("Claude answered 529: overloaded");
      this.spent += 0.01;
      return { content: [{ type: "text", text: typeof answer === "string" ? answer : JSON.stringify(answer) }] };
    },
  };
  const d = new DirectReplies({ dataDir: dir, log: quiet, claude, model: "m", addSpend: x => spends.push(x), dmOwner: async t => { owner.push(t); }, ...extra });
  const replies = [];
  const ask = (text, userId = GM) => d.onDirect({ userId, text, reply: async t => { replies.push(t); } });
  return { dir, d, calls, owner, spends, replies, ask };
}

test("readReply takes the JSON asked for, a fenced or wrapped one, and prose as an unknown", () => {
  assert.deepEqual(readReply('{"reply":"hi","kind":"chat","forOwner":""}'), { reply: "hi", kind: "chat", forOwner: "" });
  assert.equal(readReply('```json\n{"reply":"a","kind":"bug","forOwner":"x"}\n```').kind, "bug");
  assert.equal(readReply('Sure! {"reply":"b","kind":"answer"}').reply, "b");
  assert.equal(readReply('{"reply":"c","kind":"weird"}').kind, "unknown");
  const prose = readReply("Just words");
  assert.equal(prose.reply, "Just words");
  assert.equal(prose.kind, "unknown");
});

test("the prompt holds the notes, the contact and the owner's name, and says to answer only from the notes", () => {
  const p = systemPromptDm({ contact: "table-gm", about: "runs it", notes: "NOTES-HERE", ownerName: "Sam" });
  assert.match(p, /NOTES-HERE/);
  assert.match(p, /table-gm/);
  assert.match(p, /ONLY from the notes/);
  assert.match(p, /check with Sam/);
  assert.match(p, /no run-on sentences/);
  assert.match(p, /bullets for any list/);
  assert.match(p, /list of rules calls/);
  assert.match(p, /Bugs don't wait for Sam's approval/);
  assert.match(p, /Sam will look it over/);
});

test("a contact's question is answered from the notes, counted against the cap, and both sides kept", async () => {
  const { dir, calls, replies, spends, owner, ask } = setup();
  const r = await ask("Where do I make a game?");
  assert.deepEqual(r, { answered: true, kind: "answer" });
  assert.deepEqual(replies, ["It's under **Games**."]);
  assert.match(calls[0].system[0].text, /create a game under \*\*Games\*\*/);
  assert.match(calls[0].system[0].text, /check with Sam/);
  assert.deepEqual(calls[0].system[0].cache_control, { type: "ephemeral" });
  assert.deepEqual(calls[0].messages, [{ role: "user", content: "Where do I make a game?" }]);
  assert.deepEqual(spends, [0.01]);
  assert.equal(owner.length, 0);
  const md = fs.readFileSync(path.join(dir, "conversations", "table-gm.md"), "utf8");
  assert.match(md, /\*\*table-gm:\*\* Where do I make a game\?/);
  assert.match(md, /\*\*Angel:\*\* It's under \*\*Games\*\*\./);
  assert.ok(!fs.existsSync(path.join(dir, "inbox")));
});

test("the conversation goes on: earlier exchanges are given with the next message", async () => {
  const { calls, ask } = setup();
  await ask("first");
  await ask("second");
  assert.deepEqual(calls[1].messages.map(m => m.role), ["user", "assistant", "user"]);
  assert.equal(calls[1].messages[0].content, "first");
  assert.equal(calls[1].messages[2].content, "second");
});

test("a request or a bug is thanked, saved in the inbox and sent to the owner", async () => {
  const { dir, owner, ask } = setup({ answer: { reply: "Thanks! I've passed it on.", kind: "bug", forOwner: "The Fear tracker doesn't update" } });
  await ask("Fear didn't update for me");
  const inbox = fs.readdirSync(path.join(dir, "inbox"));
  assert.equal(inbox.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "inbox", inbox[0]), "utf8"));
  assert.equal(saved.from, "table-gm");
  assert.equal(saved.kind, "bug");
  assert.equal(saved.them, "Fear didn't update for me");
  assert.equal(owner.length, 1);
  assert.match(owner[0], /table-gm sent a bug: The Fear tracker doesn't update/);
  assert.match(owner[0], /What I told them: Thanks!/);
});

test("someone who isn't a contact, or a contact without notes, gets no answer and costs nothing", async () => {
  const { calls, replies, ask } = setup({ contacts: { "table-gm": { user: GM, notes: "site.md" }, plain: { user: "999999999999999999" } } });
  assert.equal((await ask("hi", "555555555555555555")).why, "not a contact");
  assert.equal((await ask("hi", "999999999999999999")).why, "not a contact");
  assert.equal(calls.length, 0);
  assert.equal(replies.length, 0);
});

test("a missing notes file, a notes path outside data/notes, a failed call or the limit: a holding reply, saved for the owner", async () => {
  const a = setup({ notes: null });
  assert.equal((await a.ask("hi")).why, "the notes file site.md is missing");
  assert.match(a.replies[0], /passed that to Sam/);
  assert.equal(a.calls.length, 0);
  assert.equal(a.owner.length, 1);
  assert.equal(fs.readdirSync(path.join(a.dir, "inbox")).length, 1);

  const b = setup({ contacts: { "table-gm": { user: GM, notes: "../contacts.json" } } });
  assert.match((await b.ask("hi")).why, /missing/);
  assert.equal(b.calls.length, 0);

  const c = setup({ fail: true });
  assert.equal((await c.ask("hi")).why, "the answer failed");
  assert.match(c.replies[0], /couldn't look that up/);

  const d = setup({ maxPerDay: 1 });
  await d.ask("one");
  assert.equal((await d.ask("two")).why, "today's limit reached");
  assert.equal(d.calls.length, 1);

  const e = setup({ canSpend: () => false });
  assert.equal((await e.ask("hi")).why, "today's limit reached");
  assert.equal(e.calls.length, 0);
});

test("two messages at once are answered one after the other, in order", async () => {
  const { replies, calls, ask } = setup({ answer: { reply: "ok", kind: "chat", forOwner: "" } });
  await Promise.all([ask("a"), ask("b")]);
  assert.equal(replies.length, 2);
  assert.equal(calls[1].messages.at(-1).content, "b");
  assert.equal(calls[1].messages.length, 3);
});

test("the bot sends a direct message to DirectReplies and answers in that channel with no pings; directReplies: false turns it off", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "angel-dmb-"));
  fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify({ "table-gm": { user: GM, notes: "site.md" } }));
  fs.mkdirSync(path.join(dir, "notes")); fs.writeFileSync(path.join(dir, "notes", "site.md"), "notes");
  const claude = { spent: 0, async create() { return { content: [{ type: "text", text: '{"reply":"hello <@everyone>","kind":"chat"}' }] }; } };
  const b = new AngelBot({ cfg: { ...DEFAULTS }, log: quiet, services: { claude }, dataDir: dir, tablesDir: path.join(dir, "tables") });
  clearInterval(b.bookTimer);
  const sent = [];
  const m = { author: { id: GM, bot: false }, guild: null, content: "hi", channel: { send: async x => { sent.push(x); return {}; } } };
  await b.onMessage(m);
  assert.deepEqual(sent, [{ content: "hello <@everyone>", allowedMentions: { parse: [] } }]);
  await b.onMessage({ ...m, author: { id: GM, bot: true } });
  assert.equal(sent.length, 1);
  b.cfg.directReplies = false;
  await b.onMessage(m);
  assert.equal(sent.length, 1);
});

test("a contact named by username is answered when that username writes, whatever its capitals", async () => {
  const { replies, ask, d } = setup({ contacts: { "table-gm": { username: "some_gm", notes: "site.md" } } });
  const r = await d.onDirect({ userId: "777777777777777777", username: "Some_GM", text: "hi", reply: async t => { replies.push(t); } });
  assert.equal(r.answered, true);
  assert.equal((await ask("hi", "888888888888888888")).why, "not a contact");
});

test("a reply written twice with words around it (seen live, 2026-11-23): only the last object's reply is sent", async () => {
  const live = 'Good question! Here\'s the list:\n- one\n\n```json\n{"reply": "First {draft} with \\"quotes\\"", "kind": "answer", "forOwner": ""}\n```\n\nWait, correcting myself: the output must be only the JSON object.\n\n{"reply": "Final answer", "kind": "unknown", "forOwner": "asked about a list"}';
  assert.deepEqual(readReply(live), { reply: "Final answer", kind: "unknown", forOwner: "asked about a list" });
  const { replies, ask } = setup({ answer: live });
  await ask("q");
  assert.deepEqual(replies, ["Final answer"]);
  assert.equal(readReply("prose ```json\n{broken\n```").reply, "prose");
  assert.ok(!/```/.test(readReply("```json\n{nope}\n```").reply));
});
