import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { angelCommand, typedQuestion, SUBCOMMANDS } from "../src/commands.mjs";
import { loadConfig, saveConfig, missingSettings, readKeyterms, readSpeakers, writeSpeakers, readHouseRules, DEFAULTS, tableFilesReport, fixFor, keyLooksWrong, pasteSummary } from "../src/config.mjs";
import { initLog, redact } from "../src/log.mjs";
import { inviteUrl, INVITE_PERMISSIONS, within, tokenRefused, askKey } from "../src/setup.mjs";
import { transcribe } from "../src/stt.mjs";
import { VOICES, voiceFromName } from "../src/tts.mjs";
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
  assert.equal(INVITE_PERMISSIONS, 309274430528n, "with Create Public Threads and Send Messages in Threads");
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
  assert.match(keyLooksWrong("deepgramApiKey", "a".repeat(81)), /longer than a Deepgram key/);
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

test("setup's paste summary shows the start, the end and the length, never the whole key", () => {
  const key = "sk-ant-api03-" + "x".repeat(90) + "AbCd";
  const s = pasteSummary(key);
  assert.equal(s, `starts sk-ant-api03, ends ...AbCd, ${key.length} characters`);
  assert.ok(!s.includes("x".repeat(5)));
  const dg = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(pasteSummary(dg), "starts 0123456789, ends ...4567, 40 characters");
  assert.equal(pasteSummary("short"), "5 characters");
  assert.equal(pasteSummary(""), "");
});

test("setup asks again for a key that looks wrong instead of saving it, and Enter keeps the old one", async () => {
  const run = async (answers, cfg = {}, key = "discordToken") => {
    const said = [], q = [...answers];
    await askKey(cfg, key, "key", async () => q.shift() ?? "", l => said.push(l));
    assert.equal(q.length, 0, "every answer used");
    return { cfg, said };
  };
  const good = "MTIz.Gabc.def-ghi_jk", other = "MTIy.Gxyz.uvw-rst_qp";
  // two tokens on one hidden line (Rhea, 2026-11-14), then the right one: only the right one is saved
  let r = await run([good + other, other]);
  assert.equal(r.cfg.discordToken, other);
  assert.match(r.said[0], /Not saved/);
  assert.ok(!r.said.join(" ").includes(good) && !r.said.join(" ").includes(other), "no whole key shown");
  assert.match(r.said.at(-1), /Got it/);
  // two tokens run together can't be saved even pasted twice the same
  r = await run([good + other, good + other, ""]);
  assert.equal(r.cfg.discordToken, undefined);
  assert.match(r.said.at(-1), /Nothing saved/);
  // a wrong one, then Enter: the old key stays
  r = await run([good + other, ""], { discordToken: good });
  assert.equal(r.cfg.discordToken, good);
  assert.match(r.said.at(-1), /Kept/);
  // the same odd-looking key twice in a row is saved (a new format can't lock her out); A, B, A is not
  r = await run(["odd-token", "odd-token"]);
  assert.equal(r.cfg.discordToken, "odd-token");
  assert.match(r.said.at(-1), /pasted it twice/);
  r = await run(["odd-a", "odd-b", "odd-a", ""]);
  assert.equal(r.cfg.discordToken, undefined);
  // a good key at once: saved, one line
  r = await run([good]);
  assert.equal(r.cfg.discordToken, good);
  assert.equal(r.said.length, 1);
  // Claude and Deepgram: two keys on one line are refused
  const ant = "sk-ant-api03-" + "a".repeat(40), ant2 = "sk-ant-api03-" + "b".repeat(40);
  r = await run([ant + ant2, ant2], {}, "anthropicApiKey");
  assert.equal(r.cfg.anthropicApiKey, ant2);
  const dg = "0123456789abcdef0123456789abcdef01234567", dg2 = "fedcba9876543210fedcba9876543210fedcba98";
  r = await run([dg + dg2, dg + dg2, dg2], {}, "deepgramApiKey");
  assert.equal(r.cfg.deepgramApiKey, dg2);
});

