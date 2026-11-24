/* The outbox: approved message files sent once, filed as sent or failed, never sent twice; and the bot's Discord
   side of it with stand-ins (a direct message to the bot's owner or a user, a post in a channel, no pings). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Outbox, readMessage, placesOf } from "../src/outbox.mjs";
import { AngelBot } from "../src/bot.mjs";
import { DEFAULTS } from "../src/config.mjs";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const OLD = Date.now() - 60000; /* written a minute ago: past the two seconds a file may still be arriving */

function box({ send, ...extra } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "angel-o-"));
  const sent = [];
  const ob = new Outbox({ dir, log: quiet, send: send ?? (async m => { sent.push(m); return { where: "somewhere", id: "m1" }; }), ...extra });
  const put = (name, body, at = OLD) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body));
    fs.utimesSync(f, at / 1000, at / 1000);
  };
  const read = (sub, name) => JSON.parse(fs.readFileSync(path.join(dir, sub, name), "utf8"));
  return { dir, ob, sent, put, read };
}

test("readMessage takes the owner, a channel id or a user id, and refuses anything else", () => {
  assert.deepEqual(readMessage('{"to":"owner","text":" hi "}'), { to: "owner", text: "hi" });
  assert.deepEqual(readMessage('﻿{"to":{"user":"123456789012345678"},"text":"hi"}'), { to: { user: "123456789012345678" }, text: "hi" });
  assert.deepEqual(readMessage('{"to":{"channel":"123456789012345678"},"text":"hi"}'), { to: { channel: "123456789012345678" }, text: "hi" });
  for (const bad of ["nope", "[]", '{"to":"owner"}', '{"to":"owner","text":"  "}', '{"to":"everyone","text":"hi"}',
    '{"to":{"user":"Dana"},"text":"hi"}', '{"to":{"user":"123456789012345678","channel":"123456789012345678"},"text":"hi"}',
    JSON.stringify({ to: "owner", text: "x".repeat(2001) })]) assert.ok(readMessage(bad) instanceof Error, bad);
});

test("an approved message is sent once and filed in sent/ with where it went", async () => {
  const { dir, ob, sent, put, read } = box();
  put("a.json", { to: "owner", text: "Hello owner" });
  await ob.poll();
  await ob.poll();
  assert.deepEqual(sent, [{ to: "owner", text: "Hello owner" }]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["sending", "sent"]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "sending")), []);
  const r = read("sent", "a.json");
  assert.equal(r.text, "Hello owner");
  assert.equal(r.where, "somewhere");
  assert.equal(r.messageId, "m1");
  assert.ok(r.sentAt);
});

test("a bad file or a refused send goes to failed/ with why, and is not tried again", async () => {
  let tries = 0;
  const { ob, put, read } = box({ send: async () => { tries++; throw new Error("Cannot send messages to this user"); } });
  put("bad.json", "{ not json");
  put("dm.json", { to: { user: "123456789012345678" }, text: "hi" });
  await ob.poll();
  await ob.poll();
  assert.equal(tries, 1);
  assert.match(read("failed", "bad.json").error, /not JSON/);
  assert.equal(read("failed", "dm.json").error, "Cannot send messages to this user");
});

test("a file still arriving waits for the next look; other files and folders are left alone", async () => {
  const { dir, ob, sent, put } = box();
  put("new.json", { to: "owner", text: "soon" }, Date.now());
  put("notes.txt", "not a message");
  await ob.poll();
  assert.equal(sent.length, 0);
  assert.ok(fs.existsSync(path.join(dir, "new.json")));
  assert.ok(fs.existsSync(path.join(dir, "notes.txt")));
});

test("a file left in sending/ by a crash is filed as failed at the start, never sent", async () => {
  const { dir, ob, sent, read } = box({ everyMs: 60000 });
  fs.mkdirSync(path.join(dir, "sending"));
  fs.writeFileSync(path.join(dir, "sending", "x.json"), JSON.stringify({ to: "owner", text: "maybe sent" }));
  ob.start(); ob.stop();
  await ob.poll();
  assert.equal(sent.length, 0);
  assert.match(read("failed", "x.json").error, /not sent again/);
});

