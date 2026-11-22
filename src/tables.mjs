/* Tables (0.2.0): one folder per game table under tables/, beside the code and never in the repo. Each holds
   table.json (which Discord server and channels it serves, the game, whether she answers there) and that table's own
   house-rules.md, keyterms.txt and speakers.json. /angel join picks the table from where it is typed: the table that
   names that channel, else the one table on that server. Nothing is shared between folders, so one table's rulings
   and names never reach another table. With no tables/ folder she works as before 0.2.0: one table, the files beside
   the code, the server in config.json's guildId. */
import fs from "node:fs";
import path from "node:path";
import { ROOT, LOCAL_FILES, readText } from "./config.mjs";

export const TABLES_DIR = path.join(ROOT, "tables");
export const TABLE_FILE = "table.json";
const FILE_NAMES = { houseRules: "house-rules.md", keyterms: "keyterms.txt", speakers: "speakers.json" };

/* the only rules source so far is Archives of Nethys, so answering works for Pathfinder 2e alone */
export const ANSWERING_GAMES = /^\s*(?:pf\s?2e?|pathfinder\s?2(?:e|nd)?(?:\s+edition)?|pathfinder\s+second\s+edition)(?:\s*\(?remaster(?:ed)?\)?)?\s*$/i;

const asBool = (v, fallback) => {
  if (typeof v === "boolean") return v;
  const t = String(v ?? "").trim();
  if (/^(true|yes|on|1)$/i.test(t)) return true;
  if (/^(false|no|off|0)$/i.test(t)) return false;
  return fallback;
};
/* "#game-chat", "game-chat" and an id all name a channel; compared without case and without the # */
const plain = v => String(v ?? "").trim().replace(/^#/, "").toLowerCase();

/* One folder. Anything that can't be read leaves the table out (she then joins nowhere it would have served) or,
   for the answers switch, off: a mistake never makes her speak where she shouldn't. */
export function readTable(dir, problems = []) {
  const name = path.basename(dir);
  const file = path.join(dir, TABLE_FILE);
  if (!fs.existsSync(file)) { problems.push(`tables/${name} has no ${TABLE_FILE}, so it is left out`); return null; }
  let raw;
  try { raw = JSON.parse(readText(file)); }
  catch (e) { problems.push(`tables/${name}/${TABLE_FILE} can't be read (${e.message}), so the table is left out`); return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { problems.push(`tables/${name}/${TABLE_FILE} isn't a { ... } of settings, so the table is left out`); return null; }
  const server = typeof raw.server === "number" ? null : String(raw.server ?? "").trim();
  if (typeof raw.server === "number") { problems.push(`tables/${name}/${TABLE_FILE}: "server" needs its quote marks (without them a long id loses its last digits), so the table is left out`); return null; }
  if (!server) { problems.push(`tables/${name}/${TABLE_FILE} names no "server", so the table is left out`); return null; }
  const channels = (Array.isArray(raw.channels) ? raw.channels : raw.channels == null ? [] : [raw.channels]).map(plain).filter(Boolean);
  if (raw.channels?.some?.(c => typeof c === "number")) problems.push(`tables/${name}/${TABLE_FILE}: a channel id needs its quote marks, or it matches no channel`);
  const game = String(raw.game ?? "").trim();
  let answers = asBool(raw.answers, null);
  if (answers === null) {
    if (raw.answers !== undefined) problems.push(`tables/${name}/${TABLE_FILE}: "answers" should be true or false, not ${JSON.stringify(raw.answers)}, so she only listens there`);
    answers = false;
  }
  if (answers && !ANSWERING_GAMES.test(game)) {
    problems.push(`tables/${name}: she can only answer rules for Pathfinder 2e so far, not ${JSON.stringify(game || "a game not named")}, so she only listens there`);
    answers = false;
  }
  const keptBy = String(raw.transcriptKeptBy ?? "").trim().slice(0, 40);
  return {
    name, dir, server, channels, game, answers, keptBy,
    files: Object.fromEntries(Object.entries(FILE_NAMES).map(([k, f]) => [k, path.join(dir, f)])),
  };
}

/* The tables there are. `legacy` is the one table of a folder with no tables/: the files beside the code, the server
   from config.json. */
export function loadTables({ dir = TABLES_DIR, guildId = "", legacyFiles = LOCAL_FILES } = {}) {
  const problems = [];
  let folders = [];
  try { folders = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith(".")).map(d => path.join(dir, d.name)); }
  catch { folders = null; }
  if (!folders || !folders.length) {
    return { legacy: true, problems, list: [{ name: "", dir: null, server: String(guildId ?? "").trim(), channels: [], game: "Pathfinder 2e", answers: true, keptBy: "", files: legacyFiles, legacy: true }] };
  }
  const list = folders.sort().map(f => readTable(f, problems)).filter(Boolean);
  return { legacy: false, problems, list };
}

export const isId = v => /^\d{1,25}$/.test(String(v ?? "").trim());

/* A table serves a server only by its id (review 4 of 0.2.0: a name can be copied by anyone who invites her). A name
   in table.json is turned into the id by `pinServers`, the first time exactly one server of that name is seen. A
   legacy table serves guildId's server, or every server without one, as before. */
export function onServer(table, guild) {
  if (table.legacy) return !table.server || table.server === String(guild?.id ?? "");
  return isId(table.server) && table.server === String(guild?.id ?? "");
}

/* the servers a table names by name, from those she is in */
export function namedServers(table, guilds) {
  if (table.legacy || isId(table.server)) return [];
  const want = table.server.trim().toLowerCase();
  return guilds.filter(g => String(g?.name ?? "").trim().toLowerCase() === want);
}

/* Each table naming its server by name, where exactly one server she is in has that name, gets that server's id
   written into its table.json (the other settings kept), once: from then on it is served by id only. Two servers of
   that name: nothing is written, and the log lists their ids. */
export function pinServers(tables, guilds, log) {
  const pinned = [];
  /* a server in an outage has no name yet: its namesake could look like the only one (review 5) */
  if (guilds.some(g => g?.available === false)) { if (tables.list.some(t => !t.legacy && !isId(t.server))) log?.info("a server I'm in is unavailable just now, so no server name is turned into its id this time"); return pinned; }
  for (const t of tables.list) {
    const gs = namedServers(t, guilds);
    if (gs.length > 1) { log?.warn(`table ${t.name} names its server "${t.server}" by name, and ${gs.length} servers I'm in have that name (ids ${gs.map(g => g.id).join(", ")}): put the right one's id in its table.json`); continue; }
    if (gs.length !== 1) continue;
    const file = path.join(t.dir, TABLE_FILE);
    try {
      const raw = JSON.parse(readText(file));
      /* edited since it was read: left as the owner wrote it */
      if (String(raw.server ?? "").trim() !== t.server) { log?.info(`table ${t.name}: its table.json changed just now, so its server's id isn't written in this time`); continue; }
      raw.server = String(gs[0].id);
      /* written whole beside it, then swapped in, so a crash can't leave half a file (review 5) */
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, file);
      pinned.push(t.name);
      log?.info(`table ${t.name}: its server "${t.server}" is id ${gs[0].id}, written into its table.json (from now on only that server is this table's)`);
    } catch (e) {
      try { fs.rmSync(`${file}.tmp`, { force: true }); } catch { /* left for the next try */ }
      log?.warn(`table ${t.name}: couldn't write its server's id ${gs[0].id} into table.json (${e.message}); put it in by hand`); }
  }
  return pinned;
}