test("the voice chooser knows the voices by short name", () => {
  assert.equal(VOICES.length, 24);
  assert.ok(VOICES.includes("aura-2-thalia-en"), "the default is among them");
  assert.equal(voiceFromName("Luna"), "aura-2-luna-en");
  assert.equal(voiceFromName(" luna.mp3 "), "aura-2-luna-en");
  assert.equal(voiceFromName("aura-2-hera-en"), "aura-2-hera-en");
  assert.equal(voiceFromName("zeus"), "");
  assert.equal(voiceFromName(""), "");
});

test("every source file parses, including the scripts no test imports (check.mjs runs on import)", async () => {
  const { execFileSync } = await import("node:child_process");
  for (const f of fs.readdirSync("src").filter(f => f.endsWith(".mjs"))) execFileSync(process.execPath, ["--check", path.join("src", f)]);
});

test("config: a price that isn't a number, or a setting below its floor, is replaced and named (the caps depend on them)", () => {
  const dir = tmp(), f = path.join(dir, "config.json");
  fs.writeFileSync(f, JSON.stringify({ prices: { "claude-sonnet-5-5": ["$2", 2.5, 0.1, 10], "my-model": "cheap", "ok-model": [1, 1, 1, 1] }, deepgramPrices: { sttPerMinute: "$0.0043" }, memoryMinutes: 0, maxAnswerTokens: -5, maxSessionDollars: -1, maxDailyDollars: 0 }));
  const c = loadConfig(f);
  assert.deepEqual(c.prices["claude-sonnet-5-5"], DEFAULTS.prices["claude-sonnet-5-5"]);
  assert.equal(c.prices["my-model"], undefined, "counted at the dearest known price instead");
  assert.deepEqual(c.prices["ok-model"], [1, 1, 1, 1]);
  assert.equal(c.deepgramPrices.sttPerMinute, DEFAULTS.deepgramPrices.sttPerMinute);
  assert.equal(c.deepgramPrices.ttsPer1000Chars, DEFAULTS.deepgramPrices.ttsPer1000Chars);
  assert.equal(c.memoryMinutes, DEFAULTS.memoryMinutes);
  assert.equal(c.maxAnswerTokens, DEFAULTS.maxAnswerTokens);
  assert.equal(c.maxSessionDollars, DEFAULTS.maxSessionDollars);
  assert.equal(c.maxDailyDollars, 0, "a cap of nothing is a choice (she spends nothing), not a mistake");
  for (const word of ["claude-sonnet-5-5", "my-model", "sttPerMinute", "memoryMinutes", "maxAnswerTokens", "maxSessionDollars"]) assert.ok(c.problems.some(p => p.includes(word)), `named: ${word}`);
  assert.equal(loadConfig(path.join(dir, "none.json")).problems.length, 0, "the defaults themselves pass");
});

