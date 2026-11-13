/* The Discord side with stand-ins: the /angel commands, typed questions, table chat and leaving an empty channel.
   No Discord login: the bot's handlers are called with objects shaped like discord.js's. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AngelBot } from "../src/bot.mjs";
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
    editReply: async t => { i.edits.push(t); },
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
