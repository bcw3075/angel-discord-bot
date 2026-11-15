/* The Discord side with stand-ins: the /angel commands, typed questions, table chat and leaving an empty channel.
   No Discord login: the bot's handlers are called with objects shaped like discord.js's. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AngelBot, threadName } from "../src/bot.mjs";
import { DEFAULTS } from "../src/config.mjs";
import { sleep } from "./helpers.mjs";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

class FakeVoiceLink extends EventEmitter {
  static made = [];
  constructor(opts) { super(); this.opts = opts; this.ignored = []; this.left = false; FakeVoiceLink.made.push(this); }
  async join() { if (this.opts.channel.failJoin) throw new Error("Couldn't connect to the voice channel within 30 seconds."); }
  speak() { return Promise.resolve(); }
  stopSpeaking() { this.stopped = true; }
  inEchoWindow() { return false; }
  ignore(id) { this.ignored.push(id); }
  leave() { this.left = true; }
}

function world() {
  const sent = [];
  const textChannel = { id: "tc1", send: async m => { const msg = { content: m.content ?? m, edit: async t => { msg.content = t; } }; sent.push(msg); return msg; } };
  const members = new Map([
    ["gm", { displayName: "Dana", user: { bot: false }, permissions: { has: () => true } }],
    ["p1", { displayName: "Sam", user: { bot: false }, permissions: { has: () => false } }],
    ["botty", { displayName: "Music", user: { bot: true }, permissions: { has: () => false } }],
  ]);
  const voiceMembers = new Map([["gm", members.get("gm")], ["p1", members.get("p1")]]);
  const guild = { id: "g1", name: "Table", ownerId: "gm", members: { cache: members }, voiceAdapterCreator: () => ({}), channels: { cache: new Map() } };
  const vc = { id: "vc1", name: "Game Night", guild, members: { filter: f => ({ size: [...voiceMembers.values()].filter(f).length }) } };
  guild.channels.cache.set("vc1", vc);
  return { sent, textChannel, guild, vc, voiceMembers };
}

function interaction(w, sub, { user = "p1", strings = {}, inVoice = true } = {}) {
  const i = {
    replies: [], edits: [], deferred: false,
    isChatInputCommand: () => true, commandName: "angel",
    options: { getSubcommand: () => sub, getString: k => strings[k] },
    guildId: "g1", guild: w.guild, channel: w.textChannel, channelId: "tc1",
    user: { id: user }, member: { voice: { channel: inVoice ? w.vc : null } },
    reply: async r => { i.replies.push(r); },
    deferReply: async () => { i.deferred = true; },
    editReply: async t => { i.edits.push(typeof t === "string" ? t : t.content); if (typeof t === "object") i.lastEditOptions = t; },
  };
  return i;
}

function makeBot(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "angel-b-"));
  const answers = [];
  const services = {
    keytermCount: 1,
    stt: async () => ({ text: "", seconds: 0 }),
    tts: async () => [],
    gate: async () => ({ toAngel: false }),
    answer: async q => { answers.push(q); return { say: `Answer: ${q.question}`, sources: [], dollars: 0.01 }; },
  };
  const bot = new AngelBot({ cfg: { ...DEFAULTS, ackPhrase: "", ...extra }, log: quiet, services, dataDir: dir, speakersFile: path.join(dir, "speakers.json"), VoiceLinkClass: FakeVoiceLink });
  bot.client = { user: { id: "angel1" }, destroy() {} };
  return { bot, answers, dir };
}

test("/angel join from a voice channel starts a session and tells the table she's transcribing", async () => {
  const w = world(), { bot, dir } = makeBot();
  const i = interaction(w, "join");
  await bot.onInteraction(i);
  assert.equal(i.deferred, true);
  assert.match(i.edits[0], /I'm in \*\*Game Night\*\*, listening and transcribing/);
  assert.match(i.edits[0], /\/angel optout/);
  assert.ok(bot.sessions.has("g1"));
  const v = FakeVoiceLink.made.at(-1);
  assert.equal(v.opts.shouldListen("p1"), true);
  assert.equal(v.opts.shouldListen("botty"), false, "other bots are not transcribed");
  assert.ok(fs.existsSync(path.join(dir, "sessions")), "the session's transcript folder is made");
  const again = interaction(w, "join");
  await bot.onInteraction(again);
  assert.match(again.replies[0].content, /already listening/);
});

test("a session gets its own thread: the notice, typed answers and the summary go there, not in the channel (Rhea, 2026-11-14)", async () => {
  const w = world(), { bot } = makeBot();
  const inThread = [];
  w.textChannel.threads = { create: async o => ({ id: "th1", name: o.name, toString: () => "<#th1>", send: async m => { const msg = { content: m.content ?? m, edit: async t => { msg.content = t; } }; inThread.push(msg); return msg; } }) };
  const i = interaction(w, "join");
  await bot.onInteraction(i);
  assert.match(i.edits[0], /Everything for this session is in <#th1>/);
  assert.match(threadName(Date.UTC(2026, 10, 14, 18)), /^Angel · Sat, Nov 14$/);
  assert.match(inThread[0].content, /listening and transcribing/, "the notice is in the thread");
  assert.equal(bot.sessions.get("g1").thread.name, threadName(Date.now()));
  // typed in the channel: answered in the thread, nothing replied in the channel
  const replies = [];
  const reacted = [];
  await bot.onMessage({ author: { id: "p1", bot: false }, guild: w.guild, channelId: "tc1", content: "Angel, flanking?", react: async e => { reacted.push(e); }, reply: async r => { replies.push(r); return { edit: async () => {} }; } });
  await bot.sessions.get("g1").session.answering;
  assert.equal(replies.length, 0, "no reply in the channel");
  assert.deepEqual(reacted, ["🧵"], "a thread mark on the question instead");
  assert.ok(inThread.some(m => /flanking/.test(m.content)), "the answer is in the thread");
  await bot.end("g1", "test");
  assert.match(inThread.at(-1).content, /\$/, "the summary is in the thread");
  assert.equal(w.sent.length, 0, "nothing at all in the channel");
});

test("a thread she can't post in, or that takes too long, falls back to the channel; a failure after joining leaves voice", async () => {
  let w = world(), { bot } = makeBot();
  w.textChannel.threads = { create: async () => ({ id: "th1", send: async () => { throw new Error("Missing Permissions"); } }) };
  let i = interaction(w, "join");
  await bot.onInteraction(i);
  assert.match(i.edits[0], /listening and transcribing/, "the notice in the reply, not a pointer to an empty thread");
  assert.equal(bot.sessions.get("g1").thread, null);
  await bot.end("g1", "test");
  assert.match(w.sent.at(-1).content, /\$/, "the summary in the channel");
  ({ bot } = makeBot()); w = world();
  w.textChannel.permissionsFor = () => ({ has: () => false });
  w.guild.members.me = {};
  w.textChannel.guild = w.guild;
  let created = 0;
  w.textChannel.threads = { create: async () => { created++; return {}; } };
  i = interaction(w, "join");
  await bot.onInteraction(i);
  assert.equal(created, 0, "no thread without the permissions to use it");
  await bot.end("g1", "test");
  ({ bot } = makeBot()); w = world();
  bot.knowOwner = async () => { throw new Error("boom"); };
  i = interaction(w, "join");
  await bot.onInteraction(i);
  assert.match(i.edits.at(-1), /couldn't start the session: boom/);
  assert.equal(bot.sessions.has("g1"), false);
  assert.equal(FakeVoiceLink.made.at(-1).left, true, "voice is left");
});

test("with no thread permission she posts in the channel as before", async () => {
  const w = world(), { bot } = makeBot();
  w.textChannel.threads = { create: async () => { throw new Error("Missing Permissions"); } };
  const i = interaction(w, "join");
  await bot.onInteraction(i);
  assert.match(i.edits[0], /listening and transcribing/, "the full notice in the reply");
  assert.equal(bot.sessions.get("g1").thread, null);
  await bot.end("g1", "test");
});

test("with saveTranscript off, no transcript folder is written (the conversation is still kept in memory)", async () => {
  const w = world(), { bot, dir } = makeBot({ saveTranscript: false });
  await bot.onInteraction(interaction(w, "join"));
  assert.ok(bot.sessions.has("g1"));
  assert.equal(fs.existsSync(path.join(dir, "sessions")), false);
  bot.sessions.get("g1").session.transcript.add({ speaker: "Mira", text: "still remembered" });
  assert.equal(bot.sessions.get("g1").session.transcript.lines.length, 1);
});

test("/angel join without being in voice, or when the voice join fails, says why", async () => {
  const w = world(), { bot } = makeBot();
  const i = interaction(w, "join", { inVoice: false });
  await bot.onInteraction(i);
  assert.match(i.replies[0].content, /Join a voice channel first/);
  w.vc.failJoin = true;
  const j = interaction(w, "join");
  await bot.onInteraction(j);
  assert.match(j.edits[0], /Couldn't connect/);
  assert.equal(bot.sessions.has("g1"), false);
});

test("/angel ask is answered in the reply, with or without a session; the GM is labelled", async () => {
  const w = world(), { bot, answers } = makeBot();
  const i = interaction(w, "ask", { user: "gm", strings: { question: "what's flanking?" } });
  await bot.onInteraction(i);
  assert.equal(answers[0].question, "what's flanking?");
  assert.equal(answers[0].gmName, "Dana", "the server owner is the GM when speakers.json names none");
  assert.match(i.edits.at(-1), /^\*\*Dana asked:\*\* what's flanking\?\nAnswer: what's flanking\?/);
  assert.deepEqual(i.lastEditOptions.allowedMentions, { parse: [], repliedUser: false }, "an echoed question can't ping anyone");
  await bot.onInteraction(interaction(w, "join"));
  const j = interaction(w, "ask", { strings: { question: "and off-guard?" } });
  await bot.onInteraction(j);
  await bot.sessions.get("g1").session.answering;
  assert.match(j.edits.at(-1), /Sam asked:\*\* and off-guard\?/);
  assert.equal(bot.sessions.get("g1").session.transcript.lines[0].role, "player");
});

test("/angel iam names a player's character; /angel optout stops and restarts their transcription", async () => {
  const w = world(), { bot } = makeBot();
  await bot.onInteraction(interaction(w, "join"));
  const iam = interaction(w, "iam", { strings: { name: "Mira" } });
  await bot.onInteraction(iam);
  assert.match(iam.replies[0].content, /I'll call you Mira/);
  assert.deepEqual(bot.speakerOf(w.guild, "p1"), { name: "Mira", role: "player" });
  const out = interaction(w, "optout");
  await bot.onInteraction(out);
  assert.match(out.replies[0].content, /won't transcribe your voice/);
  assert.deepEqual(FakeVoiceLink.made.at(-1).ignored, ["p1"]);
  assert.equal(FakeVoiceLink.made.at(-1).opts.shouldListen("p1"), false);
  const back = interaction(w, "optout");
  await bot.onInteraction(back);
  assert.match(back.replies[0].content, /transcribe your voice again/);
  assert.equal(FakeVoiceLink.made.at(-1).opts.shouldListen("p1"), true);
});

test("/angel status, stop and leave", async () => {
  const w = world(), { bot } = makeBot();
  const none = interaction(w, "status");
  await bot.onInteraction(none);
  assert.match(none.replies[0].content, /not listening anywhere/);
  await bot.onInteraction(interaction(w, "join"));
  const st = interaction(w, "status");
  await bot.onInteraction(st);
  assert.match(st.replies[0].content, /Listening in <#vc1> for 0 min/);
  const stop = interaction(w, "stop");
  await bot.onInteraction(stop);
  assert.equal(FakeVoiceLink.made.at(-1).stopped, true);
  const leave = interaction(w, "leave");
  await bot.onInteraction(leave);
  assert.equal(bot.sessions.has("g1"), false);
  assert.equal(FakeVoiceLink.made.at(-1).left, true);
  assert.match(w.sent.at(-1).content, /Session over:/);
});

test('typed "Angel, ..." is answered; ordinary chat in the session channel joins the transcript', async () => {
  const w = world(), { bot, answers } = makeBot();
  const replies = [];
  const msg = (content, channelId = "tc1") => ({ author: { id: "p1", bot: false }, guild: w.guild, channelId, content, reply: async r => { const m = { content: r.content, edit: async t => { m.content = t; } }; replies.push(m); return m; } });
  await bot.onMessage(msg("Angel, can I Step twice?"));
  assert.equal(answers[0].question, "can I Step twice?");
  assert.match(replies[0].content, /Answer: can I Step twice\?/);
  await bot.onInteraction(interaction(w, "join"));
  await bot.onMessage(msg("brb getting snacks"));
  await bot.onMessage(msg("not the session channel", "other"));
  await bot.onMessage({ ...msg("<@angel1> hi"), author: { id: "bot2", bot: true } });
  const lines = bot.sessions.get("g1").session.transcript.lines;
  assert.deepEqual(lines.map(l => [l.text, l.kind]), [["brb getting snacks", "text"]]);
});

test("she leaves on her own when the voice channel empties, and comes back to nothing if removed", async () => {
  const w = world(), { bot } = makeBot({ leaveWhenEmptySeconds: 0.02 });
  await bot.onInteraction(interaction(w, "join"));
  w.voiceMembers.clear();
  bot.onVoiceState({}, { guild: w.guild, id: "p1", channelId: null });
  await sleep(60);
  assert.equal(bot.sessions.has("g1"), false);
  await bot.onInteraction(interaction(w, "join"));
  bot.onVoiceState({}, { guild: w.guild, id: "angel1", channelId: null });
  await sleep(5);
  assert.equal(bot.sessions.has("g1"), false, "Angel disconnected by someone ends the session");
});

test('a typed "Angel, stop" stops her and is not answered', async () => {
  const w = world(), { bot, answers } = makeBot();
  await bot.onInteraction(interaction(w, "join"));
  const replies = [];
  await bot.onMessage({ author: { id: "p1", bot: false }, guild: w.guild, channelId: "tc1", content: "Angel, stop", reply: async r => replies.push(r) });
  assert.equal(FakeVoiceLink.made.at(-1).stopped, true);
  assert.equal(answers.length, 0);
  assert.equal(replies.length, 0);
});

test("with guildId set, other servers get nothing (every answer costs money)", async () => {
  const w = world(), { bot, answers } = makeBot({ guildId: "home" });
  const i = interaction(w, "ask", { strings: { question: "q" } });
  await bot.onInteraction(i);
  assert.match(i.replies[0].content, /only work in my home server/);
  await bot.onMessage({ author: { id: "p1", bot: false }, guild: w.guild, channelId: "tc1", content: "Angel, flanking?", reply: async () => {} });
  assert.equal(answers.length, 0);
});

test("two /angel join at once make one session", async () => {
  const w = world(), { bot } = makeBot();
  const a = interaction(w, "join"), b = interaction(w, "join");
  const before = FakeVoiceLink.made.length;
  await Promise.all([bot.onInteraction(a), bot.onInteraction(b)]);
  assert.equal(FakeVoiceLink.made.length - before, 1);
  assert.match(b.replies[0].content, /already on my way in/);
});

test("a broken speakers.json is never written over by /angel iam", async () => {
  const w = world(), { bot } = makeBot();
  fs.writeFileSync(bot.speakersFile, '{ "gm": { "name": "Dana", "role": "GM" }, typo');
  const i = interaction(w, "iam", { strings: { name: "Mira" } });
  await bot.onInteraction(i);
  assert.match(i.replies[0].content, /has a mistake in it/);
  assert.match(fs.readFileSync(bot.speakersFile, "utf8"), /typo/, "left as it was");
  const named = interaction(w, "iam", { user: "p1", strings: { name: "Mira (GM)" } });
  fs.unlinkSync(bot.speakersFile);
  await bot.onInteraction(named);
  assert.equal(bot.speakerOf(w.guild, "p1").name, "Mira GM", "brackets are dropped, so nobody can label themselves GM");
});

test("the daily cap: typed questions outside a session are refused past it, and what they cost is kept for the day", async () => {
  const w = world(), { bot, answers } = makeBot({ maxDailyDollars: 0.015 });
  const ask = q => { const i = interaction(w, "ask", { strings: { question: q } }); return bot.onInteraction(i).then(() => i); };
  await ask("one");
  const second = await ask("two");
  assert.equal(answers.length, 2, "the first two fit (0.01 each, the cap is checked before)");
  const third = await ask("three");
  assert.equal(answers.length, 2);
  assert.match(third.edits.at(-1), /today's spending cap/);
  assert.ok(Math.abs(bot.spentToday() - 0.02) < 1e-9);
  assert.equal(JSON.parse(fs.readFileSync(bot.spendFile, "utf8")).dollars.toFixed(2), "0.02", "kept across restarts");
  const join = interaction(w, "join");
  await bot.onInteraction(join);
  assert.match(join.replies[0].content, /today's spending cap/);
  void second;
});

test("Discord's refusal of the Message Content intent is recognised by its real error", async () => {
  const { isIntentRefusal } = await import("../src/bot.mjs");
  /* client.login rejects with the error @discordjs/ws emits for close code 4014 (read in @discordjs/ws 2.x) */
  assert.equal(isIntentRefusal(new Error("Used disallowed intents")), true);
  const { DiscordjsError, DiscordjsErrorCodes } = await import("discord.js");
  assert.equal(isIntentRefusal(new DiscordjsError(DiscordjsErrorCodes.DisallowedIntents)), true, "discord.js's own code, should a version use it");
  assert.equal(isIntentRefusal(new Error("An invalid token was provided.")), false);
  assert.equal(isIntentRefusal(new Error("Used invalid intents")), false, "a bad intents number is a real fault");
});

