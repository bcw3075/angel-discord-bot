/* `npm run check`: tests every key and service on this PC and says plainly what works. Nothing is posted anywhere.
   - Claude: one tiny question to the check model.
   - Deepgram: Angel's voice says a sentence (saved as data/check/angel-voice.wav so you can hear it), the same
     sentence is made in the form Discord plays (Ogg Opus) and read back packet by packet, and the listening
     service transcribes the WAV: if it hears the sentence, both halves work.
   - Archives of Nethys: one search.
   - Discord: the token, the servers, and the Message Content intent.
   `npm run voices` instead saves a short sample of several voices in data/voices/ to choose from. */
import fs from "node:fs";
import path from "node:path";
import { Client, GatewayIntentBits, Events } from "discord.js";
import { loadConfig, ensureDataDir, tableFilesReport, fixFor, DATA_DIR } from "./config.mjs";
import { Claude } from "./claude.mjs";
import { Aon } from "./aon.mjs";
import { transcribe } from "./stt.mjs";
import { synthesize, oggPackets } from "./tts.mjs";
import { createDecoder, decodePackets } from "./audio.mjs";
import { inviteUrl, within } from "./setup.mjs";
import { buildServices } from "./services.mjs";
import { isIntentRefusal } from "./bot.mjs";

export const VOICES = ["aura-2-thalia-en", "aura-2-andromeda-en", "aura-2-helena-en", "aura-2-luna-en", "aura-2-athena-en", "aura-2-cora-en", "aura-2-electra-en", "aura-2-asteria-en"];
const SAMPLE = "Hi, I'm Angel. Grab your dice: the rules say you're off-guard, so that's a minus two to your armor class.";

const ok = (what, more = "") => console.log(`  OK    ${what}${more ? ": " + more : ""}`);
const note = (what, more) => console.log(`  NOTE  ${what}: ${more}`);
/* a FAIL line, and on the next line what to do about it when the reason is a known one */
const bad = (what, why) => {
  console.log(`  FAIL  ${what}: ${why}`);
  const fix = fixFor(what.split(" ")[0], why);
  if (fix) console.log(`        → ${fix}`);
  failures++;
};
let failures = 0;

async function check(cfg) {
  const dir = ensureDataDir(path.join(DATA_DIR, "check"));
  console.log("Checking Angel's setup...\n");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 12)) ok("Node.js", process.versions.node);
  else bad("Node.js", `${process.versions.node} is too old; install the current LTS from nodejs.org (22.12 or newer)`);
  for (const line of tableFilesReport()) (line.level === "ok" ? ok : line.level === "fail" ? bad : note)(line.what, line.text);

  if (!cfg.anthropicApiKey) bad("Claude", "no key saved (npm run setup)");
  else {
    try {
      const claude = new Claude({ apiKey: cfg.anthropicApiKey, prices: cfg.prices });
      const r = await claude.create({ model: cfg.gateModel, max_tokens: 5, messages: [{ role: "user", content: "Reply with the single word: ok" }] });
      ok("Claude", `${cfg.gateModel} answered "${(r.content ?? []).map(b => b.text ?? "").join("").trim()}"`);
      await claude.create({ model: cfg.answerModel, max_tokens: 5, messages: [{ role: "user", content: "Reply with the single word: ok" }] });
      ok("Claude", `${cfg.answerModel} answered too (both cost well under a cent)`);
    } catch (e) { bad("Claude", e.message); }
  }

  if (!cfg.deepgramApiKey) bad("Deepgram", "no key saved (npm run setup)");
  else {
    try {
      const wav = await synthesize(SAMPLE, { apiKey: cfg.deepgramApiKey, voice: cfg.ttsVoice, format: "wav" });
      fs.writeFileSync(path.join(dir, "angel-voice.wav"), wav);
      ok("Deepgram voice", `${cfg.ttsVoice}; hear it: data\\check\\angel-voice.wav`);
      const ogg = await synthesize(SAMPLE, { apiKey: cfg.deepgramApiKey, voice: cfg.ttsVoice, format: "ogg" });
      fs.writeFileSync(path.join(dir, "angel-voice.ogg"), ogg);
      const packets = oggPackets(ogg);
      if (packets[0]?.toString("latin1", 0, 8) !== "OpusHead") throw new Error("the Ogg clip has no OpusHead");
      const audio = packets.slice(2);
      const decoder = createDecoder();
      const { pcm, bad: rejected } = decodePackets(decoder, audio);
      decoder.delete();
      if (!audio.length || rejected > audio.length / 10) throw new Error(`${rejected} of ${audio.length} packets didn't decode`);
      ok("Deepgram voice for Discord", `${audio.length} Opus packets (${(pcm.length / 2 / 48000).toFixed(1)} s), all readable`);
      const heard = await transcribe(wav, { apiKey: cfg.deepgramApiKey, model: cfg.sttModel, keyterms: ["Angel"] });
      const found = ["angel", "dice", "guard", "armor"].filter(w => heard.text.toLowerCase().includes(w));
      if (found.length < 3) bad("Deepgram listening", `heard "${heard.text}"`);
      else ok("Deepgram listening", `heard "${heard.text}"`);
    } catch (e) { bad("Deepgram", e.message); }
  }

  try {
    const aon = new Aon({ userAgent: cfg.aonUserAgent });
    const [hit] = await aon.search("flat-footed");
    if (hit?.name === "Off-Guard") ok("Archives of Nethys", `"flat-footed" found ${hit.name} (${hit.source})`);
    else bad("Archives of Nethys", `unexpected first result ${hit?.name ?? "(none)"}`);
  } catch (e) { bad("Archives of Nethys", e.message); }

  if (!cfg.discordToken) bad("Discord", "no token saved (npm run setup)");
  else {
    let client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
    let content = true;
    const loginReady = c => {
      const ready = new Promise(r => c.once(Events.ClientReady, r));
      return within(30000, c.login(cfg.discordToken).then(() => ready), "Discord didn't answer within 30 seconds (a VPN or firewall can block it)");
    };
    try {
      try { await loginReady(client); }
      catch (e) {
        if (!isIntentRefusal(e)) throw e;
        content = false;
        client.destroy();
        client = new Client({ intents: [GatewayIntentBits.Guilds] });
        await loginReady(client);
      }
      const guilds = [...client.guilds.cache.values()];
      ok("Discord", `logged in as ${client.user.tag}; in ${guilds.map(g => g.name).join(", ") || "no server yet"}`);
      if (!guilds.length) bad("Discord server", `invite the bot: ${inviteUrl(client.user.id)}`);
      if (content) ok("Discord Message Content intent", 'on (typed "Angel, ..." works)');
      else bad("Discord Message Content intent", "off: Developer Portal → Bot → Privileged Gateway Intents → Message Content");
    } catch (e) { bad("Discord", e.message); }
    finally { client.destroy(); }
  }

  console.log(failures ? `\n${failures} problem${failures === 1 ? "" : "s"} above.` : "\nEverything works. Start Angel with npm start (or Start Angel.cmd).");
}

