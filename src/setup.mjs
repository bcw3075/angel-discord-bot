/* One-time setup (`npm run setup`): asks for the three keys without showing them, then logs in to Discord once to
   find the bot's server and print the link that invites it. Press Enter to keep a key that's already saved. */
import readline from "node:readline";
import { stdin, stdout } from "node:process";
import { Client, GatewayIntentBits, PermissionsBitField, OAuth2Scopes, Events } from "discord.js";
import { loadConfig, saveConfig, keyLooksWrong, keyCertainlyWrong, pasteSummary, CONFIG_PATH } from "./config.mjs";

export const INVITE_PERMISSIONS = new PermissionsBitField([
  "ViewChannel", "SendMessages", "EmbedLinks", "ReadMessageHistory", "AddReactions", "Connect", "Speak", "UseVAD",
]).bitfield;

/* a promise that gives up after ms with a plain reason (Discord's login has no limit of its own) */
export function within(ms, promise, reason) {
  let timer;
  /* not unref'd: a hung login with nothing else running must still end with this reason, not a silent exit */
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/* Discord turned the token down (rather than not being reachable) */
export const tokenRefused = e => e?.code === "TokenInvalid" || /invalid token/i.test(e?.message ?? "");

/* one key question. A key that looks wrong (two pastes on the same hidden line, a space, the wrong question) is not
   saved: she's asked again, and Enter keeps the old one. The same odd-looking key pasted twice in a row is saved,
   so a format check that's wrong for a new kind of key can't lock her out (never one that can't be a key at all). Rhea hit this 2026-11-14: a first token
   pasted without Enter, then a new one after Reset Token, went in as one long token. */
export async function askKey(cfg, key, question, askHidden, say) {
  let last = "", refused = false;
  for (;;) {
    const given = await askHidden(question, !!cfg[key]);
    if (!given) {
      if (cfg[key]) say(`  Kept: ${pasteSummary(cfg[key])}.`);
      else if (refused) say("  Nothing saved for this key.");
      return;
    }
    const wrong = keyLooksWrong(key, given);
    if (!wrong || (given === last && !keyCertainlyWrong(key, given))) {
      cfg[key] = given;
      say(`  Got it: ${pasteSummary(given)}.${wrong ? " Saved as you pasted it twice; npm run check will test it." : ""}`);
      return;
    }
    say(`  That doesn't look right (${pasteSummary(given)}): ${wrong}. Not saved.`);
    say(keyCertainlyWrong(key, given)
      ? "  Copy it fresh and paste it again (it replaces everything), or press Enter to skip."
      : "  Paste it again (it replaces everything), paste the same one again to save it anyway, or press Enter to skip.");
    last = given; refused = true;
  }
}

export function inviteUrl(appId) {
  const scopes = [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands].join("%20");
  return `https://discord.com/oauth2/authorize?client_id=${appId}&scope=${scopes}&permissions=${INVITE_PERMISSIONS}`;
}

async function run() {
  let cfg;
  try { cfg = loadConfig(); }
  catch (e) { console.log(e.message); process.exitCode = 1; return; }
  if (!stdin.isTTY) console.log("This window may show what you paste. If it does, close it and use Command Prompt (type cmd in File Explorer's address bar).\n");
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
  /* Ctrl+C means stop: nothing is saved */
  rl.on("SIGINT", () => { stdout.write("\nSetup stopped. Nothing was changed.\n"); process.exit(130); });
  let muted = false;
  /* the classic readline lets us silence its echo for secret answers (the bridge's setup does the same) */
  rl._writeToOutput = str => { if (!muted) stdout.write(str); };
  /* lines are queued as they come, so a paste of several lines at once (or piped input) loses none */
  const queued = [];
  let waiting = null, closed = false;
  rl.on("line", line => { if (waiting) { const w = waiting; waiting = null; w(line); } else queued.push(line); });
  rl.on("close", () => { closed = true; if (waiting) { const w = waiting; waiting = null; w(""); } });
  const nextLine = () => (queued.length ? Promise.resolve(queued.shift()) : closed ? Promise.resolve("") : new Promise(r => { waiting = r; }));
  const askHidden = async (q, have) => {
    stdout.write(`${q}${have ? " (saved; press Enter to keep it)" : ""}: `);
    muted = true;
    try { return (await nextLine()).trim(); } finally { muted = false; stdout.write("\n"); }
  };

  console.log("Angel setup. The keys you paste aren't shown on screen; after each one you see its start, end and length.\n");
  const ask = (key, question) => askKey(cfg, key, question, askHidden, line => console.log(line));
  await ask("discordToken", "Discord bot token (Developer Portal → your app → Bot → Reset Token)");
  await ask("anthropicApiKey", "Claude API key (Console → API keys; the bot's own workspace)");
  await ask("deepgramApiKey", "Deepgram API key (console.deepgram.com → API Keys)");
  rl.close();
  saveConfig(cfg);
  console.log(`\nSaved ${CONFIG_PATH}.`);

  /* a failed or missing Discord check exits 1, so Install Angel.cmd stops there instead of pointing at a link it never got */
  if (!cfg.discordToken) { console.log("No Discord token yet: run npm run setup again when you have it."); process.exitCode = 1; return; }
  console.log("Checking the Discord token...");
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    const ready = new Promise(r => client.once(Events.ClientReady, r));
    await within(30000, client.login(cfg.discordToken).then(() => ready),
      "Discord didn't answer within 30 seconds (a VPN or firewall can block it)");
    const guilds = [...client.guilds.cache.values()];
    console.log(`The token works: the bot is ${client.user.tag}.`);
    if (guilds.length === 1) {
      cfg.guildId = guilds[0].id;
      saveConfig(cfg);
      console.log(`It's in one server, ${guilds[0].name}: Angel will answer there.`);
    } else if (guilds.length > 1) {
      console.log(`It's in ${guilds.length} servers (${guilds.map(g => g.name).join(", ")}). Put the one to use as "guildId" in config.json, or leave it empty to use them all.`);
    } else {
      console.log("It isn't in a server yet. Open this link, pick your server and approve. Then run npm run setup once more,\n"
        + "pressing Enter at each question to keep the keys: it saves your server, so Angel answers only there.");
    }
    console.log(`\nInvite link (also adds missing permissions if you open it again):\n${inviteUrl(client.user.id)}\n`);
  } catch (e) {
    process.exitCode = 1;
    if (tokenRefused(e)) console.log(`Discord didn't accept the token: ${e.message}\nRun npm run setup again and paste it fresh (Reset Token gives a new one).`);
    else console.log(`Couldn't check the token with Discord: ${e.message}\nYour keys are saved. Check the internet connection and run npm run setup again.`);
  } finally {
    client.destroy();
  }
  console.log("Next: npm run check (tests every key), then npm start.");
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("src/setup.mjs")) {
  run().catch(e => { console.log(`Setup failed: ${e.message}`); process.exitCode = 1; });
}
