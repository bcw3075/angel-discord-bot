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