function namesChannel(table, channel) {
  if (!channel || !table.channels.length) return false;
  /* a thread counts as its channel, and only as its channel: its own name is anyone's to choose (review 1 of 0.2.0).
     Every channel in a category has a parentId too (the category's), so a thread is told by its type (review 2):
     discord.js's isThread(), or the thread types 10, 11, 12 */
  const inThread = typeof channel.isThread === "function" ? channel.isThread() === true : [10, 11, 12].includes(channel.type);
  const ids = (inThread ? [channel.parentId] : [channel.id]).filter(Boolean).map(String);
  const names = (inThread ? [channel.parent?.name] : [channel.name]).filter(Boolean).map(plain);
  return table.channels.some(c => ids.includes(c) || names.includes(c));
}

/* the tables that name this channel itself (for the voice channel at a join) */
export function namedBy(tables, guild, channel) {
  return tables.list.filter(t => onServer(t, guild) && namesChannel(t, channel));
}

/* The table for something typed in `channel` on `guild`: the one naming that channel; else the one table on that
   server; else, of several there, the one that names no channels. `why` says why none was found. */
export function pickTable(tables, guild, channel) {
  const here = tables.list.filter(t => onServer(t, guild));
  if (!here.length) return { table: null, why: "none" };
  /* a channel that couldn't be looked up (a thread whose parent is unknown) can't be told apart where tables share a
     server (review 2 of 0.2.0) */
  if (channel?.unknown && here.length > 1) return { table: null, why: "unknown" };
  const byChannel = here.filter(t => namesChannel(t, channel));
  if (byChannel.length === 1) return { table: byChannel[0] };
  if (byChannel.length > 1) return { table: null, why: "several", names: byChannel.map(t => t.name) };
  if (here.length === 1) return { table: here[0] };
  const wholeServer = here.filter(t => !t.channels.length);
  if (wholeServer.length === 1) return { table: wholeServer[0] };
  return { table: null, why: "several", names: here.map(t => t.name) };
}

