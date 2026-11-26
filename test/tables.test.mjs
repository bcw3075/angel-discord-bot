/* Tables (0.2.0): one folder per table, picked by where /angel join is typed; listen-only tables; the files of
   before 0.2.0 moved into their table. Made-up servers, channels and names only (this repo is public). */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { loadTables, readTable, pickTable, moveOldFiles, answeringTable, describeTable, pinServers } from "../src/tables.mjs";
import { AngelBot } from "../src/bot.mjs";
import { Session, LISTEN_ONLY_REPLY, summaryText } from "../src/session.mjs";
import { DEFAULTS } from "../src/config.mjs";
import { tonePackets, sleep } from "./helpers.mjs";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "angel-t-"));

function makeTable(root, name, settings, files = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "table.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
  return dir;
}

const guildA = { id: "111", name: "Our Server" };
const guildB = { id: "222", name: "Friend's Server" };

test("(tb-1) a table folder is read; anything that can't be read leaves it out or keeps her listening only", () => {
  const root = tmp(), problems = [];
  makeTable(root, "first", { server: "111", channels: ["#rules-test", "333"], game: "Pathfinder 2e", answers: true });
  const t = readTable(path.join(root, "first"), problems);
  assert.deepEqual([t.server, t.channels, t.answers], ["111", ["rules-test", "333"], true]);
  assert.equal(t.files.houseRules, path.join(root, "first", "house-rules.md"));
  makeTable(root, "noserver", { game: "pf2e" });
  makeTable(root, "broken", "{ server: oops");
  makeTable(root, "numberid", '{ "server": 123456789012345678 }');
  makeTable(root, "otherGame", { server: "222", game: "Another Game", answers: true });
  makeTable(root, "unsure", { server: "222", game: "pf2e", answers: "maybe" });
  makeTable(root, "unsaid", { server: "222", game: "pf2e" });
  fs.mkdirSync(path.join(root, "nofile"));
  const all = loadTables({ dir: root });
  assert.equal(all.legacy, false);
  assert.deepEqual(all.list.map(x => x.name).sort(), ["first", "otherGame", "unsaid", "unsure"]);
  assert.equal(all.list.find(x => x.name === "otherGame").answers, false, "answering only where the rules source exists");
  assert.equal(all.list.find(x => x.name === "unsure").answers, false, "a switch that can't be read means listen only");
  assert.equal(all.list.find(x => x.name === "unsaid").answers, false, "no switch means listen only");
  assert.equal(all.problems.length, 6, all.problems.join("\n"));
  assert.ok(all.problems.some(p => /quote marks/.test(p)));
  assert.match(describeTable(all.list.find(x => x.name === "first")), /111, #rules-test, #333; Pathfinder 2e; answering/);
});

test("(tb-2) no tables folder: one table as before 0.2.0, the files beside the code and config.json's server", () => {
  const t = loadTables({ dir: path.join(tmp(), "none"), guildId: "111", legacyFiles: { houseRules: "h", keyterms: "k", speakers: "s" } });
  assert.equal(t.legacy, true);
  assert.equal(t.list.length, 1);
  assert.deepEqual([t.list[0].server, t.list[0].answers, t.list[0].files.speakers], ["111", true, "s"]);
  assert.equal(pickTable(t, guildA, { id: "any" }).table, t.list[0]);
  assert.equal(pickTable(t, guildB, { id: "any" }).table, null, "another server isn't served, as with guildId before");
  const open = loadTables({ dir: path.join(tmp(), "none") });
  assert.ok(pickTable(open, guildB, { id: "x" }).table, "no guildId: every server, as before");
});

test("(tb-3) the table is picked by where it is typed: the channel's table beats the server's; none or several: none", () => {
  const root = tmp();
  makeTable(root, "main", { server: "Our Server", game: "pf2e", answers: true });
  makeTable(root, "quiet", { server: "111", channels: ["listen-test"], game: "pf2e", answers: false });
  /* a server named by name is served only once its id is written in (review 4) */
  assert.equal(pickTable(loadTables({ dir: root }), guildA, { id: "9", name: "general" }).table.name, "quiet", "the by-name table doesn't serve yet");
  assert.deepEqual(pinServers(loadTables({ dir: root }), [guildA, guildB], quiet), ["main"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "main", "table.json"), "utf8")).server, "111");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "main", "table.json"), "utf8")).answers, true, "its other settings kept");
  makeTable(root, "friend", { server: "222", game: "Another Game" });
  const tables = loadTables({ dir: root });
  const name = (g, c) => pickTable(tables, g, c).table?.name ?? null;
  assert.equal(name(guildA, { id: "9", name: "general" }), "main", "a server's other channels: the table naming no channel");
  assert.equal(name(guildA, { id: "8", name: "Listen-Test" }), "quiet", "by channel name, any case");
  assert.equal(name(guildA, { id: "7", name: "Thread", type: 11, parentId: "8", parent: { name: "listen-test" } }), "quiet", "a thread counts as its channel");
  assert.equal(name(guildB, { id: "1", name: "x" }), "friend", "the one table on a server, by id");
  assert.equal(name({ id: "333", name: "Elsewhere" }, { id: "1" }), null, "a server with no table");
  makeTable(root, "second", { server: "111", game: "pf2e", answers: true });
  const two = pickTable(loadTables({ dir: root }), guildA, { id: "9", name: "general" });
  assert.equal(two.table, null, "two tables on one server with no channel named: she can't tell, so none");
  assert.equal(two.why, "several");
  assert.equal(pickTable(loadTables({ dir: root }), guildA, { id: "8", name: "listen-test" }).table.name, "quiet", "the channel still decides");
});