test('"@Angel stop" stops her like "Angel, stop", and is not answered', async () => {
  const w = world(), { bot, answers } = makeBot();
  await bot.onInteraction(interaction(w, "join"));
  await bot.onMessage({ author: { id: "p1", bot: false }, guild: w.guild, channelId: "tc1", content: "<@angel1> stop", reply: async () => {} });
  assert.equal(FakeVoiceLink.made.at(-1).stopped, true);
  assert.equal(answers.length, 0);
});

test("a session's running cost is written every minute and still counts for the day after a crash", async () => {
  const w = world(), { bot, dir } = makeBot();
  await bot.onInteraction(interaction(w, "join"));
  const session = bot.sessions.get("g1").session;
  session.costs.claude += 0.03;
  bot.bookLive();
  assert.ok(Math.abs(JSON.parse(fs.readFileSync(bot.spendFile, "utf8")).live.g1 - session.spent()) < 1e-9);
  clearInterval(bot.bookTimer);
  /* the window closes here; the next start reads the same folder */
  const next = new AngelBot({ cfg: { ...DEFAULTS, ackPhrase: "" }, log: quiet, services: bot.services, dataDir: dir, speakersFile: bot.speakersFile, VoiceLinkClass: FakeVoiceLink });
  clearInterval(next.bookTimer);
  assert.ok(Math.abs(next.spentToday() - session.spent()) < 1e-9);
  assert.equal(JSON.parse(fs.readFileSync(next.spendFile, "utf8")).live, undefined, "booked once, not again at the next start");
});