test("the self-test runs every case through the check and the answering, marks what to look at, and writes a report", async () => {
  const { runSelfTest, reportText, saveReport, CASES } = await import("../src/selftest.mjs");
  assert.ok(CASES.length >= 25 && new Set(CASES.map(c => c.id)).size === CASES.length, "many cases, each with its own name");
  const asked = [];
  const services = {
    gate: async ({ lastText, replying }) => ({ toAngel: !/statue|wrong/.test(lastText), complete: !/quick one/.test(lastText), chat: /feeling/.test(lastText), question: "", dollars: 0.001, replying }),
    answer: async q => {
      asked.push(q);
      if (/breaks/.test(q.question)) { const e = new Error("Claude answered 400: nope"); e.dollars = 0.01; throw e; }
      q.onSay("Off-guard is a minus 2 circumstance penalty to AC. "); q.onSay("", { end: true });
      return { say: "Off-guard is a minus 2 circumstance penalty to AC.", details: "**-2 circumstance penalty to AC.**", sources: [{ name: "Off-Guard", url: "https://2e.aonprd.com/Conditions.aspx?ID=58" }], rounds: 2, lookups: 1, failedLookups: 0, dollars: 0.02 };
    },
  };
  const cases = [
    { id: "fine", steps: [{ say: "Angel, what does off-guard do?", want: [/2/, /circumstance/i], lookups: 1 }, { say: "And then?", replying: true }] },
    { id: "wrong-fact", steps: [{ say: "Angel, fireball?", want: [/10d6/], never: [/circumstance/] }] },
    { id: "breaks", steps: [{ say: "Angel, this breaks" }] },
    { id: "statue", steps: [{ say: "that angel statue", forHer: false, checkOnly: true }] },
    { id: "check-is-wrong", steps: [{ say: "Angel, the check gets this wrong", checkOnly: true }] },
    { id: "call", steps: [{ say: "Hey Angel, quick one.", complete: false, checkOnly: true }] },
    { id: "typed", before: ["Mira: earlier talk"], steps: [{ say: "what is off-guard?", typed: true }] },
  ];
  /* a check Claude refused is a failure, not a note; one that only fell back is a note */
  const refused = await runSelfTest({ services: { ...services, gate: async ({ lastText }) => ({ toAngel: true, complete: true, error: /first/.test(lastText) ? "Claude answered 400: no" : "its reply was cut off" }) }, cases: [{ id: "a", steps: [{ say: "Angel, first", checkOnly: true }] }, { id: "b", steps: [{ say: "Angel, second", checkOnly: true }] }] });
  assert.equal(refused.failed, 1);
  assert.equal(refused.look, 1);
  /* the same words again, and a vague question answered instead of asked back, are marked */
  const same = await runSelfTest({ services, cases: [{ id: "again", steps: [{ say: "Angel, what does off-guard do?" }, { say: "I don't understand.", replying: true, fresh: true }] }, { id: "vague", steps: [{ say: "Angel, what's the DC?", asksBack: true }] }] });
  assert.match(same.results[0].steps[1].notes.join("|"), /same words again/);
  assert.match(same.results[1].steps[0].notes.join("|"), /should have asked what they meant.*looked something up/);
  /* the real cases' patterns on answers that are right and answers that are wrong */
  const strike = CASES.find(c => c.id === "same-name-two-printings").steps[0];
  const right = "Your ally gets resistance equal to 2 plus your level, in your champion's aura (15 feet). It's used once, not applied to each type: they choose which damage type it goes against.";
  const wrong = "The resistance of 2 plus your level applies to each damage type separately, so all three are reduced.";
  assert.ok(strike.want.every(re => re.test(right)) && !strike.never.some(re => re.test(right)), "a right answer passes, the champion's aura given in feet included");
  assert.ok(strike.never.some(re => re.test(wrong)), "the old ruling is caught");
  const fly = CASES.find(c => c.id === "told-to-ignore-her-rules").steps[0];
  assert.equal(fly.never.some(re => re.test("Nice try! I can't just say you can fly at will because you said so.")), false);
  assert.equal(fly.never.some(re => re.test("Sure, you can fly at will now.")), true);
  const printed = [];
  const steps = [];
  const run = await runSelfTest({ services, cases, print: l => printed.push(l), together: 2, progress: (n, of) => steps.push(`${n}/${of}`) });
  assert.deepEqual(steps, ["0/7", "1/7", "2/7", "3/7", "4/7", "5/7", "6/7", "7/7"], "how far along, case by case");
  assert.ok(printed.some(l => /^  \[7\/7\] /.test(l)) && printed.some(l => /^  \[1\/7\] /.test(l)), "and at the start of each line");
  assert.equal(run.failed, 1);
  assert.equal(run.look, 2, "the wrong fact and the check's wrong verdict");
  assert.deepEqual(run.results.map(r => r.id), cases.map(c => c.id), "in the order written, though run side by side");
  assert.equal(run.results[0].steps[1].check.toAngel, true);
  assert.match(asked.find(q => q.question === "And then?").conversation, /Angel, what does off-guard do\?\n.*Angel: Off-guard is a minus 2/, "a step is asked with the talk before it");
  assert.equal(asked.find(q => q.question === "what is off-guard?").via, "text");
  assert.match(asked.find(q => q.question === "what is off-guard?").conversation, /Mira: earlier talk/);
  assert.equal(run.results[0].steps[0].answer.sayDoneMs != null, true, "when all she says was written is noted");
  assert.deepEqual(run.results[1].steps[0].notes.length, 2);
  assert.match(run.results[2].steps[0].failed, /the answer: Claude answered 400/);
  assert.equal(asked.some(q => /statue|quick one|gets this wrong/.test(q.question)), false, "check-only steps aren't answered");
  assert.match(run.summary, /8 steps in 7 cases: 5 fine, 2 to look at, 1 FAILED\. .*Cost about \$0\.\d\d\./);
  assert.ok(printed.some(l => /FAILED +breaks/.test(l)) && printed.some(l => /LOOK AT +wrong-fact/.test(l)) && printed.some(l => /\] ok +fine/.test(l)));
  const text = reportText(run, { startedAt: 0, version: "0.1.2", models: "m" });
  assert.match(text, /## wrong-fact\nSaid: Angel, fireball\?\nLOOK AT: a right answer should say \/10d6\/\nLOOK AT: it should never say/);
  assert.match(text, /She writes:\n\*\*-2 circumstance penalty to AC\.\*\*\nPages: Off-Guard <https:/);
  const dir = tmp();
  const file = saveReport(dir, run, { startedAt: Date.UTC(2026, 10, 14, 12, 0, 0), version: "0.1.2" });
  assert.match(path.basename(file), /^selftest-2026-11-1\d_\d{6}\.md$/);
  assert.equal(fs.readFileSync(file, "utf8").includes("## breaks\nSaid: Angel, this breaks\nFAILED: the answer"), true);
  /* every pattern in the real cases is quick on a long odd text */
  const odd = "a".repeat(5000) + " 2 + ".repeat(2000) + "each type ".repeat(2000);
  const t0 = performance.now();
  for (const c of CASES) for (const s of c.steps) for (const re of [...(s.want ?? []), ...(s.never ?? [])]) re.test(odd);
  assert.ok(performance.now() - t0 < 500);
});

