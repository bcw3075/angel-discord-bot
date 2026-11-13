/* The session transcript: every line with its time and speaker, kept in order of when it was said (pieces of speech
   are transcribed in parallel and can arrive out of order). Written as it goes to data/sessions/<start>/:
   transcript.md (to read) and transcript.jsonl (for tools such as a later recap). Text only, never audio. */
import fs from "node:fs";
import path from "node:path";

const pad = n => String(n).padStart(2, "0");
export const clock = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
export const folderName = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`; };

export class Transcript {
  constructor({ dir = null, startedAt = Date.now(), title = "Session" } = {}) {
    this.lines = [];
    this.startedAt = startedAt;
    this.dir = dir;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      this.md = path.join(dir, "transcript.md");
      this.jsonl = path.join(dir, "transcript.jsonl");
      if (!fs.existsSync(this.md)) fs.writeFileSync(this.md, `# ${title} transcript, ${new Date(startedAt).toLocaleString()}\n\n`);
    }
  }

  /* kind: "voice" (said), "text" (typed), "angel" (Angel's answer) */
  add({ at = Date.now(), userId = null, speaker, role = "player", text, kind = "voice" }) {
    const line = { at, userId, speaker, role, text: String(text).trim(), kind };
    if (!line.text) return null;
    let i = this.lines.length;
    while (i > 0 && this.lines[i - 1].at > at) i--;
    this.lines.splice(i, 0, line);
    if (this.dir) {
      try {
        fs.appendFileSync(this.md, `[${clock(at)}] ${label(line)}: ${line.text}\n`);
        fs.appendFileSync(this.jsonl, JSON.stringify(line) + "\n");
      } catch { /* the transcript file is a convenience; the session goes on */ }
    }
    return line;
  }

  recent(minutes, now = Date.now()) {
    const from = now - minutes * 60000;
    return this.lines.filter(l => l.at >= from);
  }

  /* the last n lines before (and including) a given line */
  before(line, n) {
    const i = this.lines.indexOf(line);
    return this.lines.slice(Math.max(0, (i < 0 ? this.lines.length : i + 1) - n), i < 0 ? undefined : i + 1);
  }

  /* At the end of the session, write transcript.md again in the order things were said (it is appended in the
     order the text arrived, which can be a few seconds out). */
  close() {
    if (!this.dir || this.closedFile) return;
    this.closedFile = true;
    try {
      const head = fs.readFileSync(this.md, "utf8").split("\n").find(l => l.startsWith("# ")) ?? "# Session transcript";
      fs.writeFileSync(this.md, `${head}\n\n${this.lines.map(l => `[${clock(l.at)}] ${label(l)}: ${l.text}`).join("\n")}\n`);
    } catch { /* the transcript file is a convenience */ }
  }

  static format(lines) {
    return lines.map(l => `[${clock(l.at)}] ${label(l)}${l.kind === "text" ? " (typed)" : ""}: ${l.text}`).join("\n");
  }
}

function label(l) {
  if (l.kind === "angel") return "Angel";
  return l.role === "GM" ? `${l.speaker} (GM)` : l.speaker;
}
