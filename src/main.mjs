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
  /* 3 = stopped on purpose: Start Angel.cmd ends instead of restarting her */
  const shutdown = async sig => {
    /* the day's spending first: closing the window gives only a few seconds before Windows ends the process */
    try { bot.bookLive(); } catch { /* still stopping */ }
    if (stopping) { services.aon.flush(); process.exit(3); } /* a second Ctrl+C quits at once */
    stopping = true;
    log.info(`${sig}: ending sessions and logging out (Ctrl+C again to quit at once)`);
    const limit = new Promise(r => setTimeout(r, 4000).unref());
    try { await Promise.race([bot.stop(), limit]); } finally { services.aon.flush(); process.exit(3); }
  };
  /* Ctrl+C, closing the window (SIGHUP on Windows, about 10 s before the process is killed) and Ctrl+Break */
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(sig, () => shutdown(sig));
  process.on("unhandledRejection", e => log.error("unhandled:", e));
  process.on("uncaughtException", e => {
    log.error("crashed:", e);
    /* keep the day's spending before the restart */
    try { bot.bookLive(); services.aon.flush(); } catch { /* exiting anyway */ }
    process.exit(1);
  });
  try { await bot.start(); }
  catch (e) {
    const tokenProblem = /token/i.test(e.message);
    log.error(tokenProblem ? `Discord refused the bot token (${e.message}). Run npm run setup and paste it again.` : `Couldn't start: ${e.message}`);
    process.exit(tokenProblem ? 2 : 1);
  }
  log.info("Angel is running. Leave this window open; Ctrl+C stops her.");
}

main();
