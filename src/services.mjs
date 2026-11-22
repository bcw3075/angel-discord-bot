/* The services Angel's sessions use, built from config.json: Claude, Archives of Nethys, Deepgram's listening and
   voice, the "was that for me?" check and the answering. One place, so the bot and `npm run check` use the same wiring. */
import path from "node:path";
import { readHouseRules, readKeyterms, DATA_DIR } from "./config.mjs";
import { Claude } from "./claude.mjs";
import { Aon } from "./aon.mjs";
import { transcribe } from "./stt.mjs";
import { synthesize, chunkText } from "./tts.mjs";
import { gate, holdCheck, readyLine } from "./wake.mjs";
import { answerQuestion, systemPrompt } from "./answer.mjs";

/* the table's key terms plus the names of the people heard this session: short names only, no repeats, within
   Deepgram's limit (the file's terms first, so a crowd of names never pushes them out) */
export function withNames(keyterms, names = [], max = 100) {
  const seen = new Set(keyterms.map(t => t.toLowerCase()));
  const extra = [];
  for (const n of names) {
    const t = String(n ?? "").trim();
    if (!t || t.length > 40 || !/[a-z]/i.test(t) || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase()); extra.push(t);
  }
  return [...keyterms, ...extra].slice(0, max);
}

export function buildServices(cfg, { fetchImpl = fetch, dataDir = DATA_DIR } = {}) {
  const claude = new Claude({ apiKey: cfg.anthropicApiKey, prices: cfg.prices, fetchImpl });
  const aon = new Aon({ userAgent: cfg.aonUserAgent, fetchImpl, cacheFile: path.join(dataDir, "aon-cache.json") });
  /* each table's key terms (0.2.0): a session passes its table's list; without one, the files beside the code */
  const keyterms = readKeyterms();
  return {
    claude, aon,
    keytermCount: keyterms.length,
    keytermsOf: table => (table?.files ? readKeyterms(table.files.keyterms) : keyterms),
    stt: (wav, { names = [], terms = keyterms } = {}) => transcribe(wav, { apiKey: cfg.deepgramApiKey, model: cfg.sttModel, keyterms: withNames(terms, names), fetchImpl }),
    tts: async text => {
      const clips = [];
      for (const piece of chunkText(text)) clips.push(await synthesize(piece, { apiKey: cfg.deepgramApiKey, voice: cfg.ttsVoice, format: "ogg", fetchImpl }));
      return clips;
    },
    gate: ({ contextText, lastText, bareText, replying }) => gate({ claude, model: cfg.gateModel, contextText, lastText, bareText, replying }),
    /* a busy table (0.1.3): what a line said while she holds an answer means, and her own "I'm ready" words */
    hold: ({ contextText, lastText, bareText, asker, question, cutIn, ready }) => holdCheck({ claude, model: cfg.gateModel, contextText, lastText, bareText, asker, question, cutIn, ready }),
    readyLine: ({ question, asker, earlier }) => readyLine({ claude, model: cfg.gateModel, question, asker, earlier }),
    /* house rules are read for each question, so an edit to house-rules.md counts at once; the asking table's own
       (0.2.0), never another table's */
    answer: ({ conversation, question, asker, via, gmName, onSay, meaning, lastReply, table = null }) => answerQuestion({
      /* at least 3,000: her thinking counts toward the limit, and 1,500 (the default until 0.1.2, still in saved configs)
         can run out before the answer is written. The limit is room, not cost: only what she writes is paid for. */
      claude, aon, model: cfg.answerModel, maxTokens: Math.max(cfg.maxAnswerTokens, 3000), cacheTtl: cfg.answerCacheTtl,
      system: systemPrompt({ houseRules: table?.files ? readHouseRules(table.files.houseRules) : readHouseRules(), gmName }),
      conversation, question, asker, via, onSay, meaning, lastReply,
    }),
  };
}