test("(tb-4) the files beside the code move into the one answering table; a differing copy is kept as .old", () => {
  const root = tmp(), dir = path.join(root, "tables");
  makeTable(dir, "main", { server: "111", game: "pf2e", answers: true }, { "house-rules.md": "Rules A" });
  makeTable(dir, "quiet", { server: "222", game: "Another Game" });
  fs.writeFileSync(path.join(root, "house-rules.md"), "Rules OLD");
  fs.writeFileSync(path.join(root, "keyterms.txt"), "Name One");
  fs.writeFileSync(path.join(root, "speakers.json"), '{"1":{"name":"Mira"}}');
  const r = moveOldFiles({ tables: loadTables({ dir }), root, log: quiet });
  assert.equal(r.target, "main");
  assert.equal(fs.readFileSync(path.join(dir, "main", "speakers.json"), "utf8"), '{"1":{"name":"Mira"}}');
  assert.equal(fs.readFileSync(path.join(dir, "main", "keyterms.txt"), "utf8"), "Name One");
  assert.equal(fs.readFileSync(path.join(dir, "main", "house-rules.md"), "utf8"), "Rules A", "the table's own copy wins");
  assert.equal(fs.readFileSync(path.join(root, "house-rules.md.old"), "utf8"), "Rules OLD", "the old one is kept, not lost");
  for (const f of ["house-rules.md", "keyterms.txt", "speakers.json"]) assert.ok(!fs.existsSync(path.join(root, f)), `${f} moved`);
  assert.equal(fs.existsSync(path.join(dir, "quiet", "speakers.json")), false, "nothing reaches the other table");
  assert.equal(moveOldFiles({ tables: loadTables({ dir }), root, log: quiet }), null, "a second start finds nothing to move");
  /* an identical copy is simply removed */
  fs.writeFileSync(path.join(root, "keyterms.txt"), "Name One");
  moveOldFiles({ tables: loadTables({ dir }), root, log: quiet });
  assert.ok(!fs.existsSync(path.join(root, "keyterms.txt")) && !fs.existsSync(path.join(root, "keyterms.txt.old")));
  /* two answering tables and no guildId: it can't tell, so nothing moves */
  makeTable(dir, "third", { server: "333", game: "pf2e", answers: true });
  fs.writeFileSync(path.join(root, "speakers.json"), "{}");
  const warned = [];
  assert.equal(moveOldFiles({ tables: loadTables({ dir }), root, log: { ...quiet, warn: t => warned.push(t) } }), null);
  assert.ok(fs.existsSync(path.join(root, "speakers.json")) && warned.length === 1);
  /* with guildId it can */
  assert.equal(moveOldFiles({ tables: loadTables({ dir }), root, guildId: "333", log: quiet }).target, "third");
  assert.equal(moveOldFiles({ tables: loadTables({ dir: path.join(root, "none") }), root, log: quiet }), null, "no tables: nothing moves");
});