test("what an answer still running at the end costs is booked when it finishes", async () => {
  const w = world(), { bot } = makeBot();
  await bot.onInteraction(interaction(w, "join"));
  const session = bot.sessions.get("g1").session;
  let release;
  session.answering = new Promise(r => { release = r; });
  await bot.end("g1", "test");
  const booked = bot.spentToday();
  session.costs.claude += 0.04;
  release(); await sleep(5);
  assert.ok(Math.abs(bot.spentToday() - booked - 0.04) < 1e-9);
});

test("guildId matches written as text or as a number, and one that matches no server is warned about", async () => {
  const { bot } = makeBot({ guildId: 123 });
  assert.equal(bot.serves("123"), true);
  assert.equal(bot.serves("1234"), false);
  const warnings = [], registered = [];
  bot.log = { ...quiet, warn: m => warnings.push(m) };
  const g = (id, name) => [id, { id, name, commands: { set: async () => registered.push(name) } }];
  await bot.onReady({ user: { tag: "Angel#0001" }, guilds: { cache: new Map([g("999", "Elsewhere")]) } });
  assert.equal(registered.length, 0);
  assert.ok(warnings.some(m => /none of the servers/.test(m)));
  await bot.onReady({ user: { tag: "Angel#0001" }, guilds: { cache: new Map([g("123", "Home"), g("999", "Elsewhere")]) } });
  assert.deepEqual(registered, ["Home"]);
});

