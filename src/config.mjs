/* Settings and the owner's local files. config.json holds the keys and settings (written by `npm run setup`);
   the table's own files sit beside it and never go in the repo: house-rules.md, speakers.json, keyterms.txt. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_PATH = path.join(ROOT, "config.json");
export const DATA_DIR = path.join(ROOT, "data");
export const LOCAL_FILES = {
  houseRules: path.join(ROOT, "house-rules.md"),
  speakers: path.join(ROOT, "speakers.json"),
  keyterms: path.join(ROOT, "keyterms.txt"),
};

/* The secret keys: never printed, never logged (log.mjs blanks them out of every line). */
export const SECRET_KEYS = ["discordToken", "anthropicApiKey", "deepgramApiKey"];

export const DEFAULTS = Object.freeze({
  discordToken: "",
  anthropicApiKey: "",
  deepgramApiKey: "",
  /* the server Angel answers in; setup fills it when the bot is in exactly one server */
  guildId: "",
  answerModel: "claude-sonnet-5-5",
  gateModel: "claude-haiku-5-5",
  maxAnswerTokens: 1500,
  sttModel: "nova-3",
  ttsVoice: "aura-2-thalia-en",
  speak: true,
  /* said at once while Angel looks something up; "" for none */
  ackPhrase: "One sec, let me check.",
  /* how much of the conversation Angel is given with a question */
  memoryMinutes: 15,
  /* write each session's transcript to data/sessions/ (Angel keeps the conversation in memory either way) */
  saveTranscript: true,
  /* a pause this long ends a piece of speech */
  silenceMs: 900,
  /* a long monologue is cut into pieces this long so the transcript keeps up */
  maxUtteranceSeconds: 30,
  /* shorter or quieter pieces are skipped (nothing is paid for coughs and clicks) */
  minUtteranceMs: 400,
  minLevelDb: -50,
  /* after Angel speaks, wake words are ignored this long (her own voice coming back through someone's mic) */
  echoGuardMs: 2500,
  /* "Angel?" with the question still to come: how long to wait for the rest */
  followUpMs: 12000,
  /* Angel stops listening and answering for the rest of the session past this */
  maxSessionDollars: 5,
  /* and for the rest of the day past this, counting everything (sessions and typed questions outside one) */
  maxDailyDollars: 10,
  leaveWhenEmptySeconds: 60,
  /* how long Claude keeps the answering prompt (persona and house rules) cached: "1h" or "5m". Questions at a table
     are often more than 5 minutes apart, so a 5-minute cache is written again for most of them; a 1-hour write costs
     more once, then each question inside the hour reads it and starts the hour again. */
  answerCacheTtl: "1h",
  /* dollars per million tokens: [fresh input, 5-minute cache write, cache read, output], and a 1-hour cache write
     as a fifth number if it ever isn't twice the input price (Claude pricing page, checked 2026-11-13) */
  prices: {
    "claude-sonnet-5-5": [2, 2.5, 0.1, 10],
    "claude-haiku-5-5": [0.1, 0.125, 0.01, 0.5],
    "claude-opus-5-5": [4, 5, 0.2, 20],
  },
  /* Deepgram pay-as-you-go (checked 2026-11-12): Nova-3 pre-recorded per minute, key terms per minute, voice per 1,000 characters */
  deepgramPrices: { sttPerMinute: 0.0043, keytermPerMinute: 0.0013, ttsPer1000Chars: 0.03 },
  aonUserAgent: "AngelTableBot/0.1 (a private Pathfinder table helper; https://github.com/bcw3075/angel-discord-bot)",
});

/* A text file as Notepad may save it: UTF-8 (with or without a byte-order mark) or "Unicode" (UTF-16 LE). */
export function readText(file) {
  const buf = fs.readFileSync(file);
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString("utf16le") : buf.toString("utf8");
  return text.replace(/^\uFEFF/, "");
}

/* "false" typed with quotes is still false, "5" still 5: a setting keeps the kind its default has */
function sameKind(value, fallback) {
  if (typeof value !== "string") return value;
  if (typeof fallback === "boolean") {
    if (/^\s*(true|yes|on|1)\s*$/i.test(value)) return true;
    if (/^\s*(false|no|off|0)\s*$/i.test(value)) return false;
  }
  if (typeof fallback === "number" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return value;
}

export function loadConfig(file = CONFIG_PATH) {
  let saved = {};
  if (fs.existsSync(file)) {
    try { saved = JSON.parse(readText(file)); }
    catch (e) {
      throw new Error(`${path.basename(file)} can't be read: ${e.message}. Open it in Notepad and fix it near the place named `
        + "(a missing or extra comma or quote mark is the usual cause), then try again.");
    }
  }
  for (const k of Object.keys(saved)) saved[k] = sameKind(saved[k], DEFAULTS[k]);
  return { ...DEFAULTS, ...saved, prices: { ...DEFAULTS.prices, ...(saved.prices ?? {}) }, deepgramPrices: { ...DEFAULTS.deepgramPrices, ...(saved.deepgramPrices ?? {}) } };
}

/* Settings that follow each release (models and prices go stale): written to config.json only when they differ
   from the defaults, so a new release's values reach a folder that keeps its config.json. Every other setting is
   written, so the owner can see and change it in Notepad. */
export const FOLLOW_RELEASES = ["answerModel", "gateModel", "sttModel", "prices", "deepgramPrices", "aonUserAgent"];

export function saveConfig(cfg, file = CONFIG_PATH) {
  const out = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (!FOLLOW_RELEASES.includes(k)) { out[k] = v; continue; }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const changed = Object.fromEntries(Object.entries(v).filter(([name, value]) => JSON.stringify(value) !== JSON.stringify(DEFAULTS[k]?.[name])));
      if (Object.keys(changed).length) out[k] = changed;
    } else if (v !== DEFAULTS[k]) out[k] = v;
  }
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n", "utf8");
}

