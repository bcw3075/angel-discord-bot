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
    gate: ({ contextText, lastText, bareText }) => gate({ claude, model: cfg.gateModel, contextText, lastText, bareText }),
    /* house rules are read for each question, so an edit to house-rules.md counts at once */
    answer: ({ conversation, question, asker, via, gmName }) => answerQuestion({
      claude, aon, model: cfg.answerModel, maxTokens: cfg.maxAnswerTokens,
      system: systemPrompt({ houseRules: readHouseRules(), gmName }),
      conversation, question, asker, via,
    }),
  };
}
