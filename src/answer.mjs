/* Answering a question: Claude (Sonnet by default) with the recent conversation, the house rules and two
   Archives of Nethys tools, finishing with an `answer` tool call that gives what to say and the pages used.
   The answer is written for the ear; the typed copy adds the links. Each round is read as Claude writes it, so what
   she will say (`say`, written first) can be spoken while the rest of the answer is still being written. */
import { AON_SITE } from "./aon.mjs";
import { FieldReader } from "./claude.mjs";

export function systemPrompt({ houseRules = "", gmName = "" } = {}) {
  return `You are Angel, the rules helper at a Pathfinder Second Edition table that plays by the Remastered rules. You're in the group's Discord voice call. You hear the table through a live transcript that says who said what, and you speak when someone talks to you. Your answer has two parts: a short spoken one everyone hears, and a fuller written one posted in the text channel.

Who you are: warm, quick, and a little sassy now and then. You're on the table's side and you enjoy the game. You call it straight: if someone has a rule wrong, you tell them, kindly.

Getting the rule right:
- Look rules up with aon_search and aon_get before you answer. A search gives the full text of its top entries, so you often need no aon_get (use aon_get when an entry you need came without text); when you need more than one thing, ask for them all in the same turn (several searches or pages at once run together), because every extra turn of looking up keeps the table waiting.
- Don't keep searching for something the rules don't say. If two turns of looking up haven't found it, stop: give what the entries do say, say plainly that they don't settle the rest, and offer the usual reading as the usual reading. A long hunt keeps the whole table waiting (a live question, 2026-11-14, took eight lookups and fifteen seconds to reach "the entry doesn't spell that out").
- Read the entry before you rely on it: check its name and source are the rule they mean (several entries can share a name; one marked older or legacy is an earlier printing that has been replaced, so use the newest unless they ask about the old rule; one marked preRemaster is from before the Remaster and is the rule only if nothing newer replaced it, often under a new name), and if an entry's text is marked truncated and the part you need isn't there, get the whole entry with aon_get.
- Don't trust memory for anything a lookup can settle: numbers, actions, traits, conditions, exact wording.
- These are the Remastered rules (Player Core, GM Core and the rest). The search already swaps old entries for their Remaster versions. If the table uses an old name (flat-footed, attack of opportunity), use the Remaster name and mention the old one once.
- The house rules below come before Archives of Nethys wherever they apply.
- Use the conversation: "this", "that" and "it" mean what the table was just talking about. If you truly can't tell what they mean, ask one short question instead of guessing.
- The GM${gmName ? ` (${gmName})` : ""} has the final say. When the rules are unclear or it's a judgment call, say what the rules say, give the usual reading, and say it's the GM's call. Never overrule the GM.
- If you can't find something, say so plainly. Never invent a rule.
- For rules facts, say only what you can point to: the entries you looked up, the house rules below, or what was already said or written at this table. Don't add examples, feat or spell names, or neighbouring rules from memory to round an answer out (the first real test run, 2026-11-14, had three such extras and all three were wrong): look one up first, or leave it out. A short answer that is all true beats a fuller one with a guess in it. This doesn't limit small talk, house-rule answers, or giving the usual reading on a judgment call: call that the usual reading, not rules text.

What to say aloud (the GM asked for short spoken answers and doesn't mind a little back and forth, 2026-11-14):
- Talk the way a person at the table would: full sentences, no lists, no headings, no symbols, no links or page numbers.
- Keep it short: the answer and the one or two numbers they need right now, in one to three short sentences. Then stop. If there's more that matters (an exception, a judgment call for the GM), say so in a few words, like "there's a buckler exception, ask if you want it", and let them ask.

What to write (posted in Discord, read at a glance mid-game; the GM asked for formatting instead of a wall of text, 2026-11-14):
- Start with the answer itself in bold, one short line (for example **-2 circumstance penalty to AC.**).
- Then two to five short bullet points ("- ") for what matters: how it applies here, the exceptions, and every number they need (actions, DCs, bonuses, durations). Bold the key terms and numbers.
- If it's a judgment call, end with one line: *GM's call:* and what to decide.
- Use Discord markdown only (bold, italics, "- " bullets). No headings, tables or links (the pages are added for you). Keep it under about 600 characters.
- Everyone hears you, players included. Use only the rules, the house rules and what was said at the table.
- If it isn't a rules question (a joke, small talk, something you can't do), answer briefly and in character.

When you're done, call the answer tool once, with what to say, what to write, and the Archives of Nethys pages you used. Always write say first: you start speaking it while you're still writing the rest.

House rules for this table:
${houseRules || "(none given)"}`;
}

