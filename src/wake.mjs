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
/* the same with her name last and nothing else: "Never mind, Angel." (short round of 2026-11-21: said over her answer,
   it waited 5 s for the model check and she had finished by then) */
const STOP_TAIL = new RegExp(String.raw`${LEAD}(?:please[\s,]+)?${STOP_WORDS}(?:[\s,]+(?:please|now))?[\s,.!?-]+${NAME}[\s,.!?]*$`, "i");
/* a stop the transcriber misheard, the whole line and nothing after it (0.2.1; live round after 0.2.0, 2026-11-22):
   "Angel, stop" heard as "Angel's top", "Angel Angel's top" or "Top, Angel." Only as the whole line, since "Angel's top
   pick" or "the top, Angel" are something else */
const STOP_MISHEARD = new RegExp(String.raw`${LEAD}(?:(?:${NAME}[\s,.!?-]+)?${NAME}'?s[\s,.-]+top|top[\s,.!?-]+${NAME})[\s,.!?]*$`, "i");
const STOP_MAX_CHARS = 120;

export function mentionsAngel(text) {
  return NAME_RE.test(String(text));
}

/* "Angel, stop" and friends: acted on at once, without the model check. */
export function isStopRequest(text) {
  const t = String(text).trim();
  if (t.length > STOP_MAX_CHARS) return false;
  if (STOP_TAIL.test(t) || STOP_MISHEARD.test(t)) return true;
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
Decide whether the LAST line was said to Angel herself: someone asking her something or telling her something. A line right after Angel spoke that answers or reacts to what she said ("ha, good one", "thanks", "wait, even with a buckler?") was said to her even without her name. Only a line that is nothing but an acknowledgement ("okay", "thanks", "got it") needs no reply: to_angel false. A line that starts with one and then asks something ("Okay. Good. What about stacking?") is to_angel true. It was NOT said to her when "angel" is part of the game (an angel creature, an angelic character or heritage, a statue, a spell), when people talk about her without addressing her ("Angel was right earlier"), when they talk about her commands ("type slash angel join", "do /angel iam and your name": live 2026-11-16, "So slash angel space I m" woke her), or when the word is just "angle" in its normal meaning.
Reply with JSON only, no other text:
{"to_angel": true or false, "complete": true or false, "stop": true or false, "chat": true or false, "question": "...", "ack": "..."}
- complete: false when they called her but haven't said the question yet ("Angel?", "Hey Angel, quick one..."); true otherwise. A question of a word or two that names a rule is whole ("Angel, grapple?", "Angel, flanking?"): complete true.
- stop: true only when they plainly tell her to stop talking or that they don't want the answer any more ("stop", "that's enough", "never mind", "forget it"). A remark about being cut off, interrupted or misheard is not a stop ("cut me off there", "you cut me off", "hold on, I wasn't done", "that's not what I said"): stop false.
- chat: true when it's banter or small talk that needs no rules lookup ("you were listening", "how are you?"); false for a rules question.
- question: what they want from her in one sentence of at most 40 words, written to stand on its own using the earlier lines ("" when there's nothing yet). For a long question give the heart of it, don't copy it out. Write it as the question itself, the way they would ask it ("How does Grapple work?"), never as a report of it ("Rhea asks Angel how grapple works").
- ack: for a rules question, what Angel says at once while she looks it up: three to ten spoken words in her voice (warm, quick, a little sassy), reacting to this question, different every time ("Ooh, grappling with a shield, bold. Checking.", "Stacking, my favourite headache. One moment."). "" for small talk or when it isn't for her.`;

/* Right after Angel answers someone, their next line is judged by a check that leans the other way: for her unless it's
   plainly for someone else (2026-11-14: the general check twice judged "Okay. What about stacking?" not for her). */
export const FOLLOWUP_SYSTEM = `You watch the transcript of a tabletop game played over voice chat. The table has an AI assistant called Angel who answers rules questions. She has JUST answered the person who said the LAST line.
Decide whether the LAST line is for Angel: a follow-up, a reaction, or another question for her. Lean to yes: people often follow up without saying her name ("Okay. What about stacking?", "And with a buckler?", "Can you access my notes?").
Say no only when the line is plainly for someone else (the table or another player: narration, "roll initiative", "your turn, Sam", a player's name) or is nothing but an acknowledgement ("okay", "thanks", "got it").
Reply with JSON only, no other text:
{"to_angel": true or false, "complete": true or false, "stop": true or false, "chat": true or false, "question": "...", "ack": "..."}
- complete: false only when they announce a question without asking it yet ("Okay. So first question.", "One more thing.", "Oh, and another one"); true otherwise, even for a question that trails off ("Oh, and are there any differences"). (Live 2026-11-15: "Oh, that's funny. Okay. So first question." was answered as small talk while Rhea was already asking.)
- stop: true only when they plainly tell her to stop talking or that they don't want the answer any more ("stop", "that's enough", "never mind", "forget it"). A remark about being cut off, interrupted or misheard is not a stop ("cut me off there", "you cut me off", "hold on, I wasn't done", "that's not what I said"): stop false.
- chat: true when it's banter or small talk that needs no rules lookup; false for a rules question.
- question: what they want from her in one sentence of at most 40 words, written to stand on its own using the earlier lines. Write it as the question itself, the way they would ask it ("Does that stack with cover?"), never as a report of it ("Asks whether it stacks").
- ack: for a rules question, three to ten spoken words she says at once while she looks it up, in her voice (warm, quick, a little sassy), reacting to this question, different every time. "" for small talk.`;

export function gateUser(contextLines, last, replying = false) {
  const note = replying ? "\n\n(Angel has just answered this person; a follow-up without her name is usually for her.)" : "";
  return `Earlier lines:\n${contextLines || "(none)"}\n\nLAST line:\n${last}${note}`;
}

/* The model's reply → a decision. When it can't be read, fall back to the plain rule: her name first, then a request. */
export function parseGate(text, lastLineText = "") {
  lastLineText = String(lastLineText).slice(0, 300); /* the plain rule only needs the start of the line */
  /* the whole {...} span first; if words with braces follow it, the first object alone (as `holdJson`; review 19) */
  for (const [i, re] of [/\{[\s\S]*\}/, /\{[^{}]*\}/].entries()) {
    const m = String(text).match(re);
    if (!m) continue;
    try {
      const j = JSON.parse(m[0]);
      if (i > 0 && typeof j.to_angel !== "boolean") continue; /* the second pass only for a real verdict */
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

/* the start of a reply that couldn't be used, for the self-test report: one line, short */
export const replyStart = text => String(text).replace(/\s+/g, " ").trim().slice(0, 160);

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
    /* a reply cut off at the limit: a whole verdict written before the cut is still used (marked, so the log shows it),
       unless a second one began after it (it changed its mind); otherwise the plain rule decides and the log says
       why (Test Angel.cmd, 2026-11-16: "Hold on, I wasn't done." ran past 600 tokens). The call was still paid for.
       `replyStart` is for the self-test report only: the session's log keeps verdicts, never words. */
    if (json.stop_reason === "max_tokens") {
      const d = parseGate(text, bareText);
      if (!d.fallback && (String(text).match(/"to_angel"/g)?.length ?? 0) === 1) return { ...d, cutOff: true, dollars: claude.cost(model, json.usage) };
      return { ...parseGate("", bareText), error: "its reply was cut off", replyStart: replyStart(text), dollars: claude.cost(model, json.usage) };
    }
    /* this call's own cost: a delta of the running total would be wrong while an answer runs at the same time */
    return { ...parseGate(text, bareText), dollars: claude.cost(model, json.usage) };
  } catch (e) {
    const decision = parseGate("", bareText);
    decision.error = e.message;
    return decision;
  }
}

/* While Angel holds an answer at a busy table (Rhea, 2026-11-15, design d-7): what a line said meanwhile means for her.
   Only lines said while she waits are checked, so it costs a fraction of a cent. */
export const HOLD_SYSTEM = `You watch the transcript of a tabletop game played over voice chat. The table has an AI assistant called Angel who answers rules questions. The transcriber sometimes writes her name as Angela, Angie or angle. Angel is looking up the answer to a question, or has it ready and is waiting for a chance to say it while people talk (she may already have said, briefly, that she is ready).
Decide what the LAST line means for her. Reply with JSON only, no other text:
{"kind": "go" or "wait" or "stop" or "ask" or "none", "chat": true or false, "complete": true or false, "adds": true or false, "question": "..."}
- go: someone invites her to speak now ("go ahead", "yeah?", "what'd you find?", "okay Angel", "sure, let's hear it", her name on its own).
- wait: someone asks her to hold off for now but still wants the answer ("hold on", "not now", "one sec, Angel", "after this", "in a minute").
- stop: they don't want the answer any more ("never mind", "forget it", "stop", "we sorted it out", "don't worry about it").
- ask: a new question for Angel, or more added to the question she is holding ("oh, and with a shield?", "Angel, what about flanking?"). Use the earlier lines to tell.
- none: anything else: the table talking among themselves, the game, narration, or talk about Angel that isn't to her. "angel" can be part of the game (an angel creature, an angelic heritage, a statue).
- chat: for "ask", true when it is small talk that needs no rules lookup; false otherwise.
- complete: for "ask", false when the line only starts a question that is still to come ("Angel, about the grab,", "Hey Angel, quick one"); true otherwise.
- adds: for "go", true when the same line also finishes or adds to the question she is holding before inviting her ("...and can I go back to it after? Okay, now you can speak."); false otherwise.
- question: for "ask", and for "go" with adds true, what they want from her in one sentence of at most 40 words, written to stand on its own using the earlier lines, as the question itself ("Does that work with a shield?"); "" otherwise.
- Her name with only words that announce a question still to come ("Hey Angel, quick one", "Angel, quick question", "Angel, got a sec?") is "ask" with complete false, not "go".
Reply with the JSON object alone, on one line, and nothing after it.`;

export function holdUser(contextLines, last, { asker = "someone", question = "", cutIn = "", ready = true } = {}) {
  const note = `\n\n(Angel is ${ready ? "holding her answer to" : "looking up the answer to"} ${asker}'s question${question ? `: "${String(question).slice(0, 200)}"` : ""}.${cutIn ? ` She said: "${cutIn}"` : ""})`;
  return `Earlier lines:\n${contextLines || "(none)"}\n\nLAST line:\n${last}${note}`;
}

const HOLD_KINDS = new Set(["go", "wait", "stop", "ask", "none"]);
/* a plain alternation of fixed words: no backtracking on what the table says */
const HOLD_WORDS = /\b(?:hold on|hang on|wait|not now|not yet|one sec|one second|a sec|a second|in a minute|after this)\b/i;

/* the reply's JSON object: the whole span first; if words with braces follow it, the first object alone */
function holdJson(text) {
  const s = String(text);
  for (const re of [/\{[\s\S]*\}/, /\{[^{}]*\}/]) {
    const m = s.match(re);
    if (!m) continue;
    try {
      const j = JSON.parse(m[0]);
      if (HOLD_KINDS.has(j.kind)) return j;
    } catch { /* try the next */ }
  }
  return null;
}

/* her name with only words that announce a question ("Hey Angel, quick one.", "Angel, got a sec?"): the start of a
   question, the rest to come (0.1.3 self-test: the check's reply was cut off on "Hey Angel, quick one." and the plain
   rule called it a go-ahead). The whole rest of the line must be one of these, so "hold on Angel, quick question"
   stays a wait. A fixed, anchored alternation: no backtracking on what the table says. */
/* review of the fix (2026-11-16): "I've" is one word, "for you" can follow, "alright"/"sorry" can lead */
const CALL_ONLY = /^(?:(?:(?:a |one )?quick (?:one|question|thing)|real quick|(?:a |one )?question|(?:i|i've) (?:have |got )?(?:a|one more|another) (?:quick )?question|(?:do |have )?(?:you )?(?:have |got )?a (?:sec|second|minute|moment)|(?:can|could) i ask (?:you )?(?:something|a question)|one more(?: question| thing)?|another (?:one|question))(?: for you)?)$/;
const CALL_FILLER = /^(?:hey|hi|ok|okay|so|um+|uh+|oh|yo|alright|sorry|right)$/;
function callOnly(t) {
  const words = (t.toLowerCase().replace(new RegExp(String.raw`(?<![a-z'])${NAME}(?![a-z])`, "g"), " ").match(/[a-z0-9']+/g) ?? []).filter(w => !CALL_FILLER.test(w));
  return words.length > 0 && CALL_ONLY.test(words.join(" "));
}

/* The model's reply → { kind, chat, complete, question }. When it can't be read, the plain rule: a stop phrase stops
   her, a line not to her is nothing, a bare call is the start of a question, a hold-on is a wait, her name and little
   else is a go-ahead, her name with a question is a question. */
export function parseHold(text, lastLineText = "") {
  const j = holdJson(text);
  if (j) return { kind: j.kind, chat: j.chat === true, complete: j.complete !== false, adds: j.kind === "go" && j.adds === true, question: typeof j.question === "string" ? j.question.trim() : "", fallback: false };
  const t = String(lastLineText).slice(0, 300);
  if (isStopRequest(t)) return { kind: "stop", chat: false, complete: true, question: "", fallback: true };
  if (!mentionsAngel(t)) return { kind: "none", chat: false, complete: true, question: "", fallback: true };
  if (callOnly(t)) return { kind: "ask", chat: false, complete: false, question: "", fallback: true };
  /* review of 0.1.3: "Hold on Angel." was read as a go-ahead and "Angel?" as a question */
  if (HOLD_WORDS.test(t)) return { kind: "wait", chat: false, complete: true, question: "", fallback: true };
  /* her name and little else ("Angel?", "Okay Angel, go") invites her; her name with a question is a question */
  const words = (t.replace(new RegExp(NAME, "gi"), " ").match(/[a-z0-9']+/gi) ?? []).filter(w => !/^(hey|ok|okay|so|um+|uh+|oh|yeah|yes|sure|go|ahead|right)$/i.test(w));
  if (words.length <= 1 || !/\?/.test(t)) return { kind: "go", chat: false, complete: true, question: "", fallback: true };
  return { kind: "ask", chat: false, complete: true, question: t, fallback: true };
}

export async function holdCheck({ claude, model, contextText, lastText, bareText = lastText, asker, question, cutIn, ready = true }) {
  try {
    const json = await claude.create({
      model,
      max_tokens: 600,
      system: [{ type: "text", text: HOLD_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: holdUser(contextText, lastText, { asker, question, cutIn, ready }) }],
    }, { timeoutMs: 8000, retries: 1, maxWaitMs: 1500 });
    const text = (json.content ?? []).filter(b => b.type === "text").map(b => b.text).join("");
    /* cut off at the limit: a whole verdict written before it still counts (words after the JSON ran on), a broken one not */
    if (json.stop_reason === "max_tokens") {
      /* a second "kind" after the first means it changed its mind before the cut: not trusted */
      const kinds = String(text).match(/"kind"/g)?.length ?? 0;
      if (!holdJson(text) || kinds > 1) return { ...parseHold("", bareText), error: "its reply was cut off", replyStart: replyStart(text), dollars: claude.cost(model, json.usage) };
      return { ...parseHold(text, bareText), cutOff: true, dollars: claude.cost(model, json.usage) };
    }
    return { ...parseHold(text, bareText), dollars: claude.cost(model, json.usage) };
  } catch (e) {
    return { ...parseHold("", bareText), error: e.message };
  }
}

/* Her "I'm ready" when the table is busy: her own few words each time, never a stock line (Rhea, 2026-11-15: "please
   try not scripting things like this so it's always the same thing"). Written only when she needs to cut in. */
export const READY_SYSTEM = `You write one short spoken line for Angel, an AI assistant at a tabletop game played over voice chat. She has the answer to a rules question ready, but people at the table are still talking. Write the few words she says to cut in politely and let them know she has it, so they can give her the floor when they're ready: 2 to 8 words, in her voice (warm, quick, a little sassy), fitting the question. Never the answer itself, never a question about the rules. Make it different from any earlier ones you are shown. Reply with only the words she says.`;

export function cleanReady(text) {
  const t = String(text).replace(/\s+/g, " ").trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  if (!t || t.length > 90 || t.split(" ").length > 12) return "";
  return t;
}

export async function readyLine({ claude, model, question, asker, earlier = [] }) {
  const json = await claude.create({
    model,
    max_tokens: 60,
    system: READY_SYSTEM,
    messages: [{ role: "user", content: `${asker}'s question: ${String(question).slice(0, 300)}${earlier.length ? `\n\nHer earlier ones (say something else): ${earlier.map(e => `"${e}"`).join(", ")}` : ""}` }],
  }, { timeoutMs: 6000, retries: 0 });
  const text = cleanReady((json.content ?? []).filter(b => b.type === "text").map(b => b.text).join(""));
  return { text, dollars: claude.cost(model, json.usage) };
}
