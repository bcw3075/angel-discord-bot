/* Answering a question: Claude (Sonnet by default) with the recent conversation, the house rules and two
   Archives of Nethys tools, finishing with an `answer` tool call that gives what to say and the pages used.
   The answer is written for the ear; the typed copy adds the links. */
import { AON_SITE } from "./aon.mjs";

export function systemPrompt({ houseRules = "", gmName = "" } = {}) {
  return `You are Angel, the rules helper at a Pathfinder Second Edition table that plays by the Remastered rules. You're in the group's Discord voice call. You hear the table through a live transcript that says who said what, and you speak when someone talks to you. Whatever you answer is spoken aloud to everyone and posted in the text channel too.

Who you are: warm, quick, and a little sassy now and then. You're on the table's side and you enjoy the game. You call it straight: if someone has a rule wrong, you tell them, kindly.

Getting the rule right:
- Look rules up with aon_search and aon_get before you answer. Don't trust memory for anything a lookup can settle: numbers, actions, traits, conditions, exact wording.
- These are the Remastered rules (Player Core, GM Core and the rest). The search already swaps old entries for their Remaster versions. If the table uses an old name (flat-footed, attack of opportunity), use the Remaster name and mention the old one once.
- The house rules below come before Archives of Nethys wherever they apply.
- Use the conversation: "this", "that" and "it" mean what the table was just talking about. If you truly can't tell what they mean, ask one short question instead of guessing.
- The GM${gmName ? ` (${gmName})` : ""} has the final say. When the rules are unclear or it's a judgment call, say what the rules say, give the usual reading, and say it's the GM's call. Never overrule the GM.
- If you can't find something, say so plainly. Never invent a rule.

How to say it, since it's spoken aloud:
- Talk the way a person at the table would: full sentences, no lists, no headings, no symbols, no links or page numbers.
- Explain it fully but tightly: what the rule says, how it applies to what's happening, and every number they need (actions, DCs, bonuses, durations). Usually three to eight sentences, fewer when it's simple.
- Everyone hears you, players included. Use only the rules, the house rules and what was said at the table.
- If it isn't a rules question (a joke, small talk, something you can't do), answer briefly and in character.

When you're done, call the answer tool once, with what to say and the Archives of Nethys pages you used.

House rules for this table:
${houseRules || "(none given)"}`;
}

export const TOOLS = [
  {
    name: "aon_search",
    description: "Search Archives of Nethys (Pathfinder 2e; Remastered entries first). Returns up to 6 entries: id, name, category, source, link, short summary. Use a short query: the name of the rule, action, condition, spell, feat or item, or a few key words.",
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
    description: "The full text of one Archives of Nethys entry, by the id or the link that aon_search gave.",
    input_schema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
  },
  {
    name: "answer",
    description: "Give your final answer. Call it once, at the end.",
    input_schema: {
      type: "object",
      properties: {
        say: { type: "string", description: "What Angel says aloud: plain spoken sentences, no links, lists or symbols." },
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

export function userMessage({ conversation, question, asker, via }) {
  return `What the table said in the last few minutes (oldest first):
${conversation || "(nothing yet)"}

${asker} ${via === "text" ? "typed" : "said"} to you: "${question}"`;
}

async function runTool(aon, use) {
  try {
    if (use.name === "aon_search") {
      const hits = await aon.search(use.input?.query ?? "", { category: use.input?.category || null });
      return hits.length ? JSON.stringify(hits) : "No entries found. Try other words, or no category.";
    }
    if (use.name === "aon_get") {
      const doc = await aon.get(use.input?.ref ?? "");
      return doc ? JSON.stringify(doc) : "No entry with that id or link.";
    }
    return `Unknown tool ${use.name}.`;
  } catch (e) {
    return `The lookup failed: ${e.message}. Answer from what you know if you're sure, and say you couldn't check.`;
  }
}

export async function answerQuestion({ claude, aon, model, maxTokens = 1500, system, conversation, question, asker, via = "voice", maxRounds = 6 }) {
  const messages = [{ role: "user", content: userMessage({ conversation, question, asker, via }) }];
  const fetched = [];
  let lookups = 0, dollars = 0;
  const done = (input, rounds) => {
    const say = String(input?.say ?? "").trim() || "Sorry, I lost my train of thought there. Could you ask me again?";
    let sources = (Array.isArray(input?.sources) ? input.sources : [])
      .filter(s => s && typeof s.url === "string" && s.url.startsWith(AON_SITE + "/"))
      .map(s => ({ name: String(s.name || "Archives of Nethys").slice(0, 80), url: s.url }));
    if (!sources.length) sources = fetched.slice(0, 3);
    const unique = [...new Map(sources.map(s => [s.url, s])).values()].slice(0, 5);
    return { say, sources: unique, rounds, lookups, dollars };
  };
  try {
    return await rounds();
  } catch (e) {
    /* the rounds that ran before the failure were paid for: the caller counts them */
    e.dollars = dollars;
    throw e;
  }

  async function rounds() {
    for (let round = 1; round <= maxRounds; round++) {
      const force = round === maxRounds;
      const res = await claude.create({
        model,
        max_tokens: maxTokens,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        ...(force ? { tool_choice: { type: "tool", name: "answer" } } : {}),
        messages,
      });
      dollars += claude.cost(model, res.usage);
      const content = res.content ?? [];
      const uses = content.filter(b => b.type === "tool_use");
      const final = uses.find(u => u.name === "answer");
      if (final) return done(final.input, round);
      if (!uses.length) {
        const text = content.filter(b => b.type === "text").map(b => b.text).join(" ").trim();
        return done({ say: text }, round);
      }
      messages.push({ role: "assistant", content });
      const results = [];
      for (const use of uses) {
        lookups++;
        const out = await runTool(aon, use);
        if (use.name === "aon_get") {
          try { const d = JSON.parse(out); if (d?.url) fetched.push({ name: d.name, url: d.url }); } catch { /* not a page */ }
        }
        results.push({ type: "tool_result", tool_use_id: use.id, content: out });
      }
      messages.push({ role: "user", content: results });
    }
    return done({}, maxRounds);
  }
}

/* A question as shown in the channel: at most 200 characters (a typed one can be 4,000). */
export function shortQuestion(q) {
  const t = String(q ?? "").replace(/\s+/g, " ").trim();
  return t.length > 200 ? t.slice(0, 197) + "…" : t;
}

/* The typed copy in the text channel: who asked, the answer, the pages. Kept under Discord's 2,000 characters. */
export function typedAnswer({ asker, question, say, sources = [] }) {
  const head = asker && question ? `**${asker} asked:** ${shortQuestion(question)}\n` : "";
  const links = sources.length ? `\n-# ${sources.map(s => `[${s.name.replace(/[[\]]/g, "")}](<${s.url}>)`).join(" · ")}` : "";
  const room = 1990 - head.length - links.length;
  const body = say.length > room ? say.slice(0, room - 1) + "…" : say;
  return head + body + links;
}
