/* Write a session's readable transcript.md again, tidied, from its transcript.jsonl (every piece as heard):
     npm run tidy -- <session folder>   (or node src/tidy.mjs <folder>)
   For a session that ended without closing (a crash) or was written before 0.2.1. transcript.jsonl is only read. */
import fs from "node:fs";
import path from "node:path";
import { readable } from "./transcript.mjs";

export function tidyFolder(dir) {
  const jsonl = path.join(dir, "transcript.jsonl");
  const md = path.join(dir, "transcript.md");
  const lines = fs.readFileSync(jsonl, "utf8").split("\n").filter(l => l.trim()).map(l => JSON.parse(l))
    .map((l, i) => ({ ...l, i })).sort((a, b) => a.at - b.at || a.i - b.i).map(({ i, ...l }) => l);
  let head = "# Session transcript";
  try { head = fs.readFileSync(md, "utf8").split("\n").find(l => l.startsWith("# ")) ?? head; } catch { /* none yet */ }
  fs.writeFileSync(md, readable(head, lines));
  return { lines: lines.length, md };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  const dir = process.argv[2];
  if (!dir) { console.error("Usage: npm run tidy -- <session folder>"); process.exit(1); }
  const r = tidyFolder(dir);
  console.log(`${r.md} written from ${r.lines} pieces.`);
}
