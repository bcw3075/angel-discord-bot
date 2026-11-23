/* Messages the owner has approved, sent by Angel (0.2.0, the owner's ask of 2026-11-23: "have you send people
   messages and updates for me"). A Claude chat writes one small JSON file per message into data/outbox/ on her PC,
   only after the owner said yes to that exact message; Angel sends it and files it away. She never writes a
   message of her own here and never sends a file twice.

   A message file:   { "to": "owner", "text": "..." }
                     { "to": { "channel": "<channel id>" }, "text": "..." }
                     { "to": { "user": "<user id>" }, "text": "..." }
   "owner" is whoever owns the bot in the Discord Developer Portal (a direct message). A channel must be a text
   channel on a server she is in; a user gets a direct message, which Discord allows only when they share a server
   with her and accept direct messages from its members. Nobody is pinged: mentions in the text show as names only.

   The folders: data/outbox/*.json waiting; sending/ taken (a file is moved there before it is sent, so a crash
   can't send it again: one found there at the start is filed as failed, not sent); sent/ with where it went and
   when; failed/ with why. data/places.json lists the servers and the channels she can post in, with their ids. */
import fs from "node:fs";
import path from "node:path";

export const MAX_TEXT = 2000; /* Discord's limit for one message */
const SNOWFLAKE = /^\d{15,21}$/;

/* the message in a file's text, or an Error saying what is wrong with it */
export function readMessage(raw) {
  let m;
  try { m = JSON.parse(String(raw).replace(/^﻿/, "")); } catch (e) { return new Error(`not JSON: ${e.message}`); }
  if (!m || typeof m !== "object" || Array.isArray(m)) return new Error("not a message object");
  const text = typeof m.text === "string" ? m.text.trim() : "";
  if (!text) return new Error('no "text"');
  if (text.length > MAX_TEXT) return new Error(`"text" is ${text.length} characters; Discord's limit is ${MAX_TEXT}`);
  const to = m.to;
  if (to === "owner") return { to: "owner", text };
  if (to && typeof to === "object") {
    const keys = Object.keys(to);
    if (keys.length === 1 && (keys[0] === "channel" || keys[0] === "user") && SNOWFLAKE.test(String(to[keys[0]]))) return { to: { [keys[0]]: String(to[keys[0]]) }, text };
  }
  return new Error('"to" must be "owner", { "channel": "<id>" } or { "user": "<id>" }');
}

export class Outbox {
  /* send({ to, text }) → { where, id } is passed in (the bot's Discord side), so tests stand in for Discord */
  constructor({ dir, log, send, everyMs = 5000, maxPerHour = 20, now = Date.now }) {
    Object.assign(this, { dir, log, send, everyMs, maxPerHour, now });
    this.recent = [];
    this.busy = false;
  }

  start() {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (e) { this.log.warn(`couldn't make the outbox folder: ${e.message}`); return; }
    /* taken but never finished: Angel stopped mid-send. Not sent again, so nothing can go out twice */
    for (const name of this.list("sending")) this.file("sending", name, "failed", { error: "Angel stopped while sending this; not sent again so it can't go out twice. Check Discord, then send it again if it isn't there." });
    this.log.info(`outbox ready: approved messages put in ${this.dir} are sent`);
    this.timer = setInterval(() => this.poll().catch(e => this.log.warn(`outbox: ${e.message}`)), this.everyMs);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }

  list(sub = "") {
    try { return fs.readdirSync(path.join(this.dir, sub), { withFileTypes: true }).filter(d => d.isFile() && d.name.endsWith(".json")).map(d => d.name).sort(); }
    catch { return []; }
  }

  /* moves a file into a folder beside it; extra is written in with it (the result) */
  file(from, name, to, extra) {
    const src = path.join(this.dir, from, name), dest = path.join(this.dir, to, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!extra) { fs.renameSync(src, dest); return dest; }
    let body;
    try { body = JSON.parse(fs.readFileSync(src, "utf8").replace(/^﻿/, "")); } catch { body = { raw: fs.readFileSync(src, "utf8") }; }
    if (!body || typeof body !== "object" || Array.isArray(body)) body = { raw: body };
    fs.writeFileSync(dest, JSON.stringify({ ...body, ...extra }, null, 2) + "\n");
    fs.rmSync(src, { force: true });
    return dest;
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const name of this.list()) {
        /* a file written in the last two seconds may still be arriving: the next look takes it */
        try { if (this.now() - fs.statSync(path.join(this.dir, name)).mtimeMs < 2000) continue; } catch { continue; }
        const hourAgo = this.now() - 3600000;
        this.recent = this.recent.filter(t => t > hourAgo);
        if (this.recent.length >= this.maxPerHour) { this.log.warn(`outbox: ${this.maxPerHour} messages sent in the last hour; the rest wait`); return; }
        /* taken first: once it is in sending/ no second look can send it again */
        try { this.file("", name, "sending"); } catch { continue; } /* still being copied in, or gone */
        const msg = readMessage(fs.readFileSync(path.join(this.dir, "sending", name), "utf8"));
        if (msg instanceof Error) {
          this.log.warn(`outbox: ${name} not sent: ${msg.message}`);
          this.file("sending", name, "failed", { error: msg.message, at: new Date(this.now()).toISOString() });
          continue;
        }
        try {
          const r = await this.send(msg);
          this.recent.push(this.now());
          this.log.info(`outbox: ${name} sent (${r.where})`);
          this.file("sending", name, "sent", { sentAt: new Date(this.now()).toISOString(), where: r.where, messageId: r.id });
        } catch (e) {
          this.log.warn(`outbox: ${name} not sent: ${e.message}`);
          this.file("sending", name, "failed", { error: e.message, at: new Date(this.now()).toISOString() });
        }
      }
    } finally { this.busy = false; }
  }
}

/* the servers she is in and the text channels she can post in there, for whoever writes a message file */
export function placesOf(guilds, me, canPost) {
  return guilds.map(g => ({
    server: g.name, id: g.id,
    channels: [...(g.channels?.cache?.values?.() ?? [])].filter(c => c.isTextBased?.() && !c.isThread?.() && !c.isVoiceBased?.() && canPost(c, me)).map(c => ({ name: c.name, id: c.id })),
  }));
}