test("a Discord nickname can't label a player as the GM either", () => {
  const w = world(), { bot } = makeBot();
  w.guild.members.cache.get("p1").displayName = "Sam (GM)";
  assert.deepEqual(bot.speakerOf(w.guild, "p1"), { name: "Sam GM", role: "player" });
});

test("when she can't post in the channel, she doesn't join voice at all", async () => {
  const w = world(), { bot } = makeBot();
  const i = interaction(w, "join");
  i.channel = null;
  i.client = { channels: { fetch: async () => null } };
  const before = FakeVoiceLink.made.length;
  await bot.onInteraction(i);
  assert.equal(FakeVoiceLink.made.length, before, "no voice connection was opened");
  assert.match(i.edits[0], /can't post in this channel/);
  assert.equal(bot.joining.has("g1"), false);
});

test("a spend file that can't be written never stops her: the total stays in memory and is tried again", async () => {
  const { bot } = makeBot();
  const warned = [];
  bot.log = { ...quiet, warn: m => warned.push(m) };
  /* a folder where the file should be: every write fails, as with a file that is locked */
  fs.rmSync(bot.spendFile, { force: true });
  fs.mkdirSync(bot.spendFile, { recursive: true });
  bot.addSpend(0.02);
  bot.bookLive();
  bot.addSpend(0.03);
  assert.equal(bot.spentToday().toFixed(2), "0.05", "counted all the same");
  assert.equal(warned.length, 1, "said once");
  assert.match(warned[0], /couldn't write today's spending/);
  fs.rmdirSync(bot.spendFile);
  bot.addSpend(0.01);
  assert.equal(bot.warnedLedger, false, "a later failure would be said again");
  /* only the swap is refused (Windows, a file held open): written straight instead */
  fs.mkdirSync(bot.spendFile + ".tmp");
  bot.addSpend(0.00);
  bot.saveLedger();
  assert.equal(warned.length, 1, "no new warning: the straight write worked");
  fs.rmSync(bot.spendFile + ".tmp", { recursive: true, force: true });
  assert.equal(JSON.parse(fs.readFileSync(bot.spendFile, "utf8")).dollars.toFixed(2), "0.06", "written whole once it can be");
  assert.equal(fs.existsSync(bot.spendFile + ".tmp"), false, "swapped in, no half file left beside it");
  /* a total that isn't a number counts as over the cap */
  bot.ledger.dollars = NaN; bot.ledgerToday = () => bot.ledger;
  assert.equal(bot.dailyOver(), true);
  clearInterval(bot.bookTimer);
});

test("typed questions outside a session are answered one at a time, each checked against the cap after the last was counted", async () => {
  const { bot, answers } = makeBot({ maxDailyDollars: 0.015 });
  let running = 0, most = 0;
  bot.services.answer = async q => { answers.push(q); running++; most = Math.max(most, running); await new Promise(r => setTimeout(r, 10)); running--; return { say: "Yes.", sources: [], dollars: 0.01 }; };
  bot.knowOwner = async () => {};
  const sent = [];
  const reply = { send: async t => { sent.push(t); return { edit: async e => sent.push(e) }; } };
  await Promise.all([1, 2, 3].map(n => bot.answerAlone({ question: `q${n}`, asker: "Mira", reply, guild: null })));
  assert.equal(most, 1, "one at a time");
  assert.equal(answers.length, 2, "the third met the cap the first two reached");
  assert.ok(sent.some(t => /spending cap/.test(t)));
  clearInterval(bot.bookTimer);
});
