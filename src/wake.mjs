/* Knowing when someone is talking TO Angel. First a free text check: does the line name her (or a word the
   transcriber makes of "Angel")? Only then a cheap model (Haiku) reads the last few lines and decides whether she was
   addressed, so an angel in the story ("the angel statue", a Nephilim's heritage) doesn't set her off. */

const NAME = String.raw`(?:angel|angela|angie|angle|anjel|angell|aingel|ainjel)`;
const NAME_RE = new RegExp(String.raw`(?:^|[^a-z'])${NAME}(?![a-z])`, "i");
const LEAD = String.raw`^\W*(?:(?:hey|ok(?:ay)?|so|um+|uh+|oh)[\s,]+)?`;
const STOP_WORDS = String.raw`(?:stop|quiet|hush|shush|enough|that'?s enough|be quiet|shut up|cancel|never ?mind|that'?s fine|thanks,? that'?s all)`;
/* her name first, a stop word, and at most three more words: "Angel, stop please", "okay Angel, that's enough, thanks".
   A question after it ("Angel, never mind that, how does flanking work?") or the story ("the angel, quiet as death")
   is not a stop; such a line still goes through the model check, which can say stop. The pattern stops at the stop
   word and the words after it are counted in code: a pattern that also matched the tail backtracked exponentially
   on a typed run of apostrophes and froze the bot (second review, 2026-11-13). */
const STOP_HEAD = new RegExp(String.raw`${LEAD}${NAME}(?![a-z'])[\s,.!?-]*(?:please[\s,]+)?${STOP_WORDS}\b`, "i");
const STOP_MAX_CHARS = 120;

export function mentionsAngel(text) {
  return NAME_RE.test(String(text));
}

/* "Angel, stop" and friends: acted on at once, without the model check. */
export function isStopRequest(text) {
  const t = String(text).trim();
  if (t.length > STOP_MAX_CHARS) return false;
  const m = STOP_HEAD.exec(t);
  if (!m) return false;
  return (t.slice(m[0].length).match(/[a-z0-9']+/gi) ?? []).length <= 3;
}

export const GATE_SYSTEM = `You watch the transcript of a tabletop game played over voice chat. The table has an AI assistant called Angel who answers rules questions. The transcriber sometimes writes her name as Angela, Angie or angle.
Decide whether the LAST line was said to Angel herself: someone asking her something or telling her something. A line right after Angel spoke that answers or reacts to what she said ("ha, good one", "thanks", "wait, even with a buckler?") was said to her even without her name. Only a line that is nothing but an acknowledgement ("okay", "thanks", "got it") needs no reply: to_angel false. A line that starts with one and then asks something ("Okay. Good. What about stacking?") is to_angel true. It was NOT said to her when "angel" is part of the game (an angel creature, an angelic character or heritage, a statue, a spell), when people talk about her without addressing her ("Angel was right earlier"), or when the word is just "angle" in its normal meaning.
Reply with JSON only, no other text:
{"to_angel": true or false, "complete": true or false, "stop": true or false, "chat": true or false, "question": "..."}
- complete: false when they called her but haven't said the question yet ("Angel?", "Hey Angel, quick one..."); true otherwise.
- stop: true when they're telling her to stop talking or that they're done.
- chat: true when it's banter or small talk that needs no rules lookup ("you were listening", "how are you?"); false for a rules question.
- question: what they want from her, written to stand on its own using the earlier lines ("" when there's nothing yet).`;

export function gateUser(contextLines, last, replying = false) {
  const note = replying ? "\n\n(Angel has just answered this person; a follow-up without her name is usually for her.)" : "";
  return `Earlier lines:\n${contextLines || "(none)"}\n\nLAST line:\n${last}${note}`;
}

/* The model's reply → a decision. When it can't be read, fall back to the plain rule: her name first, then a request. */
export function parseGate(text, lastLineText = "") {
  lastLineText = String(lastLineText).slice(0, 300); /* the plain rule only needs the start of the line */
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      return {
        toAngel: j.to_angel === true,
        complete: j.complete !== false,
        stop: j.stop === true,
        chat: j.chat === true,
        question: typeof j.question === "string" ? j.question.trim() : "",
        fallback: false,
      };
    } catch { /* fall through */ }
  }
  const direct = new RegExp(String.raw`^\W*(?:hey|ok(?:ay)?|so|um+|uh+)?[\s,]*${NAME}(?![a-z'])[\s,!?:-]+\S`, "i").test(lastLineText);
  return { toAngel: direct, complete: true, stop: isStopRequest(lastLineText), chat: false, question: direct ? lastLineText : "", fallback: true };
}

/* Ask the gate model. Returns the decision and what it cost. `lastText` is the line as the model sees it
   ("Mira: Angel, ..."); `bareText` is what was said, which the fallback rule reads (it looks for her name first). */
export async function gate({ claude, model, contextText, lastText, bareText = lastText, replying = false }) {
  try {
    const json = await claude.create({
      model,
      max_tokens: 200,
      system: [{ type: "text", text: GATE_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: gateUser(contextText, lastText, replying) }],
    });
    const text = (json.content ?? []).filter(b => b.type === "text").map(b => b.text).join("");
    /* this call's own cost: a delta of the running total would be wrong while an answer runs at the same time */
    return { ...parseGate(text, bareText), dollars: claude.cost(model, json.usage) };
  } catch (e) {
    const decision = parseGate("", bareText);
    decision.error = e.message;
    return decision;
  }
}
