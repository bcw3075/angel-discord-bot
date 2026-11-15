/* Turning an answer into something that sounds right when spoken: no markdown, no links, dice and modifiers said out loud.
   The same answer is typed with its links; only the spoken copy goes through here. */

export function speakable(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1")          /* [Grapple](url) → Grapple */
    .replace(/<?https?:\/\/\S+>?/g, "")                    /* bare links */
    .replace(/[*_`#>|~]+/g, "")                            /* markdown marks */
    .replace(/^\s*[-•]\s+/gm, "")                          /* list bullets */
    .replace(/\b(\d+)d(\d+)\b/gi, "$1 d $2")               /* 2d6 → 2 d 6 */
    .replace(/(^|[\s(])\+(\d+)/g, "$1plus $2")             /* +2 → plus 2 */
    .replace(/(^|[\s(])[-−–](\d+)\b/g, "$1minus $2")       /* -1 → minus 1 (only a sign, not a range) */
    .replace(/\be\.g\.\s*/gi, "for example ")
    .replace(/\bi\.e\.\s*/gi, "that is ")
    .replace(/\bvs\.?\s/gi, "versus ")
    .replace(/\s+/g, " ")
    .trim();
}

/* Cuts text into sentences while it is still being written: push() takes each new piece and gives back the sentences
   that are now whole, flush() gives what is left at the end. A sentence ends at . ! or ? (and any closing quote or
   bracket) once the space after it has arrived, so "2.5" and a number still being written are never cut. Very short
   sentences ("Yes.") stay with the next one, which sounds better as one clip, and "e.g." and its kind end nothing.
   Plain character steps, no regex. */
const NOT_AN_END = new Set(["e.g", "i.e", "vs", "mr", "mrs", "ms", "dr", "st"]);

export class SentenceCutter {
  constructor({ minChars = 16 } = {}) {
    this.minChars = minChars;
    this.buf = "";
    this.scanned = 0; /* everything before this has been looked at and holds no cut */
    this.marksTo = 0; /* the end marks from `scanned` on have been read this far (so a long run isn't read again) */
  }

  push(piece) {
    this.buf += String(piece ?? "");
    const out = [];
    let i = this.scanned;
    while (i < this.buf.length) {
      const c = this.buf[i];
      if (c !== "." && c !== "!" && c !== "?") { i++; continue; }
      let end = i === this.scanned ? Math.max(i + 1, this.marksTo) : i + 1;
      while (end < this.buf.length && ".!?\"')]”’".includes(this.buf[end])) end++;
      if (end >= this.buf.length) { this.marksTo = end; break; } /* what follows hasn't been written yet */
      if (!" \n\t".includes(this.buf[end])) { i = end; continue; }
      const sentence = this.buf.slice(0, end).trim();
      if (sentence.length < this.minChars || (c === "." && NOT_AN_END.has(lastWord(sentence)))) { i = end; continue; }
      out.push(sentence);
      this.buf = this.buf.slice(end);
      i = 0;
      this.scanned = -1;
    }
    if (i >= this.buf.length) this.marksTo = 0;
    this.scanned = Math.min(i, this.buf.length);
    return out;
  }

  flush() {
    const rest = this.buf.trim();
    this.buf = "";
    this.scanned = 0;
    this.marksTo = 0;
    return rest;
  }
}

/* the last word of a sentence, without its closing marks, in lower case: "…for a buckler, e.g." → "e.g" */
function lastWord(sentence) {
  let end = sentence.length;
  while (end > 0 && ".!?\"')]”’".includes(sentence[end - 1])) end--;
  let start = end;
  while (start > 0 && !" \n\t(".includes(sentence[start - 1])) start--;
  return sentence.slice(start, end).toLowerCase();
}
