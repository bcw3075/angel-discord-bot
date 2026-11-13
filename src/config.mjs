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
  leaveWhenEmptySeconds: 60,
  /* dollars per million tokens: [fresh input, 5-minute cache write, cache read, output] (Claude pricing, checked 2026-11-12) */
  prices: {
    "claude-sonnet-5-5": [2, 2.5, 0.1, 10],
    "claude-haiku-5-5": [0.1, 0.125, 0.01, 0.5],
    "claude-opus-5-5": [4, 5, 0.2, 20],
  },
  /* Deepgram pay-as-you-go (checked 2026-11-12): Nova-3 pre-recorded per minute, key terms per minute, voice per 1,000 characters */
  deepgramPrices: { sttPerMinute: 0.0043, keytermPerMinute: 0.0013, ttsPer1000Chars: 0.03 },
  aonUserAgent: "AngelTableBot/0.1 (a private Pathfinder table helper; https://github.com/bcw3075/angel-discord-bot)",
});

export function loadConfig(file = CONFIG_PATH) {
  let saved = {};
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
    try { saved = JSON.parse(text); }
    catch (e) { throw new Error(`${path.basename(file)} is not valid JSON (${e.message}). Fix it or run npm run setup again.`); }
  }
  return { ...DEFAULTS, ...saved, prices: { ...DEFAULTS.prices, ...(saved.prices ?? {}) }, deepgramPrices: { ...DEFAULTS.deepgramPrices, ...(saved.deepgramPrices ?? {}) } };
}

export function saveConfig(cfg, file = CONFIG_PATH) {
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
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
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/^﻿/, "").trim() : "";
}

/* keyterms.txt: one name per line (places, people, homebrew words) so the transcriber spells them right. # starts a comment. */
export function readKeyterms(file = LOCAL_FILES.keyterms) {
  const terms = fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/).map(l => l.replace(/#.*/, "").trim()).filter(Boolean)
    : [];
  /* Angel's own name first; Deepgram allows a limited number of terms, so keep the list short */
  return [...new Set(["Angel", ...terms])].slice(0, 100);
}

/* speakers.json: { "<discord user id>": { "name": "Mira", "role": "player" | "GM" } }.
   `/angel iam` writes a player's own entry; the GM can edit the file by hand. */
export function readSpeakers(file = LOCAL_FILES.speakers) {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); }
  catch { return {}; }
}

export function writeSpeakers(speakers, file = LOCAL_FILES.speakers) {
  fs.writeFileSync(file, JSON.stringify(speakers, null, 2) + "\n", "utf8");
}

export function ensureDataDir(dir = DATA_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
