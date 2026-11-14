import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { angelCommand, typedQuestion, SUBCOMMANDS } from "../src/commands.mjs";
import { loadConfig, saveConfig, missingSettings, readKeyterms, readSpeakers, writeSpeakers, readHouseRules, DEFAULTS, tableFilesReport, fixFor, keyLooksWrong } from "../src/config.mjs";
import { initLog, redact } from "../src/log.mjs";
import { inviteUrl, INVITE_PERMISSIONS, within, tokenRefused } from "../src/setup.mjs";
import { transcribe } from "../src/stt.mjs";
import { scriptedFetch } from "./helpers.mjs";

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
  assert.throws(() => loadConfig(f), /config\.json can't be read: .*Open it in Notepad/);
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

test("setup saves the settings she can change, but not models and prices, so a new release's reach her", () => {
  const dir = tmp(), f = path.join(dir, "config.json");
  saveConfig({ ...DEFAULTS, discordToken: "t", ttsVoice: "aura-2-luna-en" }, f);
  const saved = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const k of ["answerModel", "gateModel", "sttModel", "prices", "deepgramPrices", "aonUserAgent"]) assert.equal(k in saved, false, k);
  assert.equal(saved.discordToken, "t");
  assert.equal(saved.ttsVoice, "aura-2-luna-en");
  assert.equal(saved.speak, true, "everyday settings are in the file to edit");
  saveConfig({ ...DEFAULTS, answerModel: "claude-opus-5-5", prices: { ...DEFAULTS.prices, "claude-opus-5-5": [1, 1, 1, 1] } }, f);
  const again = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.equal(again.answerModel, "claude-opus-5-5", "her own choice is kept");
  assert.deepEqual(Object.keys(again.prices), ["claude-opus-5-5"], "only the price she changed");
  assert.deepEqual(loadConfig(f).prices["claude-sonnet-5-5"], DEFAULTS.prices["claude-sonnet-5-5"]);
});

test('settings typed with quote marks keep their kind: "false" is false, "5" is 5', () => {
  const dir = tmp(), f = path.join(dir, "config.json");
  fs.writeFileSync(f, JSON.stringify({ speak: "false", saveTranscript: "No", maxSessionDollars: "7.5", ackPhrase: "1" }));
  const c = loadConfig(f);
  assert.equal(c.speak, false);
  assert.equal(c.saveTranscript, false);
  assert.equal(c.maxSessionDollars, 7.5);
  assert.equal(c.ackPhrase, "1", "a text setting stays text");
});

test('files Notepad saved as "Unicode" (UTF-16) read the same as UTF-8 ones', () => {
  const dir = tmp();
  const utf16 = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])); return f; };
  assert.equal(loadConfig(utf16("config.json", '{"speak": false}')).speak, false);
  assert.deepEqual(readKeyterms(utf16("keyterms.txt", "Brightwater\r\nMirefen\r\n")), ["Angel", "Brightwater", "Mirefen"]);
  assert.equal(readHouseRules(utf16("house-rules.md", "Hero points: 1 a session.")), "Hero points: 1 a session.");
  assert.equal(readSpeakers(utf16("speakers.json", '{"u1": {"name": "Mira"}}')).u1.name, "Mira");
});

test("check reports the table files: found, missing, misnamed .txt, broken speakers", () => {
  const dir = tmp();
  const files = { houseRules: path.join(dir, "house-rules.md"), keyterms: path.join(dir, "keyterms.txt"), speakers: path.join(dir, "speakers.json") };
  assert.deepEqual(tableFilesReport(files).map(l => l.level), ["note", "note"], "nothing there: notes, not failures");
  fs.writeFileSync(files.houseRules + ".txt", "rules");
  fs.writeFileSync(files.keyterms + ".txt", "Mirefen");
  fs.writeFileSync(files.speakers, "{ broken");
  const misnamed = tableFilesReport(files);
  assert.deepEqual(misnamed.map(l => l.level), ["fail", "fail", "fail"]);
  assert.match(misnamed[0].text, /house-rules\.md\.txt: rename it/);
  fs.renameSync(files.houseRules + ".txt", files.houseRules);
  fs.renameSync(files.keyterms + ".txt", files.keyterms);
  writeSpeakers({ u1: { name: "Mira" } }, files.speakers);
  assert.deepEqual(tableFilesReport(files).map(l => [l.level, l.text]), [["ok", "house-rules.md, 5 characters"], ["ok", "keyterms.txt, 1 name"], ["ok", "speakers.json, 1 name"]]);
});