async function voices(cfg) {
  if (!cfg.deepgramApiKey) { console.log("Save the Deepgram key first: npm run setup"); return; }
  const dir = ensureDataDir(path.join(DATA_DIR, "voices"));
  console.log(`Saving samples in ${dir} ...`);
  for (const v of VOICES) {
    try {
      fs.writeFileSync(path.join(dir, `${v}.mp3`), await synthesize(SAMPLE, { apiKey: cfg.deepgramApiKey, voice: v, format: "mp3" }));
      console.log(`  ${v}.mp3`);
    } catch (e) { console.log(`  ${v}: ${e.message}`); }
  }
  console.log(`\nNow: ${cfg.ttsVoice}. To change it, put the one you like as "ttsVoice" in config.json (e.g. "aura-2-luna-en") and restart Angel.`);
}

/* `npm run ask -- "can I grapple with a shield in my hand?"`: one question through the real answering, without
   Discord, to judge Angel's answers and what they cost. */
async function ask(cfg, question) {
  if (!question) { console.log('Put the question after it: npm run ask -- "what does off-guard do?"'); return; }
  if (!cfg.anthropicApiKey) { console.log("Save the Claude key first: npm run setup"); failures++; return; }
  const services = buildServices(cfg);
  const started = Date.now();
  const r = await services.answer({ conversation: "", question, asker: "The GM", via: "text", gmName: "" });
  console.log(`\n${r.say}\n`);
  for (const s of r.sources) console.log(`  ${s.name}: ${s.url}`);
  console.log(`\n${((Date.now() - started) / 1000).toFixed(1)} s, ${r.lookups} lookup${r.lookups === 1 ? "" : "s"}, about $${r.dollars.toFixed(3)} (${cfg.answerModel}).`);
  /* a second question within the hour should read the prompt from the cache rather than write it again */
  console.log(`Prompt cache (${cfg.answerCacheTtl}): ${r.cache.written} tokens written, ${r.cache.read} read.`);
}

let cfg;
try { cfg = loadConfig(); }
catch (e) { console.log(e.message); process.exit(1); }
const askAt = process.argv.indexOf("--ask");
const job = askAt >= 0 ? ask(cfg, process.argv.slice(askAt + 1).join(" ").trim()) : process.argv.includes("--voices") ? voices(cfg) : check(cfg);
job.catch(e => { console.log(`Failed: ${e.message}`); failures++; }).then(() => process.exit(failures ? 1 : 0));
