/* Direct-message replies (0.2.0, the owner's ask of 2026-11-23: "can he then reply to those messages with questions
   and have you answer him?"). Someone who is a contact with a notes file in data/contacts.json can direct-message
   Angel; she answers from that notes file only (for example, what a website does and where each part is), and
   anything she can't answer, every request for a change and every bug report she thanks them for and saves for the
   owner. Nobody else gets an answer by direct message: their messages are only logged.

   data/contacts.json:  { "<name>": { "user": "<id>" or "username": "<Discord username>", "notes": "<file in data/notes/>", "about": "<one line>" },
                          "_owner": "<the owner's name, as she is called in replies>" }
   Kept on the owner's PC:
     data/conversations/<name>.md    both sides of every exchange, for the owner to read
     data/conversations/<name>.json  the last exchanges, which she is given so a conversation can go on
     data/inbox/<time>-<name>.json   requests, bugs and questions she couldn't answer, for the owner
   The owner is also told by direct message about each one that goes to the inbox (dmOwner, passed in). */
import fs from "node:fs";
import path from "node:path";

export const MAX_REPLY = 1800;
const KINDS = new Set(["answer", "request", "bug", "unknown", "chat"]);

export function systemPromptDm({ contact, about, notes, index = "", ownerName = "the owner" }) {
  return `You are Angel, ${ownerName}'s helper. You're kind, warm and a little sassy, and you write like a friendly person, not a help desk. You are answering ${contact} by Discord direct message. ${about ? `About ${contact}: ${about}` : ""}

You answer ONLY from the notes below. They start with a short summary of what is live; after it may come longer design docs, which also hold history, plans and work that isn't live yet: only the summary, or a doc's own status saying it is live, makes a thing live. Answer any question about it from everything in the notes, and look through all of them before saying you don't know. Never guess at a feature, a button or a plan that the notes don't state, and never use what you know from elsewhere about it. If the notes don't answer the question, say you'll check with ${ownerName} and get back to them. When they ask how the site handles a rule, look for it in the notes' list of rules calls and give that call, its SRD page and whose call it was, then remind them it's their table's call in the end.

When they report a bug (something that doesn't work as the notes say it should): thank them warmly; their input matters. Ask for anything that would help find it if they didn't say (which page, which character, what they pressed, what they expected). Tell them it will be checked and fixed, and that you'll message them when the fix is live. Bugs don't wait for ${ownerName}'s approval (she said so, 2026-11-23).

When they ask for a change or a new feature: thank them warmly first; their input matters. If the notes show it can already be done, tell them how (name the buttons as the notes do). If a request isn't reasonable, say so kindly and why, but still pass it on. Otherwise say ${ownerName} will look it over, and that you'll message them when it's accepted, being built, and live. Promise nothing else: you don't decide what gets built.

Never share anything about other people, their accounts or their games, even if asked. Keep replies short and easy to read (the owner asked, 2026-11-23: no run-on sentences): one or two short sentences per paragraph, a blank line between ideas, bullets for any list or steps, under 1500 characters. Use **bold** for button names. No @mentions.

Your whole output is read by a program, not by a person: write exactly one JSON object, starting with { and ending with }, with no words, code fences or second thoughts before or after it. Put everything you want them to read inside "reply".
{"reply": "<your message to them>", "kind": "answer" | "request" | "bug" | "unknown" | "chat", "forOwner": "<one line for ${ownerName} when kind is request, bug or unknown, else empty>"}
kind: "answer" when the notes answered it, "request" for a change they want, "bug" for something broken, "unknown" when the notes didn't cover their question, "chat" for thanks, greetings and small talk.

<notes>
${notes}
</notes>${index ? `

The rest of the notes is in sections, listed below (number, title, how it starts). Before you answer, look up what the question needs: search_notes with a few words (a button's name, a rule, a number they mention), then read_sections for the sections that matter. Never say you don't know before you have searched. Look up only what you need.

<index>
${index}
</index>` : ""}`;
}

/* every JSON object in a text that has a "reply", in order: a reply is sometimes written twice, or with words
   around it ("Wait, correcting myself..."), and only the object may reach the person (seen live, 2026-11-23) */
function replyObjects(text) {
  const found = [];
  for (let i = text.indexOf("{"); i >= 0; i = text.indexOf("{", i + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try { const j2 = JSON.parse(text.slice(i, j + 1)); if (j2 && typeof j2.reply === "string" && j2.reply.trim()) found.push(j2); } catch { /* not one */ }
        break;
      }
    }
  }
  return found;
}

