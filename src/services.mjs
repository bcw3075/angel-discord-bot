/* The services Angel's sessions use, built from config.json: Claude, Archives of Nethys, Deepgram's listening and
   voice, the "was that for me?" check and the answering. One place, so the bot and `npm run check` use the same wiring. */
import path from "node:path";
import { readHouseRules, readKeyterms, DATA_DIR } from "./config.mjs";
import { Claude } from "./claude.mjs";
import { Aon } from "./aon.mjs";
import { transcribe } from "./stt.mjs";
import { synthesize, chunkText } from "./tts.mjs";
import { gate } from "./wake.mjs";
import { answerQuestion, systemPrompt } from "./answer.mjs";

export function buildServices(cfg, { fetchImpl = fetch, dataDir = DATA_DIR } = {}) {
  const claude = new Claude({ apiKey: cfg.anthropicApiKey, prices: cfg.prices, fetchImpl });
  const aon = new Aon({ userAgent: cfg.aonUserAgent, fetchImpl, cacheFile: path.join(dataDir, "aon-cache.json") });
  const keyterms = readKeyterms();
  return {
    claude, aon,
    keytermCount: keyterms.length,
    stt: wav => transcribe(wav, { apiKey: cfg.deepgramApiKey, model: cfg.sttModel, keyterms, fetchImpl }),
    tts: async text => {
      const clips = [];
      for (const piece of chunkText(text)) clips.push(await synthesize(piece, { apiKey: cfg.deepgramApiKey, voice: cfg.ttsVoice, format: "ogg", fetchImpl }));
      return clips;
    },
    gate: ({ contextText, lastText, bareText, replying }) => gate({ claude, model: cfg.gateModel, contextText, lastText, bareText, replying }),
    /* house rules are read for each question, so an edit to house-rules.md counts at once */
    answer: ({ conversation, question, asker, via, gmName, onSay, meaning }) => answerQuestion({
      /* at least 3,000: her thinking counts toward the limit, and 1,500 (the default until 0.1.2, still in saved configs)
         can run out before the answer is written. The limit is room, not cost: only what she writes is paid for. */
      claude, aon, model: cfg.answerModel, maxTokens: Math.max(cfg.maxAnswerTokens, 3000), cacheTtl: cfg.answerCacheTtl,
      system: systemPrompt({ houseRules: readHouseRules(), gmName }),
      conversation, question, asker, via, onSay, meaning,
    }),
  };
}
