import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { angelCommand, typedQuestion, SUBCOMMANDS } from "../src/commands.mjs";
import { loadConfig, saveConfig, missingSettings, readKeyterms, readSpeakers, writeSpeakers, readHouseRules, DEFAULTS } from "../src/config.mjs";
import { initLog, redact } from "../src/log.mjs";
import { inviteUrl, INVITE_PERMISSIONS } from "../src/setup.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "angel-c-"));

test("/angel has its seven subcommands, each within Discord's limits", () => {
  const c = angelCommand();
  assert.equal(c.name, "angel");
  assert.deepEqual(c.options.map(o => o.name), SUBCOMMANDS);
  for (const o of c.options) {
    assert.match(o.name, /^[a-z]{1,32}$/);
    assert.ok(o.description.length >= 1 && o.description.length <= 100, `${o.name}: ${o.description.length}`);
  }
  assert.equal(c.options.find(o => o.name === "ask").options[0].required, true);
});

test('typed questions: @Angel or "Angel, ..." at the start; other mentions are just chat', () => {
  assert.deepEqual(typedQuestion("<@123> what's off-guard?", "123"), { asked: true, mentioned: true, named: false, question: "what's off-guard?" });
  assert.equal(typedQuestion("Angel, can I Step and Strike?", "123").question, "can I Step and Strike?");
  assert.equal(typedQuestion("hey angel: flanking?", "123").asked, true);
  assert.equal(typedQuestion("the angel statue is creepy", "123").asked, false);
  assert.equal(typedQuestion("Angelic heritage question", "123").asked, false);
  assert.equal(typedQuestion("<@123>", "123").asked, false, "a bare mention isn't a question");
  assert.equal(typedQuestion("<@999> hi", "123").asked, false, "someone else mentioned");
});

test("config: defaults fill the gaps, prices merge, broken JSON is reported plainly", () => {
  const dir = tmp(), f = path.join(dir, "config.json");
  saveConfig({ discordToken: "t", prices: { "claude-sonnet-5-5": [9, 9, 9, 9] } }, f);
  const c = loadConfig(f);
  assert.equal(c.answerModel, DEFAULTS.answerModel);
  assert.deepEqual(c.prices["claude-sonnet-5-5"], [9, 9, 9, 9]);
  assert.ok(c.prices["claude-haiku-5-5"], "other prices kept");
  assert.deepEqual(missingSettings(c), ["the Claude API key", "the Deepgram API key"]);
  fs.writeFileSync(f, "{ nope");
  assert.throws(() => loadConfig(f), /config\.json is not valid JSON/);
  fs.writeFileSync(f, "\uFEFF{\"speak\": false}");
  assert.equal(loadConfig(f).speak, false, "a Windows byte-order mark is fine");
});

test("the table's own files: key terms, speakers, house rules", () => {
  const dir = tmp();
  const k = path.join(dir, "keyterms.txt");
  fs.writeFileSync(k, "# places\r\nBrightwater\r\n\r\nAngel\r\nMirefen # a swamp\r\n");
  assert.deepEqual(readKeyterms(k), ["Angel", "Brightwater", "Mirefen"]);
  assert.deepEqual(readKeyterms(path.join(dir, "missing.txt")), ["Angel"]);
  const s = path.join(dir, "speakers.json");
  writeSpeakers({ u1: { name: "Mira", role: "player" } }, s);
  assert.equal(readSpeakers(s).u1.name, "Mira");
  fs.writeFileSync(s, "broken");
  assert.deepEqual(readSpeakers(s), {});
  assert.equal(readHouseRules(path.join(dir, "none.md")), "");
});

test("secret keys never reach the log", () => {
  initLog({ discordToken: "SECRET-TOKEN-123", anthropicApiKey: "sk-ant-abcdefgh", deepgramApiKey: "" }, tmp());
  assert.equal(redact("token SECRET-TOKEN-123 and sk-ant-abcdefgh"), "token [hidden] and [hidden]");
});

test("the invite link asks for the bot and slash commands with just the permissions she needs", () => {
  const u = new URL(inviteUrl("42"));
  assert.equal(u.searchParams.get("client_id"), "42");
  assert.equal(u.searchParams.get("scope"), "bot applications.commands");
  assert.equal(u.searchParams.get("permissions"), String(INVITE_PERMISSIONS));
  assert.equal(INVITE_PERMISSIONS, 36785216n);
});

test('typed "Angel" needs a comma, colon or question mark after it (or "hey Angel")', () => {
  assert.equal(typedQuestion("Angel wings sprout from her back", "1").asked, false);
  assert.equal(typedQuestion("angel statue in the hall", "1").asked, false);
  assert.equal(typedQuestion("hey angel what's flanking", "1").question, "what's flanking");
  assert.equal(typedQuestion("Angel: grapple rules?", "1").question, "grapple rules?");
  assert.equal(typedQuestion("Angel? quick one", "1").asked, true);
});

test("a broken speakers.json is reported, not silently treated as empty when about to be written", () => {
  const dir = tmp(), s = path.join(dir, "speakers.json");
  fs.writeFileSync(s, '{ "1": { "name": "GM" }, oops }');
  const errors = [];
  assert.deepEqual(readSpeakers(s, { onError: e => errors.push(e.message) }), {});
  assert.equal(errors.length, 1);
  assert.throws(() => readSpeakers(s, { strict: true }), /speakers\.json/);
  fs.writeFileSync(s, "[1,2]");
  assert.throws(() => readSpeakers(s, { strict: true }), /isn't a/);
});
