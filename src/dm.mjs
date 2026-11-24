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

export function systemPromptDm({ contact, about, notes, ownerName = "the owner" }) {
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
</notes>`;
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

const safeName = n => String(n).replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40) || "contact";
const stamp = at => new Date(at).toISOString().replace(/[:.]/g, "-");

export class DirectReplies {
  /* claude: the Claude class (create); canSpend() and addSpend(dollars): the bot's daily cap; dmOwner(text) */
  constructor({ dataDir, log, claude, model, canSpend = () => true, addSpend = () => {}, dmOwner = async () => {}, ownerName = "the owner", maxPerDay = 40, keep = 8, now = Date.now }) {
    Object.assign(this, { dataDir, log, claude, model, canSpend, addSpend, dmOwner, ownerName, maxPerDay, keep, now });
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
      const res = await this.claude.create({
        model: this.model, max_tokens: 1200,
        /* the notes can be long (every rules call the site made): cached, so a conversation's later messages read them cheaply */
        system: [{ type: "text", text: systemPromptDm({ contact: who.name, about: who.about, notes, ownerName: this.ownerName }), cache_control: { type: "ephemeral" } }],
        messages: [...past, { role: "user", content: them }],
      });
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