test("past the hourly limit the rest wait in the outbox", async () => {
  const { dir, ob, sent, put } = box({ maxPerHour: 2 });
  for (const n of ["1", "2", "3"]) put(`${n}.json`, { to: "owner", text: n });
  await ob.poll();
  assert.deepEqual(sent.map(m => m.text), ["1", "2"]);
  assert.ok(fs.existsSync(path.join(dir, "3.json")));
});

test("places lists each server's text channels she can post in", () => {
  const ch = (id, name, kind, ok = true) => ({ id, name, ok, isTextBased: () => kind !== "category", isThread: () => kind === "thread", isVoiceBased: () => kind === "voice" });
  const g = { id: "g1", name: "Home", channels: { cache: new Map([["1", ch("1", "general", "text")], ["2", ch("2", "Game", "voice")], ["3", ch("3", "secret", "text", false)], ["4", ch("4", "a thread", "thread")]]) } };
  assert.deepEqual(placesOf([g], {}, c => c.ok), [{ server: "Home", id: "g1", channels: [{ name: "general", id: "1" }] }]);
});

/* the bot's Discord side, with stand-ins for discord.js */
function bot(client) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "angel-ob-"));
  const b = new AngelBot({ cfg: { ...DEFAULTS }, log: quiet, services: {}, dataDir: dir, tablesDir: path.join(dir, "tables") });
  b.client = client;
  clearInterval(b.bookTimer);
  return b;
}
const person = (id, name, out) => ({ id, username: name, send: async m => { out.push({ to: name, ...m }); return { id: "dm1" }; } });

test("sendOut: to the owner is a direct message to the bot's owner (a team's owner too), with no pings", async () => {
  const out = [];
  const b = bot({ application: { fetch: async () => ({ owner: person("1", "sam", out) }) } });
  assert.deepEqual(await b.sendOut({ to: "owner", text: "hi <@everyone>" }), { where: "direct message to sam", id: "dm1" });
  assert.deepEqual(out, [{ to: "sam", content: "hi <@everyone>", allowedMentions: { parse: [] } }]);
  const t = bot({ application: { fetch: async () => ({ owner: { owner: { user: person("2", "teamlead", out) } } }) } });
  assert.equal((await t.sendOut({ to: "owner", text: "x" })).where, "direct message to teamlead");
});