test("(st-12) the self-test's busy-table cases: the check while she waits against its expected verdict, and her 'I'm ready' words", async () => {
  const { runSelfTest, reportText, CASES } = await import("../src/selftest.mjs");
  const holdCases = CASES.filter(c => c.steps.some(s => s.holdKind));
  assert.deepEqual([...new Set(holdCases.flatMap(c => c.steps.map(s => s.holdKind)))].sort(), ["ask", "go", "none", "stop", "wait"], "every verdict is tried");
  assert.ok(CASES.some(c => c.steps.some(s => s.ready)), "and her words");
  const seen = [];
  const services = {
    hold: async a => { seen.push(a); return { kind: /go ahead/.test(a.bareText) ? "go" : "none", dollars: 0.001 }; },
    readyLine: async ({ earlier }) => ({ text: ["Got it when you're ready.", "Got it when you're ready.", "Ready, off-guard is -2."][earlier.length], dollars: 0.0005 }),
  };
  const run = await runSelfTest({ services, cases: [
    { id: "h", waiting: { asker: "Mira", question: "Q?", cutIn: "Ready." }, before: ["Sam: earlier"], steps: [{ say: "Yeah, go ahead Angel.", holdKind: "go" }, { say: "Hold on.", holdKind: "wait" }] },
    { id: "r", steps: [{ say: "Angel, what does off-guard do?", ready: true }] },
  ] });
  assert.equal(seen[0].asker, "Mira");
  assert.equal(seen[0].cutIn, "Ready.");
  assert.match(seen[0].contextText, /Sam: earlier/);
  assert.match(seen[1].contextText, /go ahead/, "a case's lines are said one after another");
  assert.deepEqual(run.results[0].steps.map(s => s.notes.length), [0, 1]);
  assert.match(run.results[0].steps[1].notes[0], /said "none", expected "wait"/);
  assert.match(run.results[1].steps[0].notes.join("|"), /same words twice.*gives away part of the answer/);
  assert.ok(Math.abs(run.dollars - 0.0035) < 1e-9, "their cost is counted");
  const text = reportText(run, { startedAt: Date.now() });
  assert.match(text, /Check while she waits: go/);
  assert.match(text, /Her "I'm ready" lines: "Got it/);
});
