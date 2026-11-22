/* The Discord side: logging in, the /angel commands, typed questions, sessions per server, the daily spending cap,
   and leaving when the voice channel empties. The services (Claude, AoN, Deepgram) are built in services.mjs and
   passed in; so is the voice class, so tests can stand in for Discord. */
import fs from "node:fs";
import path from "node:path";
import { Client, GatewayIntentBits, Events, MessageFlags, PermissionFlagsBits } from "discord.js";
import { angelCommand, typedQuestion } from "./commands.mjs";
import { VoiceLink } from "./voice.mjs";
import { Session, summaryText, LISTEN_ONLY_REPLY } from "./session.mjs";
import { Transcript, folderName } from "./transcript.mjs";
import { typedAnswer, shortQuestion } from "./answer.mjs";
import { isStopRequest } from "./wake.mjs";
import { readSpeakers, writeSpeakers, DATA_DIR, LOCAL_FILES } from "./config.mjs";
import { loadTables, pickTable, namedBy, onServer, pinServers, describeTable, TABLES_DIR } from "./tables.mjs";
import { inviteUrl } from "./setup.mjs";

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
  constructor({ cfg, log, services, dataDir = DATA_DIR, speakersFile = LOCAL_FILES.speakers, tablesDir = TABLES_DIR, VoiceLinkClass = VoiceLink }) {
    Object.assign(this, { cfg, log, services, dataDir, speakersFile, tablesDir, VoiceLinkClass });
    this.warnedTables = new Set();
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
    /* invited to another table's server while running (0.2.0): /angel is set up there at once */
    client.on(Events.GuildCreate, g => this.onNewServer(g).catch(e => this.log.error(e)));
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
    /* a server named by name becomes its id now, when exactly one server she is in has that name */
    pinServers(this.tables(), guilds, this.log);
    const tables = this.tables();
    if (!tables.legacy) {
      for (const t of tables.list) {
        const g = guilds.find(x => onServer(t, x));
        this.log.info(`table ${t.name}: ${describeTable(t)}${g ? ` (${g.name})` : " (not in that server yet: it needs inviting)"}`);
      }
      if (this.cfg.guildId) this.log.info("guildId in config.json isn't used while there are tables: each table's table.json names its server");
      /* for a table on someone else's server: the link that adds her there with only the permissions she uses */
      this.log.info(`to invite me to another table's server: ${inviteUrl(client.user.id)}`);
    }
    const mine = guilds.filter(g => this.serves(g));
    if (tables.legacy && this.cfg.guildId && !mine.length) this.log.warn(`guildId in config.json (${this.cfg.guildId}) is none of the servers I'm in, so /angel is registered nowhere. Fix it or leave it empty ("").`);
    if (!tables.legacy && !mine.length) this.log.warn("none of the tables in tables/ is on a server I'm in, so /angel is registered nowhere");
    for (const g of mine) await this.register(g);
  }

  async register(g) {
    try { await g.commands.set([angelCommand()]); this.log.info(`/angel is ready in ${g.name}`); }
    catch (e) { this.log.warn(`couldn't register /angel in ${g.name}: ${e.message}`); }
  }

  async onNewServer(g) {
    this.log.info(`invited to the server ${g.name} (id ${g.id})`);
    /* a table naming this server by name gets its id now, if no other server she is in has that name */
    const all = [...(this.client?.guilds?.cache?.values?.() ?? [])];
    pinServers(this.tables(), all.some(x => x.id === g.id) ? all : [...all, g], this.log);
    if (this.serves(g)) await this.register(g);
    else this.log.info(`no table is on ${g.name}, so /angel isn't set up there (a table.json with "server": "${g.id}" does it)`);
  }

  /* ---- tables (0.2.0): read each time, so a table.json edit counts without a restart ---- */
  tables() {
    const t = loadTables({ dir: this.tablesDir, guildId: this.cfg.guildId, legacyFiles: { ...LOCAL_FILES, speakers: this.speakersFile } });
    for (const p of t.problems) if (!this.warnedTables.has(p)) { this.warnedTables.add(p); this.log.warn(p); }
    return t;
  }

  /* the table for where something was typed; null when none is set up there */
  tableFor(guild, channel) { return pickTable(this.tables(), guild, channel); }

  /* a table answers only on its own server. Before tables, guildId set meant only there (every answer costs money);
     compared as text, since an id is too long to survive being written as a JSON number */
  serves(guild) {
    const g = typeof guild === "object" && guild ? guild : { id: guild };
    return this.tables().list.some(t => onServer(t, g));
  }

  /* the live session belongs to this table (tables are read afresh each time, so compared by folder) */
  sameTable(live, table) { return !!live && !!table && live.table.name === table.name && live.table.dir === table.dir; }

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
  speakers(table = null) {
    const file = table?.files?.speakers ?? this.speakersFile;
    /* one warning per file, so a second table's broken file is named too */
    this.warnedSpeakerFiles ??= new Set();
    return readSpeakers(file, { onError: e => { if (!this.warnedSpeakerFiles.has(file)) { this.warnedSpeakerFiles.add(file); this.log.warn(`speakers.json can't be read (${e.message}); using Discord names until it's fixed`); } } });
  }

  speakerOf(guild, userId, table = null) {
    const known = this.speakers(table)[userId];
    const member = guild.members.cache.get(userId);
    const manages = member?.permissions?.has?.(PermissionFlagsBits.ManageGuild) ?? false;
    const role = known?.role ? (known.role === "GM" ? "GM" : "player") : (manages ? "GM" : "player");
    /* a nickname like "Bob (GM)" would read as a GM line in the transcript Angel is given */
    return { name: cleanName(known?.name || member?.displayName) || "Someone", role };
  }

  gmName(guild, table = null) {
    const gm = Object.values(this.speakers(table)).find(s => s?.role === "GM");
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
    if (!this.serves(i.guild ?? i.guildId)) return i.reply({ content: "No table is set up for this server, so I don't work here.", ...EPHEMERAL });
    const sub = i.options.getSubcommand();
    const live = this.sessions.get(i.guildId);
    /* the table of the channel it was typed in; the live session's table when it is the same one. A channel not
       cached (a thread) is fetched, so a thread is still known by its parent (review 1 of 0.2.0) */
    /* looked up only where it matters: a server with more than one table (review 3) */
    const shared = this.tables().list.filter(t => onServer(t, i.guild ?? { id: i.guildId })).length > 1;
    const typedIn = i.channel ?? (shared ? await lookUp(i.client, i.channelId) : null) ?? { id: i.channelId, unknown: true };
    const pick = this.tableFor(i.guild ?? { id: i.guildId }, typedIn);
    const table = this.sameTable(live, pick.table) ? live.table : pick.table;
    if (sub === "join") return this.join(i, pick);
    /* leave, stop and status are about the server's one session: from another table's channel they don't touch it
       (review 3 of 0.2.0) */
    /* only while the session's table still exists: a table renamed, or tables/ made during a session, never locks
       leave and stop (review 4); a channel with no table may still end it */
    if (["leave", "stop", "status"].includes(sub) && live && pick.table && !this.sameTable(live, pick.table) && this.tables().list.some(t => this.sameTable(live, t) && onServer(t, i.guild ?? { id: i.guildId }))) {
      return i.reply({ content: `I'm listening for another table on this server right now (${live.table.name}). Use \`/angel ${sub}\` in its channel.`, ...EPHEMERAL });
    }
    if (sub === "leave") {
      if (!live) return i.reply({ content: "I'm not in a voice channel right now.", ...EPHEMERAL });
      await i.reply("Okay, I'm off. Good game!");
      return this.end(i.guildId, "left by /angel leave");
    }
    if (sub === "ask") {
      if (!table) return i.reply({ content: noTableText(pick), ...EPHEMERAL });
      if (!table.answers) {
        if (this.sameTable(live, table)) {
          const who = this.speakerOf(i.guild, i.user.id, table);
          live.session.transcript.add({ at: Date.now(), userId: i.user.id, speaker: who.name, role: who.role, text: i.options.getString("question", true), kind: "text" });
        }
        return i.reply({ content: LISTEN_ONLY_REPLY, ...NO_PINGS });
      }
      await i.deferReply();
      const who = this.speakerOf(i.guild, i.user.id, table);
      const question = i.options.getString("question", true);
      const edit = text => i.editReply({ content: text, ...NO_PINGS });
      const reply = { send: async text => { await edit(text); return { edit }; } };
      if (this.sameTable(live, table)) return live.session.textQuestion({ userId: i.user.id, asker: who.name, role: who.role, text: question, reply });
      return this.answerAlone({ question, asker: who.name, reply, guild: i.guild, table });
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
      /* the name is kept for this table only (0.2.0): a character name belongs to one game */
      if (!table) return i.reply({ content: noTableText(pick), ...EPHEMERAL });
      const file = table.files.speakers;
      let speakers;
      try { speakers = readSpeakers(file, { strict: true }); }
      catch (e) {
        /* never write over a file someone edited by hand and broke: it would lose everyone else's names */
        return i.reply({ content: `speakers.json has a mistake in it (${e.message}), so I didn't change it. Ask the GM to fix it.`, ...EPHEMERAL });
      }
      speakers[i.user.id] = { ...(speakers[i.user.id] ?? {}), name };
      writeSpeakers(speakers, file);
      return i.reply({ content: `Got it, I'll call you ${name}.`, ...EPHEMERAL });
    }
    if (sub === "status") {
      if (!live) return i.reply({ content: "I'm not listening anywhere right now. `/angel join` from a voice channel to start.", ...EPHEMERAL });
      const s = live.session.status();
      return i.reply({ content: `Listening in <#${live.voiceChannelId}> for ${s.minutes} min: ${s.lines} lines, ${s.questions} questions, about $${s.dollars.toFixed(2)} so far (cap $${this.cfg.maxSessionDollars} a session, $${this.cfg.maxDailyDollars} a day; $${this.spentToday().toFixed(2)} today)${s.capped ? ", cap reached" : ""}.`, ...EPHEMERAL });
    }
  }

  async join(i, pick = this.tableFor(i.guild ?? { id: i.guildId }, i.channel ?? { id: i.channelId })) {
    const table = pick.table;
    /* no table set up where it was typed: she doesn't join (no way to pick one by hand, so one table's rulings can't
       be loaded at another) */
    if (!table) return i.reply({ content: noTableText(pick), ...EPHEMERAL });
    const channel = i.member?.voice?.channel;
    if (!channel) return i.reply({ content: "Join a voice channel first, then use `/angel join`.", ...EPHEMERAL });
    /* a voice channel another table names is that table's game: not joined as this one (review 1 of 0.2.0) */
    const naming = namedBy(this.tables(), channel.guild ?? i.guild, channel);
    if (naming.length && !naming.some(t => t.name === table.name)) return i.reply({ content: `That voice channel belongs to another table (${naming.map(t => t.name).join(", ")}). Type \`/angel join\` in that table's text channel.`, ...EPHEMERAL });
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
      let made = null, begun = null;
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
        /* when she stops hearing, whoever started the session is told at once, in writing and never aloud (Rhea,
           2026-11-22, after 85 minutes unheard: "she really needs to message me and tell me"): a direct message, and
           the same words where the session posts, with a ping there only if the direct message couldn't be sent */
        const owner = i.user;
        const where = `**${channel.name}** (${channel.guild.name})`;
        const alert = async text => {
          const content = String(text).replaceAll("{where}", where);
          let direct = false;
          if (owner?.send) {
            try { await owner.send({ content }); direct = true; }
            catch (e) { log.warn(`couldn't send ${owner.username ?? "the owner"} a direct message: ${e.message}`); }
          }
          const here = direct || !owner?.id ? { content, ...NO_PINGS } : { content: `<@${owner.id}> ${content}`, allowedMentions: { parse: [], users: [owner.id], repliedUser: false } };
          await home.send(here).catch(e => log.warn(`couldn't post the warning in the channel: ${e.message}`));
        };
        /* everything the session reads is this table's own: key terms, house rules, speakers, transcript folder */
        const terms = table.legacy || !this.services.keytermsOf ? null : this.services.keytermsOf(table);
        const sessionsDir = table.legacy ? path.join(this.dataDir, "sessions") : path.join(this.dataDir, "sessions", table.name);
        const session = new Session({
          cfg, voice, post, log,
          stt: terms ? (wav, o = {}) => this.services.stt(wav, { ...o, terms }) : this.services.stt,
          tts: this.services.tts, gate: this.services.gate,
          hold: this.services.hold, readyLine: this.services.readyLine,
          answer: q => this.services.answer({ ...q, gmName: this.gmName(channel.guild, table), table }),
          speakerOf: id => this.speakerOf(channel.guild, id, table),
          keytermCount: terms ? terms.length : this.services.keytermCount,
          dailyOver: () => this.dailyOver(),
          listenOnly: !table.answers,
          alert,
          transcript: new Transcript({ dir: cfg.saveTranscript ? path.join(sessionsDir, folderName(startedAt)) : null, startedAt, title: channel.guild.name }),
        });
        begun = session;
        voice.on("lost", why => {
          /* only for the session this voice link belongs to, and once (review 2 of the hearing watch) */
          if (this.sessions.get(i.guildId)?.session !== session || session.ended) return;
          const note = (why === "deaf"
            ? "⚠️ I kept losing the sound in {where} even after rejoining, so I've left the voice channel and stopped transcribing. `/angel join` brings me back."
            : "⚠️ I lost the voice connection in {where} and couldn't get it back, so I've stopped transcribing. `/angel join` brings me back.").replaceAll("{where}", where);
          /* the note goes in the channel at once, ahead of the summary that closes the thread, and the session ends
             without waiting for anything; the owner is told directly as well (at a table where she only listens
             nobody is watching her thread), and pinged in the channel only if that can't be sent */
          home.send({ content: note, ...NO_PINGS }).catch(() => {});
          const place = home;
          if (owner?.send) {
            Promise.resolve().then(() => owner.send({ content: note })).catch(e => {
              log.warn(`couldn't send ${owner.username ?? "the owner"} a direct message: ${e.message}`);
              return place.send({ content: `<@${owner.id}> ${note}`, allowedMentions: { parse: [], users: [owner.id], repliedUser: false } });
            }).catch(e => log.warn(`couldn't ping the owner about the lost connection: ${e.message}`));
          }
          this.end(i.guildId, why === "deaf" ? "kept going deaf" : "voice connection lost");
        });
        voice.on("rejoined", () => { session.rejoined().catch(e => log.warn(`after rejoining: ${e.message}`)); });
        this.sessions.set(i.guildId, { session, table, voiceChannelId: channel.id, textChannel, home, thread, emptyTimer: null });
        await session.start();
        const keptOn = table.keptBy ? `on ${table.keptBy}'s computer` : "on the GM's computer";
        /* where she only listens she says so once, in writing, and never speaks (d-10) */
        const notice = table.answers
          ? `🎙️ I'm in **${channel.name}**, listening and transcribing so I can answer rules questions. Say "Angel, ..." or type \`@Angel ...\`. ` +
            `Only text is kept, never audio, ${keptOn}. \`/angel optout\` if you'd rather I didn't transcribe you; \`/angel stop\` or "Angel, stop" cuts me off; \`/angel leave\` when you're done.`
          : `🎙️ I'm in **${channel.name}**, listening and transcribing for the session's notes. At this table I only listen: I won't speak or answer questions. ` +
            `Only text is kept, never audio, ${keptOn}. \`/angel optout\` if you'd rather I didn't transcribe you; \`/angel leave\` when you're done.`;
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
        /* the way she would warn the owner is tried now, while someone is looking: a direct message that can't be
           sent is said in the reply, instead of being found out when a warning doesn't come */
        let warnNote = "";
        if (owner?.send) {
          try { await owner.send({ content: `🎙️ I'm listening in ${where}. If I stop hearing the table, I'll message you here straight away.` }); }
          catch (e) {
            log.warn(`couldn't send ${owner.username ?? "the owner"} a direct message: ${e.message}`);
            warnNote = `\n⚠️ <@${owner.id}>, I couldn't send you a direct message (Discord: Privacy Settings > allow direct messages from server members). If I stop hearing the table I'll ping you here instead.`;
          }
        }
        /* a reply that can't be edited any more mustn't end a session that works */
        if (warnNote) await home.send({ content: warnNote.trim(), allowedMentions: { parse: [], users: [owner.id], repliedUser: false } }).catch(e => log.warn(`couldn't post the note about direct messages: ${e.message}`));
        if (inThread) await i.editReply(`🎙️ I'm in **${channel.name}**. Everything for this session is in <#${thread.id}>.`).catch(e => log.warn(`couldn't answer /angel join: ${e.message}`));
        else await i.editReply(notice).catch(e => log.warn(`couldn't answer /angel join: ${e.message}`));
      } catch (e) {
        /* its timer and decoders go with it (it leaves the voice channel itself) */
        try { begun?.end(); } catch { /* half made */ }
        voice.leave();
        this.sessions.delete(i.guildId);
        const t = made?.();
        if (t?.delete) await t.delete().catch(() => {});
        log.error(`couldn't start the session: ${e.message}`);
        return i.editReply(`I couldn't start the session: ${e.message}`).catch(() => {});
      }
      log.info(`session started in ${channel.guild.name} / ${channel.name}${table.legacy ? "" : ` (table ${table.name}, ${table.answers ? "answering" : "listening only"})`}`);
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
    if (m.author.bot || !m.guild || !this.serves(m.guild)) return;
    const live = this.sessions.get(m.guild.id);
    /* the table of the channel it was typed in (0.2.0); the session only hears its own table's channels */
    const picked = this.tableFor(m.guild, m.channel ?? { id: m.channelId }).table;
    const mine = this.sameTable(live, picked) ? live : null;
    /* the session's table as it was at the join: a table.json edit mid-session never splits its voice and typed sides */
    const table = mine ? mine.table : picked;
    if (!table) return;
    /* a typed "Angel, stop" or "@Angel stop" stops her; it isn't a question */
    const asText = String(m.content ?? "").replace(new RegExp(`<@!?${this.client.user.id}>`, "g"), "Angel");
    if (isStopRequest(asText)) { mine?.session.stop(); return; }
    const q = typedQuestion(m.content, this.client.user.id);
    const who = this.speakerOf(m.guild, m.author.id, table);
    const inSession = mine && (m.channelId === mine.textChannel.id || m.channelId === mine.thread?.id);
    if (!q.asked) {
      /* table chat in the session's channel is part of the conversation Angel remembers */
      if (inSession && m.content.trim()) mine.session.transcript.add({ at: Date.now(), userId: m.author.id, speaker: who.name, role: who.role, text: m.content, kind: "text" });
      return;
    }
    /* where she only listens: one short line back, no lookup; in the session's channel it is kept in the transcript */
    if (!table.answers) {
      if (inSession) mine.session.transcript.add({ at: Date.now(), userId: m.author.id, speaker: who.name, role: who.role, text: asText, kind: "text" });
      await m.reply({ content: LISTEN_ONLY_REPLY, ...NO_PINGS }).catch(() => {});
      return;
    }
    /* asked in the channel while the session has a thread: answered in the thread, to keep the channel clean */
    const toThread = mine?.thread && m.channelId === mine.textChannel.id;
    const reply = toThread ? { send: text => mine.thread.send({ content: text, ...NO_PINGS }) } : { send: text => m.reply({ content: text, ...NO_PINGS }) };
    /* a 🧵 on the question in the channel says where the answer went, without adding text there */
    if (toThread) m.react?.("🧵")?.catch?.(() => {});
    if (mine) return mine.session.textQuestion({ userId: m.author.id, asker: who.name, role: who.role, text: q.question, reply });
    return this.answerAlone({ question: q.question, asker: who.name, reply, guild: m.guild, table });
  }

  /* A typed question with no session running: answered in text only, with no conversation to draw on. */
  /* one at a time: each is checked against the day's cap after the one before it has been counted */
  answerAlone(q) {
    this.alone = (this.alone ?? Promise.resolve()).then(() => this.answerOne(q)).catch(e => this.log.error(`answering failed: ${e.message}`));
    return this.alone;
  }

  async answerOne({ question, asker, reply, guild, table = null }) {
    if (this.dailyOver()) {
      await reply.send(`I've reached today's spending cap ($${this.cfg.maxDailyDollars}), so I can't look that up until tomorrow.`).catch(() => {});
      return;
    }
    await this.knowOwner(guild);
    let msg = null;
    try { msg = await reply.send(`**${asker} asked:** ${shortQuestion(question)}\n-# Looking it up…`); } catch { /* keep going */ }
    let result;
    try { result = await this.services.answer({ conversation: "", question, asker, via: "text", gmName: this.gmName(guild, table), table }); }
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
    if (newState.id === this.client.user.id && newState.channelId !== live.voiceChannelId) {
      /* not while she is leaving and joining again herself: Discord reports her own leave, and ending the session on
         it stopped the rejoin half-way, so she never came back (review 2 of the hearing watch; the rejoin of 0.1.3
         had never run live) */
      if (live.session?.voice?.rejoining) return;
      this.end(newState.guild.id, "removed from the voice channel");
      return;
    }
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

/* a channel the interaction didn't carry, looked up within 1.5 s so the reply still meets Discord's 3 s (review 2) */
async function lookUp(client, id) {
  if (!client?.channels?.fetch || !id) return null;
  let timer;
  const limit = new Promise(r => { timer = setTimeout(() => r(null), 1500); timer.unref?.(); });
  try { return await Promise.race([client.channels.fetch(id).catch(() => null), limit]); } finally { clearTimeout(timer); }
}

/* why /angel did nothing where it was typed */
export function noTableText(pick) {
  if (pick?.why === "unknown") return "I couldn't look this channel up, and more than one table is set up on this server, so I can't tell which table you mean. Try again in a moment, or use the table's own channel.";
  if (pick?.why === "several") return `More than one table is set up on this server (${pick.names.join(", ")}), and none names this channel. Use the channel of your table.`;
  return "No table is set up for this channel, so I don't join or answer here.";
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
