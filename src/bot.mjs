/* The Discord side: logging in, the /angel commands, typed questions, sessions per server, the daily spending cap,
   and leaving when the voice channel empties. The services (Claude, AoN, Deepgram) are built in services.mjs and
   passed in; so is the voice class, so tests can stand in for Discord. */
import fs from "node:fs";
import path from "node:path";
import { Client, GatewayIntentBits, Events, MessageFlags, PermissionFlagsBits } from "discord.js";
import { angelCommand, typedQuestion } from "./commands.mjs";
import { VoiceLink } from "./voice.mjs";
import { Session, summaryText } from "./session.mjs";
import { Transcript, folderName } from "./transcript.mjs";
import { typedAnswer, shortQuestion } from "./answer.mjs";
import { isStopRequest } from "./wake.mjs";
import { readSpeakers, writeSpeakers, DATA_DIR, LOCAL_FILES } from "./config.mjs";

const EPHEMERAL = { flags: MessageFlags.Ephemeral };
const NO_PINGS = { allowedMentions: { parse: [], repliedUser: false } };

/* Discord refuses a privileged intent that isn't switched on in the Developer Portal with close code 4014;
   discord.js reports it as code "DisallowedIntents" ("Privileged intent provided is not enabled or whitelisted.") */
export function isIntentRefusal(e) {
  return e?.code === "DisallowedIntents" || e?.code === 4014 || /disallowed intents|privileged intent/i.test(String(e?.message ?? ""));
}

const today = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

export class AngelBot {
  constructor({ cfg, log, services, dataDir = DATA_DIR, speakersFile = LOCAL_FILES.speakers, VoiceLinkClass = VoiceLink }) {
    Object.assign(this, { cfg, log, services, dataDir, speakersFile, VoiceLinkClass });
    this.sessions = new Map(); /* guildId → { session, voiceChannelId, textChannel, emptyTimer } */
    this.joining = new Set();  /* guildIds with a /angel join still connecting */
    this.optoutFile = path.join(dataDir, "optout.json");
    this.optout = new Set(readJson(this.optoutFile, []));
    this.spendFile = path.join(dataDir, "spend.json");
    this.ledger = readJson(this.spendFile, {});
  }