/* Before 0.2.0 a table's files sat beside the code. Once tables/ exists they move into the table they belonged to,
   so the owner does nothing: the one table that answers (before 0.2.0 every table did), else the one serving
   config.json's guildId. A file the table already has is left beside the code as <name>.old when it differs. */
export function moveOldFiles({ tables, guildId = "", root = ROOT, log }) {
  if (tables.legacy) return null;
  const old = Object.entries(FILE_NAMES).filter(([, f]) => fs.existsSync(path.join(root, f)));
  if (!old.length) return null;
  /* the table serving guildId first, the server they were used on (review 1 of 0.2.0); of several there, the one that
     answers; with none there, the one table that answers; otherwise it can't tell (review 2) */
  const one = list => (list.length === 1 ? list[0] : null);
  const onGuild = guildId ? tables.list.filter(t => t.server === String(guildId).trim()) : [];
  const target = onGuild.length ? (one(onGuild) ?? one(onGuild.filter(t => t.answers))) : one(tables.list.filter(t => t.answers));
  if (!target) {
    log?.warn(`${old.map(([, f]) => f).join(", ")} beside the code ${old.length === 1 ? "isn't" : "aren't"} used any more (each table has its own in tables/<name>/), and I couldn't tell which table ${old.length === 1 ? "it belongs" : "they belong"} to: move ${old.length === 1 ? "it" : "them"} into the right table's folder`);
    return null;
  }
  const moved = [];
  for (const [key, f] of old) {
    const from = path.join(root, f), to = target.files[key];
    try {
      if (!fs.existsSync(to)) { fs.renameSync(from, to); moved.push(`${f} → tables/${target.name}/`); continue; }
      if (fs.readFileSync(from).equals(fs.readFileSync(to))) { fs.rmSync(from); moved.push(`${f} (the same as tables/${target.name}/${f}, removed)`); continue; }
      /* never over an earlier .old (review 1 of 0.2.0) */
      let keep = `${from}.old`;
      for (let n = 2; fs.existsSync(keep); n++) keep = `${from}.old${n}`;
      fs.renameSync(from, keep);
      moved.push(`${f} → ${path.basename(keep)} (tables/${target.name}/${f} is the one used)`);
    } catch (e) { log?.warn(`couldn't move ${f} into tables/${target.name}: ${e.message}`); }
  }
  if (moved.length) log?.info(`the table files moved into their table's folder: ${moved.join("; ")}`);
  return { target: target.name, moved };
}

/* The table Test Angel.cmd and npm run ask answer for: the one that answers (they read its house rules) */
export function answeringTable(tables) {
  const answering = tables.list.filter(t => t.answers);
  if (answering.length === 1) return { table: answering[0] };
  return { table: null, why: answering.length ? `${answering.length} tables answer (${answering.map(t => t.name).join(", ")})` : "no table answers" };
}

/* For npm run check and the log: each table in a line */
export function describeTable(t) {
  if (t.legacy) return `one table (the files beside the code)${t.server ? `, server ${t.server}` : ", every server I'm in"}, answering`;
  const where = t.channels.length ? `${t.server}, ${t.channels.map(c => `#${c}`).join(", ")}` : `${t.server}, every channel`;
  return `${where}; ${t.game || "game not named"}; ${t.answers ? "answering" : "listening only"}`;
}
