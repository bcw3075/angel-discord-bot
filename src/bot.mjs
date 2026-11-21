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

/* Discord refuses a privileged intent that isn't switched on in the Developer Portal with close code 4014, and
   client.login rejects with @discordjs/ws's Error("Used disallowed intents"). discord.js also has a
   "DisallowedIntents" error code, kept here in case a later version reports it that way. */
export function isIntentRefusal(e) {
  return e?.code === "DisallowedIntents" || e?.code === 4014 || /disallowed intents|privileged intent/i.test(String(e?.message ?? ""));
}

const today = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

/* "Angel · Sat, Nov 14" */
export function threadName(at = Date.now()) {
  return `Angel · ${new Date(at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`;
}

export class AngelBot {
  constructor({ cfg, log, services, dataDir = DATA_DIR, speakersFile = LOCAL_FILES.speakers, VoiceLinkClass = VoiceLink }) {
    Object.assign(this, { cfg, log, services, dataDir, speakersFile, VoiceLinkClass });
    this.sessions = new Map(); /* guildId → { session, voiceChannelId, textChannel, emptyTimer } */
    this.joining = new Set();  /* guildIds with a /angel join still connecting */
    this.optoutFile = path.join(dataDir, "optout.json");
    this.optout = new Set(readJson(this.optoutFile, []));
    this.spendFile = path.join(dataDir, "spend.json");
    this.ledger = readJson(this.spendFile, {});
    /* live sessions' totals are written every minute; a process that died with sessions running left them there:
       they count for the day they were written */
    if (this.ledger.live && typeof this.ledger.live === "object") {
      if (this.ledger.day === today()) this.ledger.dollars = (this.ledger.dollars ?? 0) + Object.values(this.ledger.live).reduce((a, b) => a + (Number(b) || 0), 0);
      delete this.ledger.live;
      writeJson(this.spendFile, this.ledger);
    }
    this.bookTimer = setInterval(() => this.bookLive(), 60000);
    this.bookTimer.unref?.();
  }

  /* write the live sessions' running totals, so a crash or a closed window can't reset the day's cap */
  bookLive() {
    const live = {};
    for (const [id, s] of this.sessions) live[id] = s.session.spent();
    this.ledgerToday();
    if (Object.keys(live).length) this.ledger.live = live; else delete this.ledger.live;
    this.saveLedger();
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
    const mine = guilds.filter(g => this.serves(g.id));
    if (this.cfg.guildId && !mine.length) this.log.warn(`guildId in config.json (${this.cfg.guildId}) is none of the servers I'm in, so /angel is registered nowhere. Fix it or leave it empty ("").`);
    for (const g of mine) {
      try { await g.commands.set([angelCommand()]); this.log.info(`/angel is ready in ${g.name}`); }
      catch (e) { this.log.warn(`couldn't register /angel in ${g.name}: ${e.message}`); }
    }
  }

  /* with guildId set, Angel answers only there (every answer costs money); compared as text, since an id is too
     long to survive being written as a JSON number */
  serves(guildId) { return !this.cfg.guildId || String(guildId) === String(this.cfg.guildId); }