  async start() {
    const base = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages];
    try {
      await this.login([...base, GatewayIntentBits.MessageContent]);
      this.contentIntent = true;
    } catch (e) {
      if (!isIntentRefusal(e)) throw e;
      this.log.warn('The Message Content intent is off in the Discord Developer Portal, so typed "Angel, ..." messages won\'t be seen. @Angel and /angel ask still work. Turn it on under Bot → Privileged Gateway Intents and restart.');
      await this.login(base);
      this.contentIntent = false;
    }
  }

  async login(intents) {
    const client = new Client({ intents });
    client.once(Events.ClientReady, c => this.onReady(c).catch(e => this.log.error(e)));
    client.on(Events.InteractionCreate, i => this.onInteraction(i).catch(e => this.log.error(e)));
    client.on(Events.MessageCreate, m => this.onMessage(m).catch(e => this.log.error(e)));
    client.on(Events.VoiceStateUpdate, (o, n) => this.onVoiceState(o, n));
    client.on(Events.Error, e => this.log.warn(`Discord: ${e.message}`));
    try { await client.login(this.cfg.discordToken); }
    catch (e) { client.destroy(); throw e; }
    this.client = client;
  }

  async onReady(client) {
    const guilds = [...client.guilds.cache.values()];
    this.log.info(`Logged in as ${client.user.tag} in ${guilds.length} server${guilds.length === 1 ? "" : "s"}: ${guilds.map(g => g.name).join(", ") || "none yet"}`);
    for (const g of guilds.filter(g => this.serves(g.id))) {
      try { await g.commands.set([angelCommand()]); this.log.info(`/angel is ready in ${g.name}`); }
      catch (e) { this.log.warn(`couldn't register /angel in ${g.name}: ${e.message}`); }
    }
  }

  /* with guildId set, Angel answers only there (every answer costs money) */
  serves(guildId) { return !this.cfg.guildId || guildId === this.cfg.guildId; }

  /* ---- spending: a cap per session (in Session) and one per day for everything ---- */
  ledgerToday() {
    if (this.ledger.day !== today()) this.ledger = { day: today(), dollars: 0 };
    return this.ledger;
  }
  addSpend(dollars) {
    if (!(dollars > 0)) return;
    this.ledgerToday().dollars += dollars;
    writeJson(this.spendFile, this.ledger);
  }
  spentToday() {
    let live = 0;
    for (const s of this.sessions.values()) live += s.session.spent();
    return this.ledgerToday().dollars + live;
  }
  dailyOver() { return this.spentToday() >= this.cfg.maxDailyDollars; }

  /* who said it: speakers.json first (character name, role), then their Discord name. Without a role in the file,
     whoever may manage the server counts as the GM. */
  speakers() {
    return readSpeakers(this.speakersFile, { onError: e => { if (!this.warnedSpeakers) { this.warnedSpeakers = true; this.log.warn(`speakers.json can't be read (${e.message}); using Discord names until it's fixed`); } } });
  }

  speakerOf(guild, userId) {
    const known = this.speakers()[userId];
    const member = guild.members.cache.get(userId);
    const manages = member?.permissions?.has?.(PermissionFlagsBits.ManageGuild) ?? false;
    const role = known?.role ? (known.role === "GM" ? "GM" : "player") : (manages ? "GM" : "player");
    return { name: known?.name || member?.displayName || "Someone", role };
  }

  gmName(guild) {
    const gm = Object.values(this.speakers()).find(s => s?.role === "GM");
    if (gm?.name) return gm.name;
    const owner = guild ? guild.members.cache.get(guild.ownerId) : null;
    return owner?.displayName ?? "";
  }

  /* without the Server Members intent the owner isn't always cached: fetch that one member (allowed without it) */
  async knowOwner(guild) {
    if (guild?.ownerId && !guild.members.cache.has(guild.ownerId)) await guild.members.fetch(guild.ownerId).catch(() => {});
  }

  async onInteraction(i) {
    if (!i.isChatInputCommand() || i.commandName !== "angel") return;
    if (!this.serves(i.guildId)) return i.reply({ content: "I only work in my home server.", ...EPHEMERAL });
    const sub = i.options.getSubcommand();
    const live = this.sessions.get(i.guildId);
    if (sub === "join") return this.join(i);
    if (sub === "leave") {
      if (!live) return i.reply({ content: "I'm not in a voice channel right now.", ...EPHEMERAL });
      await i.reply("Okay, I'm off. Good game!");
      return this.end(i.guildId, "left by /angel leave");
    }
    if (sub === "ask") {
      await i.deferReply();
      const who = this.speakerOf(i.guild, i.user.id);
      const question = i.options.getString("question", true);
      const edit = text => i.editReply({ content: text, ...NO_PINGS });
      const reply = { send: async text => { await edit(text); return { edit }; } };
      if (live) return live.session.textQuestion({ userId: i.user.id, asker: who.name, role: who.role, text: question, reply });
      return this.answerAlone({ question, asker: who.name, reply, guild: i.guild });
    }
    if (sub === "stop") {
      live?.session.stop();
      return i.reply({ content: live ? "Okay, hush." : "I'm not talking.", ...EPHEMERAL });
    }
    if (sub === "optout") {
      const out = !this.optout.has(i.user.id);
      if (out) { this.optout.add(i.user.id); live?.session.voice.ignore(i.user.id); }
      else this.optout.delete(i.user.id);
      writeJson(this.optoutFile, [...this.optout]);
      return i.reply({ content: out ? "Done: I won't transcribe your voice. Typed questions still work. `/angel optout` again to undo." : "I'll transcribe your voice again.", ...EPHEMERAL });
    }
    if (sub === "iam") {
      /* brackets and parentheses are dropped, so nobody can make their line read "(GM)" */
      const name = i.options.getString("name", true).replace(/[()[\]{}<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
      if (!name) return i.reply({ content: "That name came out empty. Try plain letters?", ...EPHEMERAL });
      let speakers;
      try { speakers = readSpeakers(this.speakersFile, { strict: true }); }
      catch (e) {
        /* never write over a file someone edited by hand and broke: it would lose everyone else's names */
        return i.reply({ content: `speakers.json has a mistake in it (${e.message}), so I didn't change it. Ask the GM to fix it.`, ...EPHEMERAL });
      }
      speakers[i.user.id] = { ...(speakers[i.user.id] ?? {}), name };
      writeSpeakers(speakers, this.speakersFile);
      return i.reply({ content: `Got it, I'll call you ${name}.`, ...EPHEMERAL });
    }
    if (sub === "status") {
      if (!live) return i.reply({ content: "I'm not listening anywhere right now. `/angel join` from a voice channel to start.", ...EPHEMERAL });
      const s = live.session.status();
      return i.reply({ content: `Listening in <#${live.voiceChannelId}> for ${s.minutes} min: ${s.lines} lines, ${s.questions} questions, about $${s.dollars.toFixed(2)} so far (cap $${this.cfg.maxSessionDollars} a session, $${this.cfg.maxDailyDollars} a day; $${this.spentToday().toFixed(2)} today)${s.capped ? ", cap reached" : ""}.`, ...EPHEMERAL });
    }
  }

  async join(i) {
    const channel = i.member?.voice?.channel;
    if (!channel) return i.reply({ content: "Join a voice channel first, then use `/angel join`.", ...EPHEMERAL });
    if (this.sessions.has(i.guildId)) return i.reply({ content: `I'm already listening in <#${this.sessions.get(i.guildId).voiceChannelId}>.`, ...EPHEMERAL });
    /* marked before the first await, so a second /angel join in the same moment can't make a second session */
    if (this.joining.has(i.guildId)) return i.reply({ content: "I'm already on my way in.", ...EPHEMERAL });
    if (this.dailyOver()) return i.reply({ content: `I've reached today's spending cap ($${this.cfg.maxDailyDollars}). I can join again tomorrow.`, ...EPHEMERAL });
    this.joining.add(i.guildId);
    try {
      await i.deferReply();
      const { log, cfg } = this;
      const voice = new this.VoiceLinkClass({
        channel, log,
        silenceMs: cfg.silenceMs, maxUtteranceSeconds: cfg.maxUtteranceSeconds, echoGuardMs: cfg.echoGuardMs,
        /* other bots (Archivist, music bots) are never transcribed; a member not cached yet is checked by the user cache */
        shouldListen: id => !this.optout.has(id) && !(channel.guild.members.cache.get(id)?.user.bot ?? this.client?.users?.cache?.get(id)?.bot ?? false),
      });
      try { await voice.join(); }
      catch (e) { voice.leave(); return i.editReply(e.message); }
      await this.knowOwner(channel.guild);
      const startedAt = Date.now();
      const textChannel = i.channel ?? await i.client.channels.fetch(i.channelId);
      const post = { send: text => textChannel.send({ content: text, ...NO_PINGS }) };
      const session = new Session({
        cfg, voice, post, log,
        stt: this.services.stt, tts: this.services.tts, gate: this.services.gate,
        answer: q => this.services.answer({ ...q, gmName: this.gmName(channel.guild) }),
        speakerOf: id => this.speakerOf(channel.guild, id),
        keytermCount: this.services.keytermCount,
        dailyOver: () => this.dailyOver(),
        transcript: new Transcript({ dir: cfg.saveTranscript ? path.join(this.dataDir, "sessions", folderName(startedAt)) : null, startedAt, title: channel.guild.name }),
      });
      voice.on("lost", () => { textChannel.send("I lost the voice connection. `/angel join` brings me back.").catch(() => {}); this.end(i.guildId, "voice connection lost"); });
      this.sessions.set(i.guildId, { session, voiceChannelId: channel.id, textChannel, emptyTimer: null });
      await session.start();
      await i.editReply(
        `🎙️ I'm in **${channel.name}**, listening and transcribing so I can answer rules questions. Say "Angel, ..." or type \`@Angel ...\`. ` +
        `Only text is kept, never audio, on the GM's computer. \`/angel optout\` if you'd rather I didn't transcribe you; \`/angel stop\` or "Angel, stop" cuts me off; \`/angel leave\` when you're done.`);
      log.info(`session started in ${channel.guild.name} / ${channel.name}`);
    } finally {
      this.joining.delete(i.guildId);
    }
  }

  async end(guildId, why) {
    const live = this.sessions.get(guildId);
    if (!live) return;
    this.sessions.delete(guildId);
    clearTimeout(live.emptyTimer);
    const s = live.session.end();
    this.addSpend(s.dollars);
    this.log.info(`session ended (${why}): ${JSON.stringify(s)}`);
    try { await live.textChannel.send(summaryText(s)); } catch { /* channel gone */ }
  }

  async endAll(why) {
    for (const id of [...this.sessions.keys()]) await this.end(id, why);
  }

  async onMessage(m) {
    if (m.author.bot || !m.guild || !this.serves(m.guild.id)) return;
    const live = this.sessions.get(m.guild.id);
    /* a typed "Angel, stop" stops her; it isn't a question */
    if (isStopRequest(m.content)) { live?.session.stop(); return; }
    const q = typedQuestion(m.content, this.client.user.id);
    const who = this.speakerOf(m.guild, m.author.id);
    if (!q.asked) {
      /* table chat in the session's channel is part of the conversation Angel remembers */
      if (live && m.channelId === live.textChannel.id && m.content.trim()) live.session.transcript.add({ at: Date.now(), userId: m.author.id, speaker: who.name, role: who.role, text: m.content, kind: "text" });
      return;
    }
    const reply = { send: text => m.reply({ content: text, ...NO_PINGS }) };
    if (live) return live.session.textQuestion({ userId: m.author.id, asker: who.name, role: who.role, text: q.question, reply });
    return this.answerAlone({ question: q.question, asker: who.name, reply, guild: m.guild });
  }

  /* A typed question with no session running: answered in text only, with no conversation to draw on. */
  async answerAlone({ question, asker, reply, guild }) {
    if (this.dailyOver()) {
      await reply.send(`I've reached today's spending cap ($${this.cfg.maxDailyDollars}), so I can't look that up until tomorrow.`).catch(() => {});
      return;
    }
    await this.knowOwner(guild);
    let msg = null;
    try { msg = await reply.send(`**${asker} asked:** ${shortQuestion(question)}\n-# Looking it up…`); } catch { /* keep going */ }
    let result;
    try { result = await this.services.answer({ conversation: "", question, asker, via: "text", gmName: this.gmName(guild) }); }
    catch (e) {
      this.addSpend(e.dollars);
      this.log.error(`couldn't answer: ${e.message}`);
      result = { say: "Sorry, I couldn't reach my rules brain just then. Try me again in a moment?", sources: [] };
    }
    this.addSpend(result.dollars);
    const typed = typedAnswer({ asker, question, say: result.say, sources: result.sources });
    try { if (msg?.edit) await msg.edit(typed); else await reply.send(typed); }
    catch (e) { this.log.warn(`couldn't post the answer: ${e.message}`); }
  }

  onVoiceState(oldState, newState) {
    const live = this.sessions.get(newState.guild.id);
    if (!live) return;
    /* Angel herself was disconnected or moved */
    if (newState.id === this.client.user.id && newState.channelId !== live.voiceChannelId) { this.end(newState.guild.id, "removed from the voice channel"); return; }
    const channel = newState.guild.channels.cache.get(live.voiceChannelId);
    const people = channel?.members?.filter(mb => !mb.user.bot).size ?? 0;
    if (people === 0 && !live.emptyTimer) {
      live.emptyTimer = setTimeout(() => this.end(newState.guild.id, "the voice channel emptied"), this.cfg.leaveWhenEmptySeconds * 1000);
    } else if (people > 0 && live.emptyTimer) {
      clearTimeout(live.emptyTimer); live.emptyTimer = null;
    }
  }

  async stop() {
    await this.endAll("Angel is shutting down");
    this.client?.destroy();
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}