test("(tb-5) Test Angel.cmd answers for the one table that answers", () => {
  const root = tmp();
  makeTable(root, "main", { server: "111", game: "pf2e", answers: true });
  makeTable(root, "quiet", { server: "222", game: "Another Game" });
  assert.equal(answeringTable(loadTables({ dir: root })).table.name, "main");
  makeTable(root, "third", { server: "333", game: "pf2e", answers: true });
  assert.match(answeringTable(loadTables({ dir: root })).why, /2 tables answer/);
});

/* ---- a listen-only session ---- */

class FakeVoice extends EventEmitter {
  constructor() { super(); this.spoken = []; this.left = false; }
  speak(clips) { this.spoken.push(...clips); return Promise.resolve(); }
  stopSpeaking() {}
  inEchoWindow() { return false; }
  ignore() {}
  leave() { this.left = true; }
}
const made = [];
afterEach(() => { for (const x of made.splice(0)) { try { x.end(); } catch { /* ended */ } } });

test("(tb-6) where she only listens: every line is transcribed, and no check, answer, lookup or word aloud follows", async () => {
  const voice = new FakeVoice(), posted = [];
  const heard = ["Angel, what does grabbed do?", "Angel, stop.", "Hey Angel, you there?", "We go left at the river."];
  const calls = { gate: 0, answer: 0, tts: 0, hold: 0, ready: 0 };
  const s = new Session({
    cfg: { ...DEFAULTS }, voice, listenOnly: true,
    post: { send: async text => { posted.push(text); return { edit: async () => {} }; } },
    stt: async () => ({ text: heard.shift() ?? "", seconds: 1 }),
    tts: async () => { calls.tts++; return [Buffer.from("x")]; },
    gate: async () => { calls.gate++; return { toAngel: true, complete: true }; },
    hold: async () => { calls.hold++; return { kind: "none" }; },
    readyLine: async () => { calls.ready++; return { text: "Ready" }; },
    answer: async () => { calls.answer++; return { say: "No.", sources: [], dollars: 0 }; },
    speakerOf: id => ({ name: id === "gm" ? "Dana" : "Mira", role: id === "gm" ? "GM" : "player" }),
    log: quiet,
  });
  made.push(s);
  await s.start();
  const t0 = Date.now();
  for (let k = 0; k < 4; k++) voice.emit("speech", { userId: k % 2 ? "gm" : "p1", packets: tonePackets(1), startedAt: t0 + k * 1000, final: true });
  for (let i = 0; i < 40; i++) await sleep(5);
  await s.answering;
  assert.deepEqual(s.transcript.lines.map(l => l.text), ["Angel, what does grabbed do?", "Angel, stop.", "Hey Angel, you there?", "We go left at the river."]);
  /* (tr-12) each line keeps when its piece ended (a second of sound after it began), for tidying the transcript */
  assert.deepEqual(s.transcript.lines.map(l => l.end - l.at), [1000, 1000, 1000, 1000]);
  assert.deepEqual(calls, { gate: 0, answer: 0, tts: 0, hold: 0, ready: 0 }, "nothing but listening is paid for");
  assert.equal(voice.spoken.length, 0, "never a word aloud");
  assert.equal(posted.length, 0, "nothing posted either");
  assert.equal(s.floor, null, "no busy-table watch");
  /* a typed question: kept, and one short line back */
  const replies = [];
  await s.textQuestion({ userId: "p1", asker: "Mira", text: "Angel, is this right?", reply: { send: async t => { replies.push(t); } } });
  assert.deepEqual(replies, [LISTEN_ONLY_REPLY]);
  assert.equal(calls.answer, 0);
  assert.equal(s.transcript.lines.find(l => l.text === "Angel, is this right?")?.kind, "text");
  /* after going deaf and rejoining: a written note only */
  await s.rejoined();
  await sleep(5);
  assert.equal(posted.length, 1);
  assert.match(posted[0], /rejoined the voice channel/);
  assert.doesNotMatch(posted[0], /asked me/);
  assert.equal(voice.spoken.length, 0, "the rejoin isn't said aloud there");
  assert.equal(calls.tts, 0);
  const st = s.end();
  assert.equal(st.listenOnly, true);
  assert.ok(st.costs.stt > 0);
  assert.match(summaryText(st), /^Session over: \d+ min, 5 transcript lines\. Cost about \$0\.\d\d \(listening\)\.$/);
});