/* What is missing before the bot can run, in plain words. */
export function missingSettings(cfg) {
  const missing = [];
  if (!cfg.discordToken) missing.push("the Discord bot token");
  if (!cfg.anthropicApiKey) missing.push("the Claude API key");
  if (!cfg.deepgramApiKey) missing.push("the Deepgram API key");
  return missing;
}

/* house-rules.md: player-safe rules text, given to Angel with every question. */
export function readHouseRules(file = LOCAL_FILES.houseRules) {
  return fs.existsSync(file) ? readText(file).trim() : "";
}

/* keyterms.txt: one name per line (places, people, homebrew words) so the transcriber spells them right. # starts a comment. */
export function readKeyterms(file = LOCAL_FILES.keyterms) {
  const terms = fs.existsSync(file)
    ? readText(file).split(/\r?\n/).map(l => l.replace(/#.*/, "").trim()).filter(Boolean)
    : [];
  /* Angel's own name first; Deepgram allows a limited number of terms, so keep the list short */
  return [...new Set(["Angel", ...terms])].slice(0, 100);
}

/* speakers.json: { "<discord user id>": { "name": "Mira", "role": "player" | "GM" } }.
   `/angel iam` writes a player's own entry; the GM can edit the file by hand. */
export function readSpeakers(file = LOCAL_FILES.speakers, { strict = false, onError = null } = {}) {
  if (!fs.existsSync(file)) return {};
  try {
    const v = JSON.parse(readText(file));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("it isn't a { ... } of names");
    return v;
  } catch (e) {
    /* strict: the caller is about to write the file and must not wipe a hand-edited one with a typo in it */
    if (strict) throw new Error(`speakers.json: ${e.message}`);
    onError?.(e);
    return {};
  }
}

export function writeSpeakers(speakers, file = LOCAL_FILES.speakers) {
  fs.writeFileSync(file, JSON.stringify(speakers, null, 2) + "\n", "utf8");
}

/* What npm run check says about the table's own files. With file extensions hidden, a file renamed in File
   Explorer is easily "house-rules.md.txt", which Angel would never read. */
export function tableFilesReport(files = LOCAL_FILES) {
  const lines = [];
  const doubled = f => fs.existsSync(`${f}.txt`) && !fs.existsSync(f);
  const showNames = "(in File Explorer, View → Show → File name extensions shows the real name)";
  const rules = readHouseRules(files.houseRules);
  if (rules) lines.push({ level: "ok", what: "House rules", text: `house-rules.md, ${rules.length} characters` });
  else if (doubled(files.houseRules)) lines.push({ level: "fail", what: "House rules", text: `the file is called house-rules.md.txt: rename it to house-rules.md ${showNames}` });
  else lines.push({ level: "note", what: "House rules", text: "no house-rules.md in this folder, so Angel answers from Archives of Nethys alone" });
  const terms = readKeyterms(files.keyterms).length - 1;
  if (terms > 0) lines.push({ level: "ok", what: "Key terms", text: `keyterms.txt, ${terms} name${terms === 1 ? "" : "s"}` });
  else if (doubled(files.keyterms)) lines.push({ level: "fail", what: "Key terms", text: `the file is called keyterms.txt.txt: rename it to keyterms.txt ${showNames}` });
  else lines.push({ level: "note", what: "Key terms", text: "no names in keyterms.txt, so campaign names may be misheard" });
  try {
    const n = Object.keys(readSpeakers(files.speakers, { strict: true })).length;
    if (n) lines.push({ level: "ok", what: "Speakers", text: `speakers.json, ${n} name${n === 1 ? "" : "s"}` });
  } catch (e) { lines.push({ level: "fail", what: "Speakers", text: `${e.message}: fix it in Notepad, or delete it and use /angel iam again` }); }
  return lines;
}

/* What to do about a refused key, added to npm run check's FAIL line for that service. */
export function fixFor(service, message) {
  const m = String(message);
  if (service === "Discord" && /invalid token/i.test(m)) return "the token was refused: run npm run setup and paste a fresh one (Developer Portal → Bot → Reset Token)";
  if (/\b(401|403)\b/.test(m)) return `the ${service} key was refused: run npm run setup and paste it again`;
  if (/\b402\b|credit|balance|billing/i.test(m)) return `${service} wants payment or credit on the account`;
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|took longer/i.test(m)) return `couldn't reach ${service}: check the internet connection (a VPN or firewall can block it), then try again`;
  return "";
}

/* A pasted key that doesn't look like one (pasted twice, or into the wrong question): a warning, not a refusal */
export function keyLooksWrong(which, key) {
  if (!key) return "";
  if (/\s/.test(key)) return "it has a space or line break in it";
  if (which === "anthropicApiKey" && (!key.startsWith("sk-ant-") || key.indexOf("sk-ant-", 1) > 0)) return "Claude keys start with sk-ant- (once)";
  if (which === "discordToken" && !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(key)) return "Discord tokens are three parts with dots between them";
  if (which === "deepgramApiKey" && key.length > 80) return "it's much longer than a Deepgram key (pasted twice?)";
  return "";
}

export function ensureDataDir(dir = DATA_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