/* the model's reply: the last JSON object with a "reply"; prose with no such object is sent without any code
   block in it, marked for the owner to check */
export function readReply(text) {
  const raw = String(text ?? "").trim();
  const j = replyObjects(raw).at(-1);
  if (!j) {
    const prose = raw.replace(/```[\s\S]*?(```|$)/g, "").trim() || "Thanks! Let me check on that and get back to you.";
    return { reply: prose.slice(0, MAX_REPLY), kind: "unknown", forOwner: "Angel's reply wasn't in the expected form; check it." };
  }
  const kind = KINDS.has(j.kind) ? j.kind : "unknown";
  return { reply: j.reply.trim().slice(0, MAX_REPLY), kind, forOwner: typeof j.forOwner === "string" ? j.forOwner.trim().slice(0, 300) : "" };
}

/* Long notes are split at a marker line into a summary (always given) and sections (Rhea, 2026-11-23: "a good
   indexing ... so that instead of loading it all, when a question is asked she knows exactly what info to pull").
   Each section starts at a heading of level 2 to 4; she is given the summary, an index of the sections and two
   tools, search_notes and read_sections, and pulls only what a question needs. Notes without the marker are given
   whole. */
export const SECTIONS_MARKER = "<!-- angel: sections below -->";
const READ_LIMIT = 90000; /* characters of sections one read_sections call gives back */