test("a FAIL in check says what to do for the usual reasons", async () => {
  assert.match(fixFor("Discord", "An invalid token was provided."), /paste a fresh one/);
  assert.match(fixFor("Claude", "Claude answered 401: invalid x-api-key"), /Claude key was refused: run npm run setup/);
  assert.match(fixFor("Deepgram", "Deepgram speak answered 403: Insufficient permissions"), /Deepgram key was refused/);
  assert.match(fixFor("Claude", "fetch failed"), /internet connection/);
  assert.equal(fixFor("Archives", "unexpected first result Grab"), "");
  const f = scriptedFetch([{ status: 401, body: { err_code: "INVALID_AUTH", err_msg: "Invalid credentials." } }]);
  await assert.rejects(transcribe(Buffer.alloc(10), { apiKey: "k", fetchImpl: f }), /^Error: Deepgram listen answered 401: Invalid credentials\.$/);
});

test("setup warns about a key that doesn't look like one, and only blames the token when Discord refused it", async () => {
  assert.equal(keyLooksWrong("anthropicApiKey", "sk-ant-api03-abc"), "");
  assert.match(keyLooksWrong("anthropicApiKey", "sk-ant-api03-abcsk-ant-api03-abc"), /pasted twice/);
  assert.match(keyLooksWrong("anthropicApiKey", "sk-ant-api03-abcsk-ant-api03-xyz"), /start with sk-ant- \(once\)/);
  assert.match(keyLooksWrong("anthropicApiKey", "dg-123"), /sk-ant-/);
  assert.equal(keyLooksWrong("discordToken", "MTIz.Gabc.def-ghi_jk"), "");
  assert.match(keyLooksWrong("discordToken", "MTIz.Gabc"), /three parts/);
  assert.match(keyLooksWrong("deepgramApiKey", "a".repeat(81)), /pasted twice/);
  assert.match(keyLooksWrong("deepgramApiKey", "abc def"), /space or line break/);
  assert.equal(tokenRefused(Object.assign(new Error("An invalid token was provided."), { code: "TokenInvalid" })), true);
  assert.equal(tokenRefused(new Error("getaddrinfo ENOTFOUND discord.com")), false);
  await assert.rejects(within(10, new Promise(() => {}), "Discord didn't answer"), /Discord didn't answer/);
  assert.equal(await within(1000, Promise.resolve(5), "no"), 5);
});

test("a setting that can't be read as its kind gets the default and a problem line, so a cap can't silently stop working", () => {
  const dir = tmp(), f = path.join(dir, "config.json");
  fs.writeFileSync(f, '{"maxDailyDollars": "$12", "maxSessionDollars": "5 dollars", "speak": "maybe", "guildId": 1234567890123456789, "answerModel": "claude-new-9"}');
  const c = loadConfig(f);
  assert.equal(c.maxDailyDollars, 12, "a dollar sign is fine");
  assert.equal(c.maxSessionDollars, DEFAULTS.maxSessionDollars);
  assert.equal(c.speak, DEFAULTS.speak);
  assert.equal(c.problems.length, 4);
  assert.match(c.problems.join("\n"), /"maxSessionDollars" should be a number/);
  assert.match(c.problems.join("\n"), /"speak" should be true or false/);
  assert.match(c.problems.join("\n"), /"guildId" needs its quote marks/);
  assert.match(c.problems.join("\n"), /no price is known for "claude-new-9"/);
  saveConfig(c, f);
  assert.equal("problems" in JSON.parse(fs.readFileSync(f, "utf8")), false, "never written to the file");
  assert.deepEqual(loadConfig(path.join(dir, "none.json")).problems, []);
});

test('a "Unicode big endian" file reads too', () => {
  const dir = tmp(), f = path.join(dir, "house-rules.md");
  fs.writeFileSync(f, Buffer.from(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Hero points.", "utf16le")])).swap16());
  assert.equal(readHouseRules(f), "Hero points.");
});

test("FAIL advice only talks about keys for the services that have one", () => {
  assert.equal(fixFor("Archives", "Archives of Nethys answered 403"), "");
  assert.equal(fixFor("Speakers", "speakers.json: Unexpected token at position 402 (line 1 column 403)"), "");
  assert.match(fixFor("Deepgram", "The operation was aborted due to timeout"), /couldn't reach Deepgram/);
  assert.match(fixFor("Discord", "Discord didn't answer within 30 seconds (a VPN or firewall can block it)"), /couldn't reach Discord/);
  assert.match(fixFor("Claude", "Claude answered 400: Your credit balance is too low"), /payment or credit/);
});

test("a key pasted twice is noticed whatever its length", () => {
  const dg = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(keyLooksWrong("deepgramApiKey", dg), "");
  assert.match(keyLooksWrong("deepgramApiKey", dg + dg), /pasted twice/);
});

test("the time limit leaves no timer behind once the step is done", async () => {
  const timers = () => process.getActiveResourcesInfo().filter(r => r === "Timeout").length;
  const before = timers();
  await within(60000, Promise.resolve("done"), "too slow");
  await within(60000, Promise.reject(new Error("refused")), "too slow").catch(() => {});
  assert.equal(timers(), before);
});
