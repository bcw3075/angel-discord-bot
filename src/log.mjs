/* One logger: the console window and data/angel.log. Every line has the secret keys blanked out. */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, SECRET_KEYS } from "./config.mjs";

let secrets = [];
let file = null;

export function initLog(cfg, dir = DATA_DIR) {
  secrets = SECRET_KEYS.map(k => cfg[k]).filter(v => typeof v === "string" && v.length >= 8);
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, "angel.log");
}

export function redact(text) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join("[hidden]");
  return out;
}

const stamp = () => {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function write(level, parts) {
  const text = redact(parts.map(p => (p instanceof Error ? (p.stack || p.message) : typeof p === "string" ? p : JSON.stringify(p))).join(" "));
  const line = `${stamp()} ${level} ${text}`;
  (level === "ERROR" ? console.error : console.log)(line);
  if (file) { try { fs.appendFileSync(file, line + "\n"); } catch { /* a full disk must not stop the bot */ } }
}

export const log = {
  info: (...p) => write("INFO", p),
  warn: (...p) => write("WARN", p),
  error: (...p) => write("ERROR", p),
  debug: (...p) => { if (process.env.ANGEL_DEBUG) write("DEBUG", p); },
};