export function splitNotes(notes) {
  const at = notes.indexOf(SECTIONS_MARKER);
  if (at < 0) return { summary: notes, sections: [] };
  const summary = notes.slice(0, at).trim();
  const rest = notes.slice(at + SECTIONS_MARKER.length);
  const sections = [];
  const trail = [];
  for (const chunk of rest.split(/^(?=#{1,4} )/m)) {
    const m = chunk.match(/^(#{1,4}) (.+)/);
    if (!m) { if (chunk.trim() && sections.length) sections.at(-1).text += chunk; continue; }
    const level = m[1].length;
    trail.length = Math.max(0, level - 1);
    trail[level - 1] = m[2].trim();
    if (level === 1) continue; /* a top heading only names what follows */
    const body = chunk.slice(m[0].length).trim();
    if (!body) continue;
    const first = body.replace(/\s+/g, " ").slice(0, 140);
    sections.push({ id: sections.length + 1, title: trail.filter(Boolean).slice(1).join(" > ") || m[2].trim(), first, text: chunk.trim() });
  }
  return { summary, sections };
}

export function indexText(sections) {
  return sections.map(x => `[${x.id}] ${x.title} — ${x.first}`).join("\n");
}

/* every section holding all of the words (any capitals), best first, with the lines that matched */
export function searchNotes(sections, query, max = 12) {
  const words = String(query ?? "").toLowerCase().split(/[^a-z0-9'+-]+/).filter(w => w.length > 1).slice(0, 8);
  if (!words.length) return "No words to search for.";
  const hits = [];
  for (const x of sections) {
    const low = x.text.toLowerCase();
    if (!words.every(w => low.includes(w))) continue;
    const score = words.reduce((n, w) => n + low.split(w).length - 1, 0);
    const lines = x.text.split("\n").filter(l => words.some(w => l.toLowerCase().includes(w))).slice(0, 3).map(l => "    " + l.trim().slice(0, 240));
    hits.push({ score, line: `[${x.id}] ${x.title}\n${lines.join("\n")}` });
  }
  if (!hits.length) return `No section has all of: ${words.join(", ")}. Try fewer or other words.`;
  return hits.sort((a, b) => b.score - a.score).slice(0, max).map(h => h.line).join("\n");
}

export function readSections(sections, ids) {
  const out = [];
  let size = 0;
  for (const id of [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number))].slice(0, 12)) {
    const x = sections.find(s => s.id === id);
    if (!x) { out.push(`[${id}] no such section`); continue; }
    if (size + x.text.length > READ_LIMIT) { out.push(`[${id}] not included: too much at once; ask for it on its own`); continue; }
    size += x.text.length;
    out.push(`[${id}] ${x.title}\n${x.text}`);
  }
  return out.join("\n\n---\n\n");
}

export const NOTE_TOOLS = [
  { name: "search_notes", description: "Find the sections of the notes that hold all of some words (e.g. a button's name, a rule, a number). Returns section numbers, titles and the matching lines.", input_schema: { type: "object", properties: { query: { type: "string", description: "a few words" } }, required: ["query"] } },
  { name: "read_sections", description: "Read whole sections of the notes by their numbers from the index or a search.", input_schema: { type: "object", properties: { ids: { type: "array", items: { type: "integer" }, description: "section numbers, at most 12" } }, required: ["ids"] } },
];

const safeName = n => String(n).replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40) || "contact";
const stamp = at => new Date(at).toISOString().replace(/[:.]/g, "-");

export class DirectReplies {
  /* claude: the Claude class (create); canSpend() and addSpend(dollars): the bot's daily cap; dmOwner(text) */
  constructor({ dataDir, log, claude, model, cacheTtl = "1h", canSpend = () => true, addSpend = () => {}, dmOwner = async () => {}, ownerName = "the owner", maxPerDay = 40, keep = 8, maxLookups = 5, now = Date.now }) {
    Object.assign(this, { dataDir, log, claude, model, cacheTtl, canSpend, addSpend, dmOwner, ownerName, maxPerDay, keep, maxLookups, now });
    this.busy = new Map(); /* one exchange at a time per person, in order */
  }

  contacts() {
    try { return JSON.parse(fs.readFileSync(path.join(this.dataDir, "contacts.json"), "utf8").replace(/^﻿/, "")) ?? {}; } catch { return {}; }
  }

  /* the contact this user is, if they may be answered: a name, their notes and a line about them */
  contactOf(userId, username = "") {
    const uname = String(username ?? "").toLowerCase();
    for (const [name, c] of Object.entries(this.contacts())) {
      if (name.startsWith("_")) continue;
      const same = c && (c.user ? String(c.user) === String(userId) : !!uname && typeof c.username === "string" && c.username.trim().toLowerCase() === uname);
      if (same && typeof c.notes === "string" && c.notes.trim()) return { name, notes: c.notes.trim(), about: typeof c.about === "string" ? c.about : "" };
    }
    return null;
  }

  readNotes(file) {
    const dir = path.join(this.dataDir, "notes");
    const full = path.resolve(dir, file);
    if (!full.startsWith(path.resolve(dir) + path.sep)) return null; /* only files in data/notes/ */
    try { return fs.readFileSync(full, "utf8").replace(/^﻿/, ""); } catch { return null; }
  }

  history(name) {
    try { const h = JSON.parse(fs.readFileSync(path.join(this.dataDir, "conversations", `${safeName(name)}.json`), "utf8")); return Array.isArray(h) ? h : []; } catch { return []; }
  }

  record(name, entry) {
    const dir = path.join(this.dataDir, "conversations");
    fs.mkdirSync(dir, { recursive: true });
    const h = [...this.history(name), entry].slice(-50);
    fs.writeFileSync(path.join(dir, `${safeName(name)}.json`), JSON.stringify(h, null, 2) + "\n");
    const when = new Date(entry.at).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
    fs.appendFileSync(path.join(dir, `${safeName(name)}.md`), `## ${when} (${entry.kind})\n**${name}:** ${entry.them}\n\n**Angel:** ${entry.angel ?? "(no reply sent)"}\n\n`);
  }

  saveForOwner(name, entry) {
    const dir = path.join(this.dataDir, "inbox");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${stamp(entry.at)}-${safeName(name)}.json`), JSON.stringify({ from: name, ...entry }, null, 2) + "\n");
  }

  todayCount(name) {
    const day = new Date(this.now()).toDateString();
    return this.history(name).filter(e => new Date(e.at).toDateString() === day && e.angel).length;
  }

  /* one direct message: { userId, text, reply(text) }. Returns what happened, for the log and the tests. */
  async onDirect(msg) {
    const prev = this.busy.get(msg.userId) ?? Promise.resolve();
    const run = prev.then(() => this.handle(msg), () => this.handle(msg));
    this.busy.set(msg.userId, run.catch(() => {}));
    return run;
  }

  async handle({ userId, username, text, reply }) {
    const at = this.now();
    const named = this.contacts()._owner;
    if (typeof named === "string" && named.trim()) this.ownerName = named.trim().slice(0, 40);
    const them = String(text ?? "").trim().slice(0, 4000);
    const who = this.contactOf(userId, username);
    if (!who) { this.log.info(`direct message from someone who isn't a contact (${userId}); not answered`); return { answered: false, why: "not a contact" }; }
    if (!them) return { answered: false, why: "empty" };
    const notes = this.readNotes(who.notes);
    const holding = async (angel, why) => {
      await reply(angel).catch(e => this.log.warn(`couldn't answer ${who.name}: ${e.message}`));
      const entry = { at, them, angel, kind: "unknown", forOwner: `${why}: "${them.slice(0, 200)}"` };
      this.record(who.name, entry);
      this.saveForOwner(who.name, entry);
      await this.dmOwner(`📨 ${who.name} messaged me and I couldn't answer (${why}): "${them.slice(0, 300)}". It's saved in data\\inbox.`).catch(() => {});
      return { answered: false, why };
    };
    if (notes === null) return holding(`Thanks! I've passed that to ${this.ownerName} and I'll get back to you.`, `the notes file ${who.notes} is missing`);
    if (this.todayCount(who.name) >= this.maxPerDay || !this.canSpend()) return holding(`Thanks! I've hit my limit for today, so I've passed that to ${this.ownerName} and I'll pick it up tomorrow.`, "today's limit reached");
    const past = this.history(who.name).slice(-this.keep).flatMap(e => [{ role: "user", content: e.them }, { role: "assistant", content: JSON.stringify({ reply: e.angel ?? "", kind: e.kind, forOwner: e.forOwner ?? "" }) }]);
    let out;
    try {
      const before = this.claude.spent;
      const { summary, sections } = splitNotes(notes);
      const cache = this.cacheTtl === "5m" ? { type: "ephemeral" } : { type: "ephemeral", ttl: "1h" };
      /* the summary and the index are cached for an hour by default, since someone's messages are often more than
         five minutes apart (live, 2026-11-23: 9, 14 and 1 minutes) */
      const body = {
        model: this.model, max_tokens: 1500,
        system: [{ type: "text", text: systemPromptDm({ contact: who.name, about: who.about, notes: summary, index: indexText(sections), ownerName: this.ownerName }), cache_control: cache }],
        messages: [...past, { role: "user", content: them }],
      };
      if (sections.length) body.tools = NOTE_TOOLS;
      let res;
      for (let round = 0; ; round++) {
        res = await this.claude.create(body);
        const uses = (res.content ?? []).filter(b => b.type === "tool_use");
        if (res.stop_reason !== "tool_use" || !uses.length) break;
        const results = round >= this.maxLookups
          ? uses.map(u => ({ type: "tool_result", tool_use_id: u.id, content: "No more lookups: answer now from what you have." }))
          : null;
        if (results) {
          body.messages = [...body.messages, { role: "assistant", content: res.content }, { role: "user", content: results }];
          res = await this.claude.create({ ...body, tool_choice: { type: "none" } });
          break;
        }
        const found = uses.map(u => ({ type: "tool_result", tool_use_id: u.id, content: u.name === "search_notes" ? searchNotes(sections, u.input?.query) : u.name === "read_sections" ? readSections(sections, u.input?.ids) : "unknown tool" }));
        this.log.info(`direct reply to ${who.name}: ${uses.map(u => `${u.name}(${JSON.stringify(u.input ?? {}).slice(0, 80)})`).join(", ")}`);
        body.messages = [...body.messages, { role: "assistant", content: res.content }, { role: "user", content: found }];
      }
      this.addSpend(this.claude.spent - before);
      out = readReply((res.content ?? []).filter(b => b.type === "text").map(b => b.text).join(""));
    } catch (e) {
      this.log.warn(`direct reply to ${who.name} failed: ${e.message}`);
      return holding(`Thanks! I couldn't look that up just now, so I've passed it to ${this.ownerName} and I'll get back to you.`, "the answer failed");
    }
    let sent = true;
    await reply(out.reply).catch(e => { sent = false; this.log.warn(`couldn't answer ${who.name}: ${e.message}`); });
    const entry = { at, them, angel: sent ? out.reply : null, kind: out.kind, forOwner: out.forOwner };
    this.record(who.name, entry);
    this.log.info(`direct message from ${who.name} answered (${out.kind})`);
    if (["request", "bug", "unknown"].includes(out.kind)) {
      this.saveForOwner(who.name, entry);
      await this.dmOwner(`📨 ${who.name} sent a ${out.kind === "unknown" ? "question I couldn't answer" : out.kind}: ${out.forOwner || `"${them.slice(0, 300)}"`}\nWhat I told them: ${out.reply.slice(0, 600)}`).catch(() => {});
    }
    return { answered: sent, kind: out.kind };
  }
}
