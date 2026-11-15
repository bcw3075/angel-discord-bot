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
  maxAnswerTokens: 3000,
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
  replyWindowMs: 60000,
  /* she starts speaking as soon as her first spoken sentence is written, instead of when the whole answer is */
  speakAsWritten: true,
  /* a busy table (0.1.3, Rhea's d-7): when people are talking as her answer is ready she waits up to busyFirstWaitMs
     for a pause of busyPauseMs; if none comes she says a quick "I'm ready" in her own words, then waits for
     busyGapMs of quiet or a go-ahead, and lets the spoken answer go after busyMaxHoldMs. Talk shorter than
     busyBlipMs (a cough) doesn't count. false: she speaks at once, as before 0.1.3. */
  busyTable: true,
  busyBlipMs: 500,
  busyPauseMs: 800,
  busyFirstWaitMs: 2000,
  busyGapMs: 1500,
  busyMaxHoldMs: 60000,
  sessionThread: true,
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
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.toString("utf16le");
  else if (buf[0] === 0xfe && buf[1] === 0xff) text = Buffer.from(buf.subarray(0, buf.length - (buf.length % 2))).swap16().toString("utf16le");
  else text = buf.toString("utf8");
  return text.replace(/^\uFEFF/, "");
}

/* A setting keeps the kind its default has: "false" typed with quote marks is still false, "$5" is 5. One that
   can't be read that way gets the default and a problem line (npm run check shows it), because a spending cap left
   as text would never trip. */
