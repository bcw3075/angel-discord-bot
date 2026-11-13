/* Knowing when someone is talking TO Angel. First a free text check: does the line name her (or a word the
   transcriber makes of "Angel")? Only then a cheap model (Haiku) reads the last few lines and decides whether she was
   addressed, so an angel in the story ("the angel statue", a Nephilim's heritage) doesn't set her off. */

const NAME = String.raw`(?:angel|angela|angie|angle|anjel|angell|aingel|ainjel)`;
const NAME_RE = new RegExp(String.raw`(?:^|[^a-z'])${NAME}(?![a-z])`, "i");
const STOP_WORDS = String.raw`(?:stop|quiet|hush|shush|enough|that'?s enough|be quiet|shut up|cancel|never ?mind|that'?s fine|thanks,? that'?s all)`;
const STOP_RE = new RegExp(String.raw`(?:^|[^a-z'])${NAME}(?![a-z'])[\s,.!?-]*(?:please[\s,]+)?${STOP_WORDS}\b`, "i");

export function mentionsAngel(text) {
  return NAME_RE.test(String(text));
}

/* "Angel, stop" and friends: acted on at once, without the model check. */
export function isStopRequest(text) {
  return STOP_RE.test(String(text));
}

export const GATE_SYSTEM = `You watch the transcript of a tabletop game played over voice chat. The table has an AI assistant called Angel who answers rules questions. The transcriber sometimes writes her name as Angela, Angie or angle.
Decide whether the LAST line was said to Angel herself: someone asking her something or telling her something. It was NOT said to her when "angel" is part of the game (an angel creature, an angelic character or heritage, a statue, a spell), when people talk about her without addressing her ("Angel was right earlier"), or when the word is just "angle" in its normal meaning.
Reply with JSON only, no other text:
{"to_angel": true or false, "complete": true or false, "stop": true or false, "question": "..."}
- complete: false when they called her but haven't said the question yet ("Angel?", "Hey Angel, quick one..."); true otherwise.
- stop: true when they're telling her to stop talking or that they're done.
- question: what they want from her, written to stand on its own using the earlier lines ("" when there's nothing yet).`;

export function gateUser(contextLines, last) {
  return `Earlier lines:\n${contextLines || "(none)"}\n\nLAST line:\n${last}`;
}

/* The model's reply → a decision. When it can't be read, fall back to the plain rule: her name first, then a request. */
export function parseGate(text, lastLineText = "") {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      return {
        toAngel: j.to_angel === true,
        complete: j.complete !== false,
        stop: j.stop === true,
        question: typeof j.question === "string" ? j.question.trim() : "",
        fallback: false,
      };
    } catch { /* fall through */ }
  }
  const direct = new RegExp(String.raw`^\W*(?:hey|ok(?:ay)?|so|um+|uh+)?[\s,]*${NAME}(?![a-z'])[\s,!?:-]+\S`, "i").test(lastLineText);
  return { toAngel: direct, complete: true, stop: isStopRequest(lastLineText), question: direct ? lastLineText : "", fallback: true };
}

/* Ask the gate model. Returns the decision and what it cost. */
export async function gate({ claude, model, contextText, lastText }) {
  try {
    const json = await claude.create({
      model,
      max_tokens: 200,
      system: [{ type: "text", text: GATE_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: gateUser(contextText, lastText) }],
    });
    const text = (json.content ?? []).filter(b => b.type === "text").map(b => b.text).join("");
    /* this call's own cost: a delta of the running total would be wrong while an answer runs at the same time */
    return { ...parseGate(text, lastText), dollars: claude.cost(model, json.usage) };
  } catch (e) {
    const decision = parseGate("", lastText);
    decision.error = e.message;
    return decision;
  }
}