/* ---- the bot with tables ---- */

class FakeVoiceLink extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; }
  async join() {}
  speak() { return Promise.resolve(); }
  stopSpeaking() {}
  inEchoWindow() { return false; }
  ignore() {}
  leave() { this.left = true; }
}

function world(guild = guildA) {
  const sent = [];
  const mk = (id, name) => ({ id, name, send: async m => { const msg = { content: m.content ?? m, channel: id, edit: async t => { msg.content = t; } }; sent.push(msg); return msg; } });
  const members = new Map([
    ["gm", { displayName: "Dana", user: { bot: false }, permissions: { has: () => true } }],
    ["p1", { displayName: "Sam", user: { bot: false }, permissions: { has: () => false } }],
  ]);
  const g = { ...guild, ownerId: "gm", members: { cache: members }, voiceAdapterCreator: () => ({}), channels: { cache: new Map() } };
  const vc = { id: "vc1", name: "Game Night", guild: g, members: { filter: f => ({ size: [...members.values()].filter(f).length }) } };
  g.channels.cache.set("vc1", vc);
  return { sent, guild: g, vc, general: mk("c1", "general"), listen: mk("c2", "listen-test") };
}

function interaction(w, sub, channel, { user = "p1", strings = {} } = {}) {
  const i = {
    replies: [], edits: [],
    isChatInputCommand: () => true, commandName: "angel",
    options: { getSubcommand: () => sub, getString: k => strings[k] },
    guildId: w.guild.id, guild: w.guild, channel, channelId: channel.id,
    user: { id: user }, member: { voice: { channel: w.vc } },
    reply: async r => { i.replies.push(r); },
    deferReply: async () => {},
    editReply: async t => { i.edits.push(typeof t === "string" ? t : t.content); },
  };
  return i;
}

function makeBot(tablesDir) {
  const dataDir = tmp(), answers = [], sttTerms = [];
  const services = {
    keytermCount: 1,
    keytermsOf: t => ["Angel", `${t.name}-term`],
    stt: async (wav, o = {}) => { sttTerms.push(o.terms); return { text: "", seconds: 0 }; },
    tts: async () => [], gate: async () => ({ toAngel: false }), hold: async () => ({ kind: "none" }), readyLine: async () => ({ text: "Ready." }),
    answer: async q => { answers.push(q); return { say: `Answer: ${q.question}`, sources: [], dollars: 0.01 }; },
  };
  const bot = new AngelBot({ cfg: { ...DEFAULTS, ackPhrase: "", guildId: "999" }, log: quiet, services, dataDir, speakersFile: path.join(dataDir, "speakers.json"), tablesDir, VoiceLinkClass: FakeVoiceLink });
  bot.client = { user: { id: "angel1" }, destroy() {} };
  return { bot, answers, dataDir, sttTerms };
}

