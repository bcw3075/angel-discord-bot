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

/* "Angel, stop. What does stunned do?" → "What does stunned do?": their own words after the stop, or "" when the
   line doesn't begin with a stop */
export function afterStop(text) {
  const t = String(text).trim().slice(0, 2000);
  const m = STOP_HEAD.exec(t);
  if (!m) return "";
  let rest = t.slice(m[0].length);
  /* the politeness that goes with a stop is not part of the question ("stop please. What does…", "that's enough, thanks. How…") */
  for (let again = true; again;) {
    again = false;
    let i = 0;
    while (i < rest.length && " ,.!?;:-".includes(rest[i])) i++;
    rest = rest.slice(i);
    for (const word of ["please", "thanks", "thank you", "now", "okay", "ok", "that", "this", "it"]) {
      if (rest.toLowerCase().startsWith(word) && !/[a-z]/i.test(rest[word.length] ?? "")) { rest = rest.slice(word.length); again = true; break; }
    }
  }
  return rest.trim();
}

export const GATE_SYSTEM = `You watch the transcript of a tabletop game played over voice chat. The table has an AI assistant called Angel who answers rules questions. The transcriber sometimes writes her name as Angela, Angie or angle.
Decide whether the LAST line was said to Angel herself: someone asking her something or telling her something. A line right after Angel spoke that answers or reacts to what she said ("ha, good one", "thanks", "wait, even with a buckler?") was said to her even without her name. Only a line that is nothing but an acknowledgement ("okay", "thanks", "got it") needs no reply: to_angel false. A line that starts with one and then asks something ("Okay. Good. What about stacking?") is to_angel true. It was NOT said to her when "angel" is part of the game (an angel creature, an angelic character or heritage, a statue, a spell), when people talk about her without addressing her ("Angel was right earlier"), or when the word is just "angle" in its normal meaning.
Reply with JSON only, no other text:
{"to_angel": true or false, "complete": true or false, "stop": true or false, "chat": true or false, "question": "...", "ack": "..."}
- complete: false when they called her but haven't said the question yet ("Angel?", "Hey Angel, quick one..."); true otherwise.
- stop: true when they're telling her to stop talking or that they're done.
- chat: true when it's banter or small talk that needs no rules lookup ("you were listening", "how are you?"); false for a rules question.
- question: what they want from her in one sentence of at most 40 words, written to stand on its own using the earlier lines ("" when there's nothing yet). For a long question give the heart of it, don't copy it out.
- ack: for a rules question, what Angel says at once while she looks it up: three to ten spoken words in her voice (warm, quick, a little sassy), reacting to this question, different every time ("Ooh, grappling with a shield, bold. Checking.", "Stacking, my favourite headache. One moment."). "" for small talk or when it isn't for her.`;

/* Right after Angel answers someone, their next line is judged by a check that leans the other way: for her unless it's
   plainly for someone else (2026-11-14: the general check twice judged "Okay. What about stacking?" not for her). */
export const FOLLOWUP_SYSTEM = `You watch the transcript of a tabletop game played over voice chat. The table has an AI assistant called Angel who answers rules questions. She has JUST answered the person who said the LAST line.
Decide whether the LAST line is for Angel: a follow-up, a reaction, or another question for her. Lean to yes: people often follow up without saying her name ("Okay. What about stacking?", "And with a buckler?", "Can you access my notes?").
Say no only when the line is plainly for someone else (the table or another player: narration, "roll initiative", "your turn, Sam", a player's name) or is nothing but an acknowledgement ("okay", "thanks", "got it").
Reply with JSON only, no other text:
{"to_angel": true or false, "complete": true, "stop": true or false, "chat": true or false, "question": "...", "ack": "..."}
- stop: true when they're telling her to stop talking or that they're done.
- chat: true when it's banter or small talk that needs no rules lookup; false for a rules question.
- question: what they want from her in one sentence of at most 40 words, written to stand on its own using the earlier lines.
- ack: for a rules question, three to ten spoken words she says at once while she looks it up, in her voice (warm, quick, a little sassy), reacting to this question, different every time. "" for small talk.`;

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
        ack: typeof j.ack === "string" ? j.ack.trim().slice(0, 120) : "",
        question: typeof j.question === "string" ? j.question.trim() : "",
        fallback: false,
      };
    } catch { /* fall through */ }
  }
  const direct = new RegExp(String.raw`^\W*(?:hey|ok(?:ay)?|so|um+|uh+)?[\s,]*${NAME}(?![a-z'])[\s,!?:-]+\S`, "i").test(lastLineText);
  return { toAngel: direct, complete: true, stop: isStopRequest(lastLineText), chat: false, ack: "", question: direct ? lastLineText : "", fallback: true };
}

/* Ask the gate model. Returns the decision and what it cost. `lastText` is the line as the model sees it
   ("Mira: Angel, ..."); `bareText` is what was said, which the fallback rule reads (it looks for her name first). */
export async function gate({ claude, model, contextText, lastText, bareText = lastText, replying = false }) {
  try {
    /* the table is waiting on this check: it gets 8 seconds (a call that runs out of time is never sent again), and
       one more try after at most 1.5 s when it is refused as busy, not the 45 seconds and two tries of an answer;
       past that the plain rule decides */
    const json = await claude.create({
      model,
      max_tokens: 600,
      system: [{ type: "text", text: replying ? FOLLOWUP_SYSTEM : GATE_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: gateUser(contextText, lastText, replying) }],
    }, { timeoutMs: 8000, retries: 1, maxWaitMs: 1500 });
    const text = (json.content ?? []).filter(b => b.type === "text").map(b => b.text).join("");
    /* a reply cut off at the limit (a long question written back) has no JSON to read: the plain rule decides and the
       log says why; the call was still paid for */
    if (json.stop_reason === "max_tokens") return { ...parseGate("", bareText), error: "its reply was cut off", dollars: claude.cost(model, json.usage) };
    /* this call's own cost: a delta of the running total would be wrong while an answer runs at the same time */
    return { ...parseGate(text, bareText), dollars: claude.cost(model, json.usage) };
  } catch (e) {
    const decision = parseGate("", bareText);
    decision.error = e.message;
    return decision;
  }
}
