/* Angel's entry point (`npm start`): reads config.json, builds the services and starts the Discord bot. */
import { loadConfig, missingSettings, ensureDataDir } from "./config.mjs";
import { initLog, log } from "./log.mjs";
import { buildServices } from "./services.mjs";
import { AngelBot } from "./bot.mjs";

async function main() {
  let cfg;
  try { cfg = loadConfig(); }
  catch (e) {
    console.error(e.message);
    process.exit(2); /* needs fixing by hand: Start Angel.cmd stops instead of restarting */
  }
  ensureDataDir();
  initLog(cfg);
  const missing = missingSettings(cfg);
  if (missing.length) {
    log.error(`Angel can't start yet: missing ${missing.join(", ")}. Run: npm run setup`);
    process.exit(2); /* 2 = needs setup: Start Angel.cmd stops instead of restarting */
  }
  const services = buildServices(cfg);
  const bot = new AngelBot({ cfg, log, services });
  let stopping = false;
  const shutdown = async sig => {
    if (stopping) process.exit(0); /* a second Ctrl+C quits at once */
    stopping = true;
    log.info(`${sig}: ending sessions and logging out (Ctrl+C again to quit at once)`);
    const limit = new Promise(r => setTimeout(r, 5000).unref());
    try { await Promise.race([bot.stop(), limit]); } finally { services.aon.flush(); process.exit(0); }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", e => log.error("unhandled:", e));
  process.on("uncaughtException", e => { log.error("crashed:", e); process.exit(1); });
  try { await bot.start(); }
  catch (e) {
    const tokenProblem = /token/i.test(e.message);
    log.error(tokenProblem ? `Discord refused the bot token (${e.message}). Run npm run setup and paste it again.` : `Couldn't start: ${e.message}`);
    process.exit(tokenProblem ? 2 : 1);
  }
  log.info("Angel is running. Leave this window open; Ctrl+C stops her.");
}

main();