export const TOOLS = [
  {
    name: "aon_search",
    description: "Search Archives of Nethys (Pathfinder 2e; Remastered entries first). Returns up to 6 entries: id, name, category, source, year released, link, short summary (oldName is the name the entry had before the Remaster); the top three also come with their full text (text), so you don't need aon_get for those unless the text is marked truncated. Use a short query: the name of the rule, action, condition, spell, feat or item, or a few key words. You can call it several times in one turn.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        category: { type: "string", description: "Optional filter: action, condition, spell, feat, rules, trait, equipment, weapon, armor, shield, creature, class, class-feature, ancestry, heritage, archetype, skill, deity, ritual, hazard" },
      },
      required: ["query"],
    },
  },
  {
    name: "aon_get",
    description: "The full text of one Archives of Nethys entry, by the id or the link that aon_search gave. For an entry whose text the search didn't give, or gave truncated. You can call it several times in one turn.",
    input_schema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
  },
  {
    name: "answer",
    description: "Give your final answer. Call it once, at the end. Write say first, then details, then sources.",
    /* her input arrives as she writes it instead of a whole value at a time, so `say` can be spoken sentence by sentence */
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        say: { type: "string", description: "What Angel says aloud: one to three short spoken sentences, no links, lists or symbols." },
        details: { type: "string", description: "The written answer for Discord: a bold one-line answer, then two to five short '- ' bullets, no links." },
        sources: {
          type: "array",
          description: "The Archives of Nethys pages the answer rests on, with the links the tools gave.",
          items: { type: "object", properties: { name: { type: "string" }, url: { type: "string" } }, required: ["name", "url"] },
        },
      },
      required: ["say"],
    },
  },
];

/* `meaning` is the check's quick reading of a spoken question (a small model's paraphrase): a hint, never the quote */
export function userMessage({ conversation, question, asker, via, meaning = "" }) {
  const hint = meaning && meaning !== question
    ? `\n(Their words come from a speech transcriber and can be garbled. A quick first reading of what they want: "${meaning}". Go by their own words and the conversation where that reading differs.)` : "";
  return `What the table said in the last few minutes (oldest first):
${conversation || "(nothing yet)"}

${asker} ${via === "text" ? "typed" : "said"} to you: "${question}"${hint}`;
}

/* A lookup that fails is tried once more at once (a dropped connection is the usual cause); if it fails again
   Claude is told, and the failure is counted so the post can say the answer couldn't be fully checked. */
async function runTool(aon, use, failed, seen, looked) {
  const fail = e => {
    failed.count++;
    /* in the log too, so an answer slowed by failing lookups can be explained (review 7) */
    looked.push(`${use.name === "aon_get" ? "page" : "search"} "${String(use.input?.query ?? use.input?.ref ?? "").slice(0, 60)}": failed (${String(e?.message ?? e).slice(0, 80)})`);
    return `The lookup failed: ${e.message}. Answer from what you know only if you're sure, and say plainly that you couldn't check Archives of Nethys.`;
  };
  try { return await lookUp(aon, use, seen, looked); }
  catch (first) {
    /* one that ran out of time is not tried again: the table has already waited for it */
    if (first?.name === "TimeoutError") return fail(first);
    try { return await lookUp(aon, use, seen, looked); }
    catch (e) { return fail(e); }
  }
}

async function lookUp(aon, use, seen, looked) {
  if (use.name === "aon_search") {
    const hits = await aon.search(use.input?.query ?? "", { category: use.input?.category || null, withText: 3 });
    for (const h of hits) if (h.url) seen.add(h.url);
    looked.push(`search "${String(use.input?.query ?? "").slice(0, 60)}"${use.input?.category ? ` [${use.input.category}]` : ""}: ${hits.slice(0, 3).map(h => h.name).join(", ") || "nothing"}`);
    return hits.length ? JSON.stringify(hits) : "No entries found. Try other words, or no category.";
  }
  if (use.name === "aon_get") {
    const doc = await aon.get(use.input?.ref ?? "");
    if (doc?.url) seen.add(doc.url);
    looked.push(`page "${String(use.input?.ref ?? "").slice(0, 60)}": ${doc?.name ?? "nothing"}`);
    return doc ? JSON.stringify(doc) : "No entry with that id or link.";
  }
  return `Unknown tool ${use.name}.`;
}

/* onSay(text) is given each new piece of `say` as it is written, and onSay("", { end: true }) once when `say` is
   whole, which is before the rest of the answer is (only with a Claude client that can stream) */