function twoTables() {
  const root = tmp();
  makeTable(root, "main", { server: "111", game: "pf2e", answers: true }, { "house-rules.md": "Main rules", "speakers.json": '{"p1":{"name":"Kael"}}' });
  makeTable(root, "quiet", { server: "111", channels: ["listen-test"], game: "Another Game", answers: false, transcriptKeptBy: "Sam" });
  return root;
}

test("(tb-7) /angel join where she only listens: says so once in text, never speaks, keeps the transcript in that table's folder", async () => {
  const root = twoTables(), w = world(), { bot, dataDir, answers } = makeBot(root);
  const i = interaction(w, "join", w.listen);
  await bot.onInteraction(i);
  assert.match(i.edits[0], /At this table I only listen: I won't speak or answer questions/);
  assert.match(i.edits[0], /on Sam's computer/);
  assert.match(i.edits[0], /\/angel optout/);
  assert.doesNotMatch(i.edits[0], /Angel, \.\.\.|stop/, "no invitation to ask her");
  const live = bot.sessions.get("111");
  assert.equal(live.table.name, "quiet");
  assert.equal(live.session.listenOnly, true);
  assert.ok(fs.existsSync(path.join(dataDir, "sessions", "quiet")), "the transcript is in that table's own folder");
  assert.ok(!fs.existsSync(path.join(dataDir, "sessions", "main")));
  /* typed to her, in that channel: one short line, no answer */
  const replies = [];
  await bot.onMessage({ author: { id: "p1", bot: false }, guild: w.guild, channel: w.listen, channelId: "c2", content: "Angel, what's the rule?", reply: async r => { replies.push(r.content); } });
  await bot.onMessage({ author: { id: "p1", bot: false }, guild: w.guild, channel: w.listen, channelId: "c2", content: "<@angel1> flanking?", reply: async r => { replies.push(r.content); } });
  assert.deepEqual(replies, [LISTEN_ONLY_REPLY, LISTEN_ONLY_REPLY]);
  const ask = interaction(w, "ask", w.listen, { strings: { question: "flanking?" } });
  await bot.onInteraction(ask);
  assert.equal(ask.replies[0].content, LISTEN_ONLY_REPLY);
  assert.equal(answers.length, 0, "no answer and no lookup at all");
  assert.ok(live.session.transcript.lines.some(l => l.text === "flanking?"), "what was typed to her is in the transcript");
  /* /angel iam there writes that table's speakers only */
  await bot.onInteraction(interaction(w, "iam", w.listen, { strings: { name: "Wren" } }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "quiet", "speakers.json"), "utf8")).p1.name, "Wren");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "main", "speakers.json"), "utf8")).p1.name, "Kael", "the other table's name is untouched");
  assert.equal(live.session.speakerOf("p1").name, "Wren", "the session uses its own table's names");
  await bot.end("111", "test");
  assert.match(w.sent.at(-1).content, /\(listening\)/);
});