  /* ---- spending: a cap per session (in Session) and one per day for everything ---- */
  ledgerToday() {
    if (this.ledger.day !== today()) this.ledger = { day: today(), dollars: 0 };
    this.ledger.dollars = Number(this.ledger.dollars) || 0;
    return this.ledger;
  }
  addSpend(dollars) {
    if (!(dollars > 0)) return;
    this.ledgerToday().dollars += dollars;
    this.saveLedger();
  }
  saveLedger() {
    if (writeJson(this.spendFile, this.ledger, e => { if (!this.warnedLedger) { this.warnedLedger = true; this.log.warn(`couldn't write today's spending to ${path.basename(this.spendFile)} (${e.message}); it is kept in memory and tried again`); } })) this.warnedLedger = false;
  }
  spentToday() {
    let live = 0;
    for (const s of this.sessions.values()) live += s.session.spent();
    return this.ledgerToday().dollars + live;
  }
  /* a total that isn't a number (a price typed wrongly) counts as over: never as "nothing spent" */
  dailyOver() { const spent = this.spentToday(); return !Number.isFinite(spent) || spent >= this.cfg.maxDailyDollars; }

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
    /* a nickname like "Bob (GM)" would read as a GM line in the transcript Angel is given */
    return { name: cleanName(known?.name || member?.displayName) || "Someone", role };
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
      const name = cleanName(i.options.getString("name", true)).slice(0, 40);
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
      /* the text channel first: if it can't be had, no voice connection is left open */
      const textChannel = i.channel ?? await i.client.channels.fetch(i.channelId).catch(() => null);
      if (!textChannel?.send) return i.editReply("I can't post in this channel. Check that I may View Channel and Send Messages here.");
      const isBot = id => channel.guild.members.cache.get(id)?.user.bot ?? this.client?.users?.cache?.get(id)?.bot ?? false;
      const voice = new this.VoiceLinkClass({
        channel, log,
        silenceMs: cfg.silenceMs, maxUtteranceSeconds: cfg.maxUtteranceSeconds, echoGuardMs: cfg.echoGuardMs,
        /* other bots (Archivist, music bots) are never transcribed; a member not cached yet is checked by the user cache */
        shouldListen: id => !this.optout.has(id) && !isBot(id),
        /* who counts for "is the table busy": people, opted out or not (only that they talk is used) */
        isPerson: id => !isBot(id),
      });
      try { await voice.join(); }
      catch (e) { voice.leave(); return i.editReply(e.message); }
      /* anything failing after the voice join leaves voice and drops the half-made session, instead of sitting in
         the call with no session (thread review, 2026-11-14) */
      let made = null;
      try {
        await this.knowOwner(channel.guild);
        const startedAt = Date.now();
        /* one thread holds everything she posts, so the channel stays clean (Rhea, 2026-11-14), and a second join on
           the same day goes on in that day's thread (Rhea the same evening, after six threads of one name: "One
           thread per day"); without the thread permissions she falls back to the channel itself */
        let thread = null, madeNow = false;
        /* only a thread made by this join is deleted if the join fails: a reused one holds today's earlier answers */
        made = () => (madeNow ? thread : null);
        const me = textChannel.guild?.members?.me;
        const mayThread = !me || !textChannel.permissionsFor || textChannel.permissionsFor(me)?.has?.(["CreatePublicThreads", "SendMessagesInThreads"]) !== false;
        if (cfg.sessionThread && !textChannel.threads?.create) log.info("no thread: this channel can't hold threads (a voice channel's chat or a thread); posting here");
        else if (cfg.sessionThread && !mayThread) log.warn("no thread: Angel lacks Create Public Threads or Send Messages in Threads here; posting in the channel");
        if (cfg.sessionThread && textChannel.threads?.create && mayThread) {
          const within5s = work => Promise.race([work, new Promise((_, no) => setTimeout(() => no(new Error("Discord took over 5 seconds")), 5000).unref?.())]);
          const name = threadName(startedAt);
          /* today's thread, if she made one in this channel; the newest when there are several. A session's thread is
             closed (archived) when it ends, and Discord's list of active threads leaves closed ones out, so the closed
             ones are looked through too and today's is opened again (review 7: looking only at the active list made a
             new thread at every second join) */
          const ours = list => [...(list?.values?.() ?? [])].filter(t => t.name === name && !t.locked && (!this.client?.user?.id || t.ownerId === this.client.user.id))
            .sort((a, b) => (b.createdTimestamp ?? 0) - (a.createdTimestamp ?? 0));
          try {
            const open = textChannel.threads.fetchActive ? (await within5s(textChannel.threads.fetchActive())).threads : null;
            thread = ours(open).find(t => !t.archived) ?? null;
            if (!thread && textChannel.threads.fetchArchived) {
              const closed = ours((await within5s(textChannel.threads.fetchArchived({ type: "public", limit: 25 }))).threads)[0];
              if (closed?.setArchived) { await within5s(closed.setArchived(false, "Angel's session, again today")); thread = closed; }
            }
          } catch (e) { log.info(`couldn't find or reopen today's thread (${e.message}); starting a new one`); thread = null; }
          if (!thread) {
            try { thread = await within5s(textChannel.threads.create({ name, autoArchiveDuration: 1440, reason: "Angel's session" })); madeNow = true; }
            catch (e) { log.warn(`couldn't start a thread, posting in the channel instead: ${e.message}`); }
          } else log.info("going on in today's thread");
        }
        let home = thread ?? textChannel;
        const post = { send: text => home.send({ content: text, ...NO_PINGS }) };
        const session = new Session({
          cfg, voice, post, log,
          stt: this.services.stt, tts: this.services.tts, gate: this.services.gate,
          hold: this.services.hold, readyLine: this.services.readyLine,
          answer: q => this.services.answer({ ...q, gmName: this.gmName(channel.guild) }),
          speakerOf: id => this.speakerOf(channel.guild, id),
          keytermCount: this.services.keytermCount,
          dailyOver: () => this.dailyOver(),
          transcript: new Transcript({ dir: cfg.saveTranscript ? path.join(this.dataDir, "sessions", folderName(startedAt)) : null, startedAt, title: channel.guild.name }),
        });
        voice.on("lost", why => {
          const text = why === "deaf" ? "I kept losing the sound even after rejoining, so I've left the voice channel. `/angel join` brings me back." : "I lost the voice connection. `/angel join` brings me back.";
          home.send(text).catch(() => {});
          this.end(i.guildId, why === "deaf" ? "kept going deaf" : "voice connection lost");
        });
        voice.on("rejoined", () => { session.rejoined().catch(e => log.warn(`after rejoining: ${e.message}`)); });
        this.sessions.set(i.guildId, { session, voiceChannelId: channel.id, textChannel, home, thread, emptyTimer: null });
        await session.start();
        const notice = `🎙️ I'm in **${channel.name}**, listening and transcribing so I can answer rules questions. Say "Angel, ..." or type \`@Angel ...\`. ` +
          `Only text is kept, never audio, on the GM's computer. \`/angel optout\` if you'd rather I didn't transcribe you; \`/angel stop\` or "Angel, stop" cuts me off; \`/angel leave\` when you're done.`;
        let inThread = false;
        if (thread) {
          try { await thread.send({ content: notice, ...NO_PINGS }); inThread = true; }
          catch (e) {
            /* made but can't be posted in: the channel after all */
            log.warn(`couldn't post in the thread, using the channel: ${e.message}`);
            home = textChannel;
            const live = this.sessions.get(i.guildId);
            if (live) { live.home = textChannel; live.thread = null; }
          }
        }
        /* a reply that can't be edited any more mustn't end a session that works */
        if (inThread) await i.editReply(`🎙️ I'm in **${channel.name}**. Everything for this session is in <#${thread.id}>.`).catch(e => log.warn(`couldn't answer /angel join: ${e.message}`));
        else await i.editReply(notice).catch(e => log.warn(`couldn't answer /angel join: ${e.message}`));
      } catch (e) {
        voice.leave();
        this.sessions.delete(i.guildId);
        const t = made?.();
        if (t?.delete) await t.delete().catch(() => {});
        log.error(`couldn't start the session: ${e.message}`);
        return i.editReply(`I couldn't start the session: ${e.message}`).catch(() => {});
      }
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
    this.bookLive();
    /* a check or an answer still running when it ended can add a few cents afterwards: book those too */
    live.session.answering.finally(() => this.addSpend(live.session.spent() - s.dollars));
    this.log.info(`session ended (${why}): ${JSON.stringify(s)}`);
    try { await (live.home ?? live.textChannel).send(summaryText(s)); } catch { /* channel gone */ }
    /* the session's thread is closed once its summary is in, so it's plain the session is over */
    if (live.thread?.setArchived) await live.thread.setArchived(true).catch(() => {});
  }

  async endAll(why) {
    for (const id of [...this.sessions.keys()]) await this.end(id, why);
  }

  async onMessage(m) {
    if (m.author.bot || !m.guild || !this.serves(m.guild.id)) return;
    const live = this.sessions.get(m.guild.id);
    /* a typed "Angel, stop" or "@Angel stop" stops her; it isn't a question */
    const asText = String(m.content ?? "").replace(new RegExp(`<@!?${this.client.user.id}>`, "g"), "Angel");
    if (isStopRequest(asText)) { live?.session.stop(); return; }
    const q = typedQuestion(m.content, this.client.user.id);
    const who = this.speakerOf(m.guild, m.author.id);
    if (!q.asked) {
      /* table chat in the session's channel is part of the conversation Angel remembers */
      if (live && (m.channelId === live.textChannel.id || m.channelId === live.thread?.id) && m.content.trim()) live.session.transcript.add({ at: Date.now(), userId: m.author.id, speaker: who.name, role: who.role, text: m.content, kind: "text" });
      return;
    }
    /* asked in the channel while the session has a thread: answered in the thread, to keep the channel clean */
    const toThread = live?.thread && m.channelId === live.textChannel.id;
    const reply = toThread ? { send: text => live.thread.send({ content: text, ...NO_PINGS }) } : { send: text => m.reply({ content: text, ...NO_PINGS }) };
    /* a 🧵 on the question in the channel says where the answer went, without adding text there */
    if (toThread) m.react?.("🧵")?.catch?.(() => {});
    if (live) return live.session.textQuestion({ userId: m.author.id, asker: who.name, role: who.role, text: q.question, reply });
    return this.answerAlone({ question: q.question, asker: who.name, reply, guild: m.guild });
  }

  /* A typed question with no session running: answered in text only, with no conversation to draw on. */
  /* one at a time: each is checked against the day's cap after the one before it has been counted */
  answerAlone(q) {
    this.alone = (this.alone ?? Promise.resolve()).then(() => this.answerOne(q)).catch(e => this.log.error(`answering failed: ${e.message}`));
    return this.alone;
  }

  async answerOne({ question, asker, reply, guild }) {
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
    const typed = typedAnswer({ asker, question, say: result.details ?? result.say, sources: result.sources, unchecked: result.failedLookups > 0 });
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
    clearInterval(this.bookTimer);
    await this.endAll("Angel is shutting down");
    this.client?.destroy();
  }
}

/* brackets and parentheses dropped, spaces tidied */
export function cleanName(name) {
  return String(name ?? "").replace(/[()[\]{}<>]/g, "").replace(/\s+/g, " ").trim();
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
/* Written whole to a file beside it, then swapped in, so a crash mid-write can't leave half a file (which would
   read as an empty one and reset the day's spending). A write that fails (a virus scanner or a sync tool holding the
   file, a full disk) is reported and tried again at the next write: it must never stop Angel. */
function writeJson(file, value, onError = () => {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`, text = JSON.stringify(value, null, 2) + "\n";
    try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
    catch { fs.writeFileSync(file, text); try { fs.rmSync(tmp, { force: true }); } catch { /* left for the next write */ } } /* the swap was refused (Windows, a file held open): write it straight */
    return true;
  } catch (e) { onError(e); return false; }
}
