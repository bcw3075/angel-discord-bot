/* The session transcript: every line with its time and speaker, kept in order of when it was said (pieces of speech
   are transcribed in parallel and can arrive out of order). Written as it goes to data/sessions/<start>/:
   transcript.md (to read) and transcript.jsonl (every piece as heard, for tools such as a later recap). Text only,
   never audio. At the end transcript.md is written again tidied (0.2.1, `tidy`): short backchannel lines ("Yeah",
   "Mhmm") left out and one speaker's pieces a few seconds apart joined; transcript.jsonl is never tidied. */
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
  add({ at = Date.now(), end = null, userId = null, speaker, role = "player", text, kind = "voice" }) {
    /* one line each: a typed message with line breaks could otherwise look like several lines, one of them "the GM's" */
    const line = { at, userId, speaker, role, text: String(text).replace(/\s+/g, " ").trim(), kind };
    /* when the piece of speech ended (it began at `at`): what tidy() measures the gap to the next piece from */
    if (Number.isFinite(end) && end >= at) line.end = end;
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
     order the text arrived, which can be a few seconds out), tidied for reading (0.2.1). The lines in memory and
     transcript.jsonl keep every piece as heard. */
  close() {
    if (!this.dir || this.closedFile) return;
    this.closedFile = true;
    try {
      const head = fs.readFileSync(this.md, "utf8").split("\n").find(l => l.startsWith("# ")) ?? "# Session transcript";
      fs.writeFileSync(this.md, readable(head, this.lines));
    } catch { /* the transcript file is a convenience */ }
  }

  static format(lines) {
    return lines.map(l => `[${clock(l.at)}] ${label(l)}${l.kind === "text" ? " (typed)" : ""}: ${l.text}`).join("\n");
  }
}

/* ---- Tidying the readable transcript (0.2.1) ----
   A real two-hour session (2026-11-25, 942 lines): 28% of lines were one or two words of backchannel ("Yeah",
   "Mhmm", "Okay") and one speaker's sentence was often cut into pieces a few seconds apart. For whoever reads it
   or writes a summary from it, transcript.md leaves the backchannel out and joins the pieces. Nothing is lost:
   transcript.jsonl keeps every piece as heard. */

/* words that are only a listener's noises; a line made of these alone (one or two words) is backchannel */
const BACKCHANNEL = new Set(["yeah", "yea", "yep", "yup", "mhmm", "mhm", "mmhmm", "mm-hmm", "mmm", "mm", "hmm", "hm", "uh-huh", "uh", "um", "umm", "okay", "ok", "kay", "alright", "right", "sure", "cool", "nice", "oh", "ah", "ooh", "wow", "gotcha", "true", "totally", "exactly", "indeed"]);
/* little words that go with backchannel ("but yeah", "so yeah", "okay okay") but alone are a cut-off piece, joined instead */
const LINKING = new Set(["but", "so", "and", "well", "anyhow", "anyway"]);
/* "No", "Yes", "Nope" and "Mm-mm" are never left out: they answer something */

const wordsOf = text => text.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter(Boolean);
const normal = words => words.join(" ").replace(/\ball right\b/g, "alright").replace(/\bgot it\b/g, "gotcha").split(" ");

export function isBackchannel(text) {
  const words = normal(wordsOf(String(text)));
  if (!words.length || words.length > 2) return false;
  return words.every(w => BACKCHANNEL.has(w) || LINKING.has(w)) && words.some(w => BACKCHANNEL.has(w));
}

/* when a piece ended: its own end when the session recorded it (0.2.1 on), otherwise guessed from its words (about
   0.4 s each, the pace of a real session, at most the 30 s a piece can last) for transcripts written before */
const endOf = l => l.end ?? l.at + Math.min(30000, wordsOf(l.text).length * 400);

/* lines: in the order they were said. Returns new lines (the given ones are not changed) plus what was done.
   - a backchannel line is left out, unless the line before it from someone else asked a question (then "Yeah" is
     an answer), and never Angel's or a typed line;
   - a speaker's voice piece is joined onto their previous one when it began within joinGapMs of that one's end,
     nobody else said anything kept in between, and the joined line spans no more than maxJoinMs. */
export function tidy(lines, { joinGapMs = 3000, maxJoinMs = 90000 } = {}) {
  const out = [];
  let folded = 0, joined = 0;
  for (const l of lines) {
    if (l.kind === "voice" && isBackchannel(l.text)) {
      const prev = out[out.length - 1];
      const answers = prev && prev.speaker !== l.speaker && /\?\s*$/.test(prev.text);
      if (!answers) { folded++; continue; }
    }
    const prev = out[out.length - 1];
    if (prev && l.kind === "voice" && prev.kind === "voice" && prev.speaker === l.speaker && prev.userId === l.userId &&
        l.at - prev.end <= joinGapMs && endOf(l) - prev.at <= maxJoinMs) {
      prev.text = `${prev.text} ${l.text}`;
      prev.end = Math.max(prev.end, endOf(l));
      joined++;
      continue;
    }
    out.push({ ...l, end: endOf(l) });
  }
  return { lines: out.map(({ end, ...rest }) => rest), folded, joined };
}

/* the readable file: its title, a line saying what was tidied, then the tidied lines */
export function readable(head, lines) {
  const t = tidy(lines);
  const note = t.folded || t.joined
    ? `_Tidied for reading: ${t.folded} short backchannel line${t.folded === 1 ? "" : "s"} ("yeah", "mhmm") left out and ${t.joined} piece${t.joined === 1 ? "" : "s"} of speech joined to the line before. transcript.jsonl has every piece as heard._\n\n`
    : "";
  return `${head}\n\n${note}${t.lines.map(l => `[${clock(l.at)}] ${label(l)}: ${l.text}`).join("\n")}\n`;
}

function label(l) {
  if (l.kind === "angel") return "Angel";
  return l.role === "GM" ? `${l.speaker} (GM)` : l.speaker;
}
