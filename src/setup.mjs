/* One-time setup (`npm run setup`): asks for the three keys without showing them, then logs in to Discord once to
   find the bot's server and print the link that invites it. Press Enter to keep a key that's already saved. */
import readline from "node:readline";
import { stdin, stdout } from "node:process";
import { Client, GatewayIntentBits, PermissionsBitField, OAuth2Scopes, Events } from "discord.js";
import { loadConfig, saveConfig, CONFIG_PATH } from "./config.mjs";

export const INVITE_PERMISSIONS = new PermissionsBitField([
  "ViewChannel", "SendMessages", "EmbedLinks", "ReadMessageHistory", "AddReactions", "Connect", "Speak", "UseVAD",
]).bitfield;

export function inviteUrl(appId) {
  const scopes = [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands].join("%20");
  return `https://discord.com/oauth2/authorize?client_id=${appId}&scope=${scopes}&permissions=${INVITE_PERMISSIONS}`;
}

async function run() {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
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

  const cfg = loadConfig();
  console.log("Angel setup. Nothing you paste here is shown on screen.\n");
  cfg.discordToken = (await askHidden("Discord bot token (Developer Portal → your app → Bot → Reset Token)", !!cfg.discordToken)) || cfg.discordToken;
  cfg.anthropicApiKey = (await askHidden("Claude API key (Console → API keys; the bot's own workspace)", !!cfg.anthropicApiKey)) || cfg.anthropicApiKey;
  cfg.deepgramApiKey = (await askHidden("Deepgram API key (console.deepgram.com → API Keys)", !!cfg.deepgramApiKey)) || cfg.deepgramApiKey;
  rl.close();
  saveConfig(cfg);
  console.log(`\nSaved ${CONFIG_PATH}.`);

  if (!cfg.discordToken) { console.log("No Discord token yet: run npm run setup again when you have it."); return; }
  console.log("Checking the Discord token...");
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await client.login(cfg.discordToken);
    await new Promise(r => (client.isReady() ? r() : client.once(Events.ClientReady, r)));
    const guilds = [...client.guilds.cache.values()];
    console.log(`The token works: the bot is ${client.user.tag}.`);
    if (guilds.length === 1) {
      cfg.guildId = guilds[0].id;
      saveConfig(cfg);
      console.log(`It's in one server, ${guilds[0].name}: Angel will answer there.`);
    } else if (guilds.length > 1) {
      console.log(`It's in ${guilds.length} servers (${guilds.map(g => g.name).join(", ")}). Put the one to use as "guildId" in config.json, or leave it empty to use them all.`);
    } else {
      console.log("It isn't in a server yet. Open this link, pick your server and approve:");
    }
    console.log(`\nInvite link (also adds missing permissions if you open it again):\n${inviteUrl(client.user.id)}\n`);
  } catch (e) {
    console.log(`Discord didn't accept the token: ${e.message}\nRun npm run setup again and paste it fresh (Reset Token gives a new one).`);
  } finally {
    client.destroy();
  }
  console.log("Next: npm run check (tests every key), then npm start.");
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("src/setup.mjs")) run();