export async function answerQuestion({ claude, aon, model, maxTokens = 1500, system, conversation, question, asker, via = "voice", maxRounds = 6, cacheTtl = "5m", onSay = null, meaning = "" }) {
  const cacheControl = cacheTtl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
  const messages = [{ role: "user", content: userMessage({ conversation, question, asker, via, meaning }) }];
  const fetched = [];
  const failed = { count: 0 };
  const seen = new Set(); /* the page links the lookups gave: only those can be posted as sources */
  const looked = [];      /* what was looked up and what came back, for the log: a slow answer can be explained */
  let lookups = 0, dollars = 0;
  const cache = { written: 0, read: 0 };
  const done = (input, rounds) => {
    const say = String(input?.say ?? "").trim() || "Sorry, I lost my train of thought there. Could you ask me again?";
    const details = String(input?.details ?? "").trim() || say;
    let sources = (Array.isArray(input?.sources) ? input.sources : [])
      .filter(s => s && typeof s.url === "string" && s.url.startsWith(AON_SITE + "/") && seen.has(s.url))
      .map(s => ({ name: String(s.name || "Archives of Nethys").slice(0, 80), url: s.url }));
    if (!sources.length) sources = fetched.slice(0, 3);
    const unique = [...new Map(sources.map(s => [s.url, s])).values()].slice(0, 5);
    return { say, details, sources: unique, rounds, lookups, failedLookups: failed.count, dollars, cache, fellBack, looked };
  };
  let spoke = false;    /* some of `say` has been passed on (and may already be heard) */
  let roomy = false;    /* this round is being asked again with twice the room, after a reply cut off at its limit */
  let fellBack = "";    /* why the answer was worked out again the plain way, if it was */
  const saySafe = !onSay ? null : (text, opts) => { if (text) spoke = true; onSay(text, opts); };
  try {
    return await rounds(!!claude.stream);
  } catch (e) {
    /* the rounds that ran before the failure were paid for, and so was what is known of one that broke off */
    if (e.usage) dollars += claude.cost(model, e.usage);
    /* A reply read as it is written is put back together here, and Claude refuses a later round when a piece of it
       came back wrong (live 2026-11-14: a thinking block). If that happens before she has said anything, the
       question is worked out once more the plain way, where Claude's replies go back exactly as they came. */
    if (claude.stream && !spoke && /^Claude answered 400/.test(e.message)) {
      fellBack = e.message;
      messages.length = 1; fetched.length = 0; lookups = 0; failed.count = 0; seen.clear(); looked.length = 0; roomy = false;
      try { return await rounds(false); }
      catch (again) { if (again.usage) dollars += claude.cost(model, again.usage); again.dollars = dollars; throw again; }
    }
    e.dollars = dollars;
    throw e;
  }

  async function rounds(streamed) {
    /* The last round says "answer now" instead of forcing the answer tool: Sonnet 5.5 refuses a forced tool_choice
       ("type tool and any are not supported for this model", live 2026-11-14 on a long question). The tools stay
       the same in every round: Claude accepts her earlier thinking back only while what came before it is unchanged
       (the thinking docs, read 2026-11-14), and the same tools keep the cached prompt in use. If she asks for
       another lookup anyway it isn't run, she is told so, and she gets one more round to answer. */
    for (let round = 1; round <= maxRounds + 1; round++) {
      const last = round >= maxRounds;
      if (round === maxRounds && round > 1 && !roomy) {
        const tail = messages.at(-1);
        if (Array.isArray(tail?.content)) tail.content.push({ type: "text", text: "That's all the looking up there's time for: give your answer now with the answer tool." });
      }
      const body = {
        model,
        max_tokens: roomy ? maxTokens * 2 : maxTokens,
        system: [{ type: "text", text: system, cache_control: cacheControl }],
        tools: TOOLS,
        messages,
      };
      /* what the answer tool's `say` holds so far, per tool call, read out of its unfinished JSON */
      const saying = new Map();
      const res = !streamed ? await claude.create(body) : await claude.stream(body, {
        onDelta: ({ index, block, delta }) => {
          if (block.type !== "tool_use" || block.name !== "answer" || delta.type !== "input_json_delta") return;
          let reader = saying.get(index);
          if (!reader && saying.size) return; /* one answer is spoken: a second answer call in the same reply is not */
          if (!reader) saying.set(index, reader = new FieldReader("say"));
          const wasDone = reader.done;
          const fresh = reader.feed(delta.partial_json);
          if (fresh && saySafe) saySafe(fresh);
          if (reader.done && !wasDone && saySafe) saySafe("", { end: true });
        },
      });
      dollars += claude.cost(model, res.usage);
      cache.written += res.usage?.cache_creation_input_tokens ?? 0;
      cache.read += res.usage?.cache_read_input_tokens ?? 0;
      const content = res.content ?? [];
      const uses = content.filter(b => b.type === "tool_use");
      const final = uses.find(u => u.name === "answer");
      /* A reply cut off at its limit (her thinking counts toward it) is not a reply: a lookup cut mid-way would be
         run with nothing in it and its results read as what she asked for. Unless what she says had already come
         through whole, the round is asked once more with twice the room; nothing of a cut reply is kept. */
      const cut = res.stop_reason === "max_tokens";
      /* whole only when its closing quote was seen as it was written; a cut plain reply is never taken as whole */
      const sayWhole = !!final && streamed && [...saying.values()][0]?.done === true;
      if (cut && !sayWhole && !spoke && !roomy) { roomy = true; round--; continue; }
      roomy = false;
      /* cut again, or cut after she had begun to speak (she can't be asked again: she would say it twice): what she
         had said so far is all there is, and the result says it was cut, so she and the post can say so */
      if (cut && !sayWhole) {
        const heard = [...saying.values()][0]?.text ?? "";
        return spoke && heard.trim() ? { ...done({ say: heard }, round), cut: true } : done({}, round);
      }
      if (final) {
        /* an answer cut short (out of tokens, or JSON that doesn't parse) still has what she was saying; the
           result says what is missing, so she and the post can say so and it isn't kept as her answer */
        const reader = [...saying.values()][0];
        const heard = reader?.text ?? "";
        const broken = (res.brokenBlocks ?? []).includes(final);
        const out = done(String(final.input?.say ?? "").trim() ? final.input : { ...final.input, say: heard }, round);
        if (broken && reader && !reader.done && heard.trim()) return { ...out, cut: true };
        return broken || cut ? { ...out, detailsLost: true } : out;
      }
      if (!uses.length) {
        const text = content.filter(b => b.type === "text").map(b => b.text).join(" ").trim();
        return done({ say: text }, round);
      }
      /* cut after a whole answer's worth of talk but with no answer call (her thinking or a lookup ran out of room) */
      if (cut && !final) return done({}, round);
      messages.push({ role: "assistant", content });
      if (last) {
        messages.push({ role: "user", content: uses.map(use => ({ type: "tool_result", tool_use_id: use.id, content: "Not looked up: there's no more time for looking up. Give your answer now with the answer tool, from what you have, and say what you couldn't check." })) });
        continue;
      }
      /* lookups asked for in the same turn run together; the results go back in the order asked */
      lookups += uses.length;
      /* a request whose JSON didn't come through whole is never run (it would be a search for nothing): she is told */
      const garbled = new Set(res.brokenBlocks ?? []);
      lookups -= uses.filter(u => garbled.has(u)).length;
      const outs = await Promise.all(uses.map(use => (garbled.has(use) ? "That request came through garbled and was not run. Ask for it again." : runTool(aon, use, failed, seen, looked))));
      const results = uses.map((use, i) => {
        if (use.name === "aon_get") {
          try { const d = JSON.parse(outs[i]); if (d?.url) fetched.push({ name: d.name, url: d.url }); } catch { /* not a page */ }
        }
        return { type: "tool_result", tool_use_id: use.id, content: outs[i] };
      });
      messages.push({ role: "user", content: results });
    }
    return done({}, maxRounds + 1);
  }
}

/* A question as shown in the channel: at most 200 characters (a typed one can be 4,000). */
export function shortQuestion(q) {
  const t = String(q ?? "").replace(/\s+/g, " ").trim();
  return t.length > 200 ? t.slice(0, 197) + "…" : t;
}

/* The typed copy in the text channel: who asked, the answer, the pages. Kept under Discord's 2,000 characters. */
export function typedAnswer({ asker, question, say, sources = [], unchecked = false }) {
  const head = asker && question ? `**${asker} asked:** ${shortQuestion(question)}\n` : "";
  /* a lookup failed even at the second try: the table is told this answer wasn't fully checked against the rules */
  const warn = unchecked ? "\n-# ⚠️ I couldn't reach Archives of Nethys for part of this, so check it before you rely on it." : "";
  const links = warn + (sources.length ? `\n-# ${sources.map(s => `[${s.name.replace(/[[\]]/g, "")}](<${s.url}>)`).join(" · ")}` : "");
  const room = 1990 - head.length - links.length;
  const body = say.length > room ? say.slice(0, room - 1) + "…" : say;
  return head + body + links;
}