function sameKind(key, value, fallback, problems) {
  if (typeof fallback === "boolean") {
    if (typeof value === "boolean") return value;
    const t = String(value).trim();
    if (/^(true|yes|on|1)$/i.test(t)) return true;
    if (/^(false|no|off|0)$/i.test(t)) return false;
    problems.push(`"${key}" should be true or false, not ${JSON.stringify(value)}, so ${fallback} is used`);
    return fallback;
  }
  if (typeof fallback === "number") {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const t = typeof value === "string" ? value.replace(/[$,\s]/g, "") : "";
    if (t !== "" && Number.isFinite(Number(t))) return Number(t);
    problems.push(`"${key}" should be a number, not ${JSON.stringify(value)}, so ${fallback} is used`);
    return fallback;
  }
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
  const problems = [];
  for (const k of Object.keys(saved)) if (k in DEFAULTS) saved[k] = sameKind(k, saved[k], DEFAULTS[k], problems);
  /* a server id is 18 or 19 digits: without quote marks JSON rounds it, and it matches no server */
  if (saved.guildId !== undefined && typeof saved.guildId !== "string") {
    problems.push(`"guildId" needs its quote marks (without them a long number loses its last digits): run npm run setup once more to save it again`);
  }
  const cfg = { ...DEFAULTS, ...saved, prices: { ...DEFAULTS.prices, ...(saved.prices ?? {}) }, deepgramPrices: { ...DEFAULTS.deepgramPrices, ...(saved.deepgramPrices ?? {}) } };
  /* the price tables decide what counts against the caps: a price that isn't a number would make every total "not a
     number", so such an entry is dropped (the default, or the dearest known price, is used) and named */
  for (const [model, row] of Object.entries(cfg.prices)) {
    if (!Array.isArray(row) || row.length < 4 || !row.every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)) {
      problems.push(`the price for "${model}" should be a list of numbers, not ${JSON.stringify(row)}, so ${DEFAULTS.prices[model] ? "the built-in price" : "the dearest known price"} is used`);
      if (DEFAULTS.prices[model]) cfg.prices[model] = DEFAULTS.prices[model]; else delete cfg.prices[model];
    }
  }
  for (const [k, v] of Object.entries(DEFAULTS.deepgramPrices)) {
    if (typeof cfg.deepgramPrices[k] !== "number" || !Number.isFinite(cfg.deepgramPrices[k]) || cfg.deepgramPrices[k] < 0) {
      problems.push(`the Deepgram price "${k}" should be a number, not ${JSON.stringify(cfg.deepgramPrices[k])}, so ${v} is used`);
      cfg.deepgramPrices[k] = v;
    }
  }
  /* settings that only make sense above a floor: below it the default is used and named */
  for (const [k, min] of Object.entries({ maxSessionDollars: 0, maxDailyDollars: 0, memoryMinutes: 1, maxAnswerTokens: 300, silenceMs: 200, maxUtteranceSeconds: 5, replyWindowMs: 0, followUpMs: 1000, busyBlipMs: 0, busyPauseMs: 100, busyFirstWaitMs: 0, busyGapMs: 300, busyMaxHoldMs: 1000 })) {
    if (!(cfg[k] >= min)) { problems.push(`"${k}" should be ${min} or more, not ${JSON.stringify(cfg[k])}, so ${DEFAULTS[k]} is used`); cfg[k] = DEFAULTS[k]; }
  }
  for (const model of new Set([cfg.answerModel, cfg.gateModel])) {
    if (!cfg.prices[model]) problems.push(`no price is known for "${model}", so its cost is counted at the dearest price in the table`);
  }
  /* not enumerable, so saveConfig never writes it */
  Object.defineProperty(cfg, "problems", { value: problems, enumerable: false });
  return cfg;
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
  const keyed = service === "Claude" || service === "Deepgram";
  if (service === "Discord" && /invalid token/i.test(m)) return "the token was refused: run npm run setup and paste a fresh one (Developer Portal → Bot → Reset Token)";
  if (keyed && /answered (401|403)\b/.test(m)) return `the ${service} key was refused: run npm run setup and paste it again`;
  if (keyed && /answered 402\b|credit balance|billing/i.test(m)) return `${service} wants payment or credit on the account`;
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|took longer|aborted due to timeout|timed out|didn't answer within/i.test(m)) return `couldn't reach ${service}: check the internet connection (a VPN or firewall can block it), then try again`;
  return "";
}

/* A pasted key that doesn't look like one (pasted twice, two keys run together, the wrong question). Setup's askKey
   doesn't save it and asks again; keyCertainlyWrong says which can never be a real key, so pasting the same one
   twice can't save it either. The format checks alone are only a guess, so the same key twice saves past them. */
export function keyLooksWrong(which, key) {
  if (!key) return "";
  if (/\s/.test(key)) return "it has a space or line break in it";
  if (key.length >= 20 && key.length % 2 === 0 && key.slice(0, key.length / 2) === key.slice(key.length / 2)) return "it looks pasted twice";
  if (which === "anthropicApiKey" && (!key.startsWith("sk-ant-") || key.indexOf("sk-ant-", 1) > 0)) return "Claude keys start with sk-ant- (once)";
  if (which === "discordToken" && !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(key)) return "Discord tokens are three parts with dots between them";
  if (which === "deepgramApiKey" && key.length > 40) return "it's longer than a Deepgram key (two pasted together?)";
  if (which === "deepgramApiKey" && !/^[0-9a-f]+$/i.test(key)) return "Deepgram keys are letters a to f and digits only";
  return "";
}

/* never a real key, whatever the format: a space, the same paste twice, two keys run together */
export function keyCertainlyWrong(which, key) {
  if (!key) return false;
  if (/\s/.test(key)) return true;
  if (key.length >= 20 && key.length % 2 === 0 && key.slice(0, key.length / 2) === key.slice(key.length / 2)) return true;
  if (which === "anthropicApiKey" && key.indexOf("sk-ant-", 1) > 0) return true;
  if (which === "discordToken" && (key.match(/\./g) || []).length > 2) return true;
  if (which === "deepgramApiKey" && key.length >= 80) return true;
  return false;
}

/* what setup shows after a paste, so the owner can see it arrived whole without the key on screen (or in a screenshot):
   the first few characters (a quarter at most, 12 at most), the last 4 and the length */
export function pasteSummary(key) {
  if (!key) return "";
  if (key.length < 16) return `${key.length} characters`;
  const head = Math.min(12, Math.floor(key.length / 4));
  return `starts ${key.slice(0, head)}, ends ...${key.slice(-4)}, ${key.length} characters`;
}

export function ensureDataDir(dir = DATA_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