test("sendOut: a user id is a direct message; a channel id must be a text channel on a server", async () => {
  const out = [];
  const posts = [];
  const text = { name: "general", guild: { name: "Home" }, isTextBased: () => true, isVoiceBased: () => false, send: async m => { posts.push(m); return { id: "p1" }; } };
  const voice = { name: "Game", guild: { name: "Home" }, isTextBased: () => true, isVoiceBased: () => true, send: async () => { throw new Error("should not post"); } };
  const b = bot({
    users: { fetch: async id => person(id, "dana", out) },
    channels: { fetch: async id => ({ "111111111111111111": text, "222222222222222222": voice })[id] ?? Promise.reject(new Error("Unknown Channel")) },
  });
  assert.equal((await b.sendOut({ to: { user: "333333333333333333" }, text: "hello" })).where, "direct message to dana");
  assert.deepEqual(await b.sendOut({ to: { channel: "111111111111111111" }, text: "update" }), { where: "#general in Home", id: "p1" });
  assert.deepEqual(posts, [{ content: "update", allowedMentions: { parse: [] } }]);
  await assert.rejects(b.sendOut({ to: { channel: "222222222222222222" }, text: "x" }), /isn't a text channel/);
  await assert.rejects(b.sendOut({ to: { channel: "444444444444444444" }, text: "x" }), /isn't a text channel/);
});

test("outbox: false in config.json leaves it off", () => {
  const b = bot(null);
  b.cfg.outbox = false;
  b.startOutbox({ user: {} }, []);
  assert.equal(b.outbox, undefined);
  assert.ok(!fs.existsSync(path.join(b.dataDir, "places.json")));
});

test("a contact's name is sent to the id in contacts.json, any capitals; an unknown name fails and is not sent", async () => {
  const { dir, sent, put, read } = box();
  const contactsFile = path.join(dir, "..", `contacts-${path.basename(dir)}.json`);
  fs.writeFileSync(contactsFile, JSON.stringify({ "table-gm": { user: "123456789012345678" }, broken: { user: "x" }, loop: { contact: "table-gm" } }));
  const ob = new Outbox({ dir, log: quiet, contactsFile, send: async m => { sent.push(m); return { where: "dm", id: "m2" }; } });
  put("1.json", { to: { contact: "Table-GM" }, text: "news" });
  put("2.json", { to: { contact: "nobody" }, text: "x" });
  put("3.json", { to: { contact: "broken" }, text: "x" });
  put("4.json", { to: { contact: "loop" }, text: "x" });
  await ob.poll();
  assert.deepEqual(sent, [{ to: { user: "123456789012345678" }, text: "news" }]);
  assert.equal(read("sent", "1.json").contact, "table-gm");
  for (const n of ["2", "3", "4"]) assert.match(read("failed", `${n}.json`).error, /no contact/);
});

test("with no contacts.json a contact fails with why", async () => {
  const { ob, sent, put, read } = box();
  put("c.json", { to: { contact: "table-gm" }, text: "x" });
  await ob.poll();
  assert.equal(sent.length, 0);
  assert.match(read("failed", "c.json").error, /no contact "table-gm"/);
});

test("a contact by username is looked up on her servers by exact username, and fails when no one has it", async () => {
  const { resolveContact } = await import("../src/outbox.mjs");
  assert.deepEqual(resolveContact({ to: { contact: "gm" }, text: "t" }, { gm: { username: "Some_GM" } }), { to: { username: "some_gm" }, text: "t", contact: "gm" });
  assert.ok(resolveContact({ to: { contact: "gm" }, text: "t" }, { gm: { username: "bad name!" } }) instanceof Error);
  const out = [];
  const member = (username, id) => ({ user: person(id, username, out) });
  const guild = (name, members) => ({ name, members: { search: async ({ query }) => new Map(members.filter(m => m.user.username.includes(query)).map(m => [m.user.id, m])) } });
  const b = bot({ guilds: { cache: new Map([["a", guild("A", [member("some_gm2", "1")])], ["b", guild("B", [member("some_gm", "2")])]]) } });
  assert.equal((await b.sendOut({ to: { username: "some_gm" }, text: "hi" })).where, "direct message to some_gm");
  assert.equal(out[0].to, "some_gm");
  await assert.rejects(b.sendOut({ to: { username: "nobody" }, text: "x" }), /no one with the username nobody/);
});

/* review 10 */
test("an id written as a number is refused, in a message file or in contacts.json", async () => {
  assert.ok(readMessage('{"to":{"user":123456789012345678},"text":"hi"}') instanceof Error);
  const { resolveContact } = await import("../src/outbox.mjs");
  assert.ok(resolveContact({ to: { contact: "gm" }, text: "t" }, { gm: { user: 123456789012345678 } }) instanceof Error);
});

test("a message sent but not filed in sent/ is never counted as failed or sent again", async () => {
  const { dir, ob, sent, put } = box();
  put("a.json", { to: "owner", text: "once" });
  const file = ob.file.bind(ob);
  ob.file = (from, name, to, extra) => { if (to === "sent") throw new Error("disk full"); return file(from, name, to, extra); };
  await ob.poll();
  await ob.poll();
  assert.equal(sent.length, 1);
  assert.ok(!fs.existsSync(path.join(dir, "failed")));
  ob.file = file;
  ob.start(); ob.stop();
  await ob.poll();
  assert.equal(sent.length, 1);
  assert.match(JSON.parse(fs.readFileSync(path.join(dir, "failed", "a.json"), "utf8")).error, /not sent again/);
});

test("a refused send says to look in Discord before sending it again", async () => {
  const { ob, put, read } = box({ send: async () => { throw new Error("socket hang up"); } });
  put("b.json", { to: "owner", text: "x" });
  await ob.poll();
  assert.match(read("failed", "b.json").check, /Look in Discord/);
});