test("(tb-8) the answering table on the same server: its own house rules, names and key terms; another server with no table is refused", async () => {
  const root = twoTables(), w = world(), { bot, answers, dataDir, sttTerms } = makeBot(root);
  const i = interaction(w, "join", w.general);
  await bot.onInteraction(i);
  assert.match(i.edits[0], /so I can answer rules questions/);
  assert.match(i.edits[0], /on the GM's computer/, "the notice of before 0.2.0");
  const live = bot.sessions.get("111");
  assert.equal(live.table.name, "main");
  assert.equal(live.session.listenOnly, false);
  assert.equal(live.session.speakerOf("p1").name, "Kael");
  assert.ok(fs.existsSync(path.join(dataDir, "sessions", "main")));
  await live.session.stt(Buffer.from("x"), { names: [] });
  assert.deepEqual(sttTerms.at(-1), ["Angel", "stop", "main-term"], "the transcriber gets this table's key terms, and \"stop\" where she answers (0.2.1)");
  assert.equal(live.session.keytermCount, 3, "and they are counted");
  await bot.onMessage({ author: { id: "p1", bot: false }, guild: w.guild, channel: w.general, channelId: "c1", content: "Angel, flanking?", reply: async () => ({ edit: async () => {} }) });
  await live.session.answering;
  assert.equal(answers.length, 1);
  assert.equal(answers[0].table.name, "main", "answered with that table's house rules");
  /* typed in the listen-only channel while the main session runs: not the session's, and no answer */
  const replies = [];
  await bot.onMessage({ author: { id: "p1", bot: false }, guild: w.guild, channel: w.listen, channelId: "c2", content: "Angel, flanking?", reply: async r => { replies.push(r.content); } });
  assert.deepEqual(replies, [LISTEN_ONLY_REPLY]);
  assert.equal(answers.length, 1);
  await bot.end("111", "test");
  /* a server with no table: nothing */
  const other = world({ id: "555", name: "Stranger" });
  const j = interaction(other, "join", other.general);
  await bot.onInteraction(j);
  assert.match(j.replies[0].content, /No table is set up for this server/);
  assert.equal(bot.sessions.size, 0);
  assert.equal(bot.serves({ id: "999" }), false, "guildId in config.json isn't used while there are tables");
});

test("(tb-9) two tables on a server and a channel neither names: she doesn't join, and says why", async () => {
  const root = tmp();
  makeTable(root, "one", { server: "111", game: "pf2e", answers: true });
  makeTable(root, "two", { server: "111", game: "pf2e", answers: true });
  const w = world(), { bot } = makeBot(root);
  const i = interaction(w, "join", w.general);
  await bot.onInteraction(i);
  assert.match(i.replies[0].content, /More than one table is set up on this server \(one, two\)/);
  assert.equal(bot.sessions.size, 0);
});

test("(tb-10) both spending caps count every table together", async () => {
  const root = tmp();
  makeTable(root, "main", { server: "111", game: "pf2e", answers: true });
  makeTable(root, "far", { server: "222", game: "Another Game" });
  const { bot } = makeBot(root);
  bot.cfg.maxDailyDollars = 1;
  const a = world(guildA), b = world(guildB);
  await bot.onInteraction(interaction(a, "join", a.general));
  await bot.onInteraction(interaction(b, "join", b.general));
  assert.equal(bot.sessions.size, 2);
  bot.sessions.get("111").session.costs.stt = 0.6;
  bot.sessions.get("222").session.costs.stt = 0.5;
  assert.equal(bot.dailyOver(), true, "0.60 + 0.50 is past the day's $1");
  assert.equal(bot.sessions.get("222").session.overCap(), true, "the listening table stops too");
  await bot.endAll("test");
});

test("(tb-15) /angel is set up on each table's server at start and when she is invited to one while running; nowhere else", async () => {
  const root = tmp();
  makeTable(root, "main", { server: "111", game: "pf2e", answers: true });
  makeTable(root, "far", { server: "Friend's Server", game: "Another Game" });
  const { bot } = makeBot(root);
  const logged = [];
  bot.log = { ...quiet, info: t => logged.push(t), warn: t => logged.push(t) };
  const server = g => ({ ...g, set: [], commands: { set: async c => { server.calls.push(g.id); return c; } } });
  server.calls = [];
  await bot.onReady({ user: { tag: "Angel#0001", id: "42" }, guilds: { cache: new Map([["111", server(guildA)], ["555", server({ id: "555", name: "Stranger" })]]) } });
  assert.deepEqual(server.calls, ["111"]);
  assert.ok(logged.some(t => /table far: .*not in that server yet/.test(t)));
  /* two servers of the name: nothing written, both ids named */
  const warnedTwo = [];
  pinServers(loadTables({ dir: root }), [guildB, { id: "223", name: "Friend's Server" }], { ...quiet, warn: t => warnedTwo.push(t) });
  assert.match(warnedTwo[0], /2 servers I'm in have that name \(ids 222, 223\)/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "far", "table.json"), "utf8")).server, "Friend's Server");
  /* a server in an outage at the time: nothing is pinned (review 5) */
  assert.deepEqual(pinServers(loadTables({ dir: root }), [guildB, { id: "224", available: false }], quiet), []);
  assert.ok(logged.some(t => /to invite me to another table's server: https:\/\/discord\.com\/oauth2\/authorize\?client_id=42&/.test(t)));
  /* invited while running: a table naming that server by name gets its id written in, and /angel is set up */
  bot.client.guilds = { cache: new Map([["111", guildA]]) };
  await bot.onNewServer(server(guildB));
  assert.deepEqual(server.calls, ["111", "222"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "far", "table.json"), "utf8")).server, "222");
  /* a second server of the same name later: not this table's */
  await bot.onNewServer(server({ id: "999", name: "Friend's Server" }));
  await bot.onNewServer(server({ id: "777", name: "Nobody" }));
  assert.deepEqual(server.calls, ["111", "222"]);
});

test("(tb-16) review 1: a thread counts only as its parent; a voice channel another table names isn't joined as this one; an earlier .old is kept; guildId's table comes first; a mid-session table.json edit doesn't split the session", async () => {
  const root = tmp();
  makeTable(root, "main", { server: "111", game: "pf2e", answers: true });
  makeTable(root, "quiet", { server: "111", channels: ["listen-test", "vc-quiet"], game: "Another Game", answers: false });
  const tables = loadTables({ dir: root });
  assert.equal(pickTable(tables, guildA, { id: "t1", name: "listen-test", isThread: () => true, parentId: "9", parent: { name: "general" } }).table.name, "main", "a thread named like another table's channel is still its parent's");
  /* the voice channel */
  const w = world(), { bot } = makeBot(root);
  const quietVoice = { ...w.vc, id: "vc-quiet", name: "vc-quiet" };
  const i = interaction(w, "join", w.general);
  i.member.voice.channel = quietVoice;
  await bot.onInteraction(i);
  assert.match(i.replies[0].content, /belongs to another table \(quiet\)/);
  assert.equal(bot.sessions.size, 0);
  /* .old never overwritten */
  const pc = tmp(), dir = path.join(pc, "tables");
  makeTable(dir, "main", { server: "111", game: "pf2e", answers: true }, { "house-rules.md": "A" });
  fs.writeFileSync(path.join(pc, "house-rules.md.old"), "FIRST");
  fs.writeFileSync(path.join(pc, "house-rules.md"), "SECOND");
  moveOldFiles({ tables: loadTables({ dir }), root: pc, log: quiet });
  assert.equal(fs.readFileSync(path.join(pc, "house-rules.md.old"), "utf8"), "FIRST");
  assert.equal(fs.readFileSync(path.join(pc, "house-rules.md.old2"), "utf8"), "SECOND");
  /* guildId's table before the one answering table */
  makeTable(dir, "home", { server: "777", game: "Another Game" });
  fs.writeFileSync(path.join(pc, "speakers.json"), "{}");
  assert.equal(moveOldFiles({ tables: loadTables({ dir }), root: pc, guildId: " 777 ", log: quiet }).target, "home");
  /* answers switched off mid-session: the session's typed side stays as joined */
  const w2 = world(), b2 = makeBot(root);
  await b2.bot.onInteraction(interaction(w2, "join", w2.general));
  fs.writeFileSync(path.join(root, "main", "table.json"), JSON.stringify({ server: "111", game: "pf2e", answers: false }));
  const replies = [];
  await b2.bot.onMessage({ author: { id: "p1", bot: false }, guild: w2.guild, channel: w2.general, channelId: "c1", content: "Angel, flanking?", reply: async r => { replies.push(r.content); return { edit: async () => {} }; } });
  await b2.bot.sessions.get("111").session.answering;
  assert.equal(b2.answers.length, 1, "answered as the session was joined");
  await b2.bot.endAll("test");
});

test("(tb-18) review 3: leave, stop, status and rejoin from another table's channel don't touch the server's session; plain 'Pathfinder' isn't taken as 2e", async () => {
  const root = twoTables(), w = world(), { bot } = makeBot(root);
  await bot.onInteraction(interaction(w, "join", w.listen));
  for (const sub of ["leave", "stop", "status", "rejoin"]) {
    const i = interaction(w, sub, w.general);
    await bot.onInteraction(i);
    assert.match(i.replies[0].content, /another table on this server right now \(quiet\)/, sub);
  }
  assert.equal(bot.sessions.size, 1, "still running");
  const own = interaction(w, "leave", w.listen);
  await bot.onInteraction(own);
  assert.equal(bot.sessions.size, 0);
  const r2 = tmp();
  makeTable(r2, "old", { server: "1", game: "Pathfinder", answers: true });
  assert.equal(loadTables({ dir: r2 }).list[0].answers, false);
  for (const g of ["pf2e", "PF 2e", "Pathfinder 2e", "Pathfinder 2nd Edition", "Pathfinder Second Edition", "Pathfinder 2e (Remaster)", "PF2e Remaster"]) {
    makeTable(r2, "old", { server: "1", game: g, answers: true });
    assert.equal(loadTables({ dir: r2 }).list[0].answers, true, g);
  }
  /* the session's table gone (renamed during the session): leave still works from anywhere */
  const r3 = twoTables(), w3 = world(), b3 = makeBot(r3).bot;
  await b3.onInteraction(interaction(w3, "join", w3.listen));
  fs.renameSync(path.join(r3, "quiet"), path.join(r3, "quiet2"));
  const gone = interaction(w3, "leave", w3.general);
  await b3.onInteraction(gone);
  assert.equal(b3.sessions.size, 0);
  /* the session's table moved to another server during the session: leave still works (review 5) */
  const r4 = twoTables(), w4 = world(), b4 = makeBot(r4).bot;
  await b4.onInteraction(interaction(w4, "join", w4.listen));
  fs.writeFileSync(path.join(r4, "quiet", "table.json"), JSON.stringify({ server: "999", channels: ["listen-test"], game: "Another Game" }));
  await b4.onInteraction(interaction(w4, "leave", w4.general));
  assert.equal(b4.sessions.size, 0);
});

test("(tb-17) review 2: a channel in a category is still itself; an unknown channel where tables share a server picks none; guildId's server with two tables takes the answering one", () => {
  const root = tmp();
  makeTable(root, "main", { server: "111", game: "pf2e", answers: true });
  makeTable(root, "quiet", { server: "111", channels: ["listen-test"], game: "Another Game", answers: false });
  const tables = loadTables({ dir: root });
  assert.equal(pickTable(tables, guildA, { id: "8", name: "listen-test", type: 0, parentId: "cat", parent: { name: "Text Channels" } }).table.name, "quiet", "a text channel in a category");
  assert.equal(pickTable(tables, guildA, { id: "8", name: "listen-test", isThread: () => false, parentId: "cat", parent: { name: "Text Channels" } }).table.name, "quiet");
  assert.equal(pickTable(tables, guildA, { id: "9", name: "general", type: 0, parentId: "cat", parent: { name: "listen-test" } }).table.name, "main", "a category named like a channel doesn't count");
  assert.equal(pickTable(tables, guildA, { id: "8", unknown: true }).why, "unknown");
  const pc = tmp(), dir = path.join(pc, "tables");
  makeTable(dir, "a-quiet", { server: "111", game: "Another Game" });
  makeTable(dir, "b-main", { server: "111", game: "pf2e", answers: true });
  fs.writeFileSync(path.join(pc, "speakers.json"), "{}");
  assert.equal(moveOldFiles({ tables: loadTables({ dir }), root: pc, guildId: "111", log: quiet }).target, "b-main");
});
