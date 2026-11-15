---
feature: answering
files: [src/answer.mjs, src/claude.mjs, src/aon.mjs]
functions: []
dependsOn: []
since: 0.1.0
---
Answering: Claude with the conversation, the house rules and Archives of Nethys lookups, finishing with what to say and the pages used.

## Decisions
- **The last round never forces the answer tool**: it offers only that tool and adds "give your answer now" (live 2026-11-14: a long Retributive Strike question reached the last round and Sonnet 5.5 refused `tool_choice` type tool with a 400, so she said "couldn't reach my rules brain").
- **Rules come from Archives of Nethys**, through the public search index its own site uses, not Claude's web search: exact, fast, free, and the owner's standing rule is AoN for every rules lookup. Remaster entries win; an old name is mentioned once. (Angel's choice, 2026-11-12.)
- **House rules now** (the owner, 2026-11-12, d-4; the other choices were rules only, or house rules and the party's sheets): `house-rules.md`, player-safe, wins over AoN. The party's sheets and campaign facts are phase 2.
- **Spoken short, written in full with links** (d-1 as changed by Rhea at the live test, 2026-11-14: "perhaps you should be a bit shorter on the voice response? I won't mind a little back and forth"; it was "explain the answer in full" aloud): the `answer` tool gives `say` (one to three short spoken sentences, mentioning anything more so they can ask), `details` (formatted for Discord at Rhea's ask, 2026-11-14, "your text replies are a bit wordy and a wall of text... use formatting": a bold one-line answer, two to five short bullets with the key terms and numbers in bold, an optional *GM's call:* line, under about 600 characters) and `sources`. `say` is spoken and goes in the transcript; the typed copy is `details` (or `say` when there's none) with who asked and the links.
- **The answering prompt is cached for an hour** (`answerCacheTtl: "1h"`, checked against the pricing and caching docs 2026-11-13). Questions at a table are often more than 5 minutes apart, so the 5-minute cache would be written again for most of them. A 1-hour write costs 2× the input price instead of 1.25×, but every question inside the hour reads the prompt at a twentieth of the price and starts the hour again. For a session of about 20 questions, with the prompt about 6,000 tokens: about 30 cents in writes on the 5-minute cache, about 4 cents on the 1-hour one. `"5m"` switches back.
- Angel's voice in the prompt: warm, quick, a little sassy, tells someone kindly when they have a rule wrong, never overrules the GM, says when something is the GM's call, never invents a rule. Everything she says is heard by players, so only rules, house rules and the table's own words are used.

## How it works
- `answerQuestion`: up to six rounds of tool use (`aon_search`, `aon_get`), then `tool_choice` forces `answer`. A plain-text reply is taken as the answer. A failed lookup is told to Claude as the tool result. When a round fails, the error carries what the rounds before it cost (`dollars`). Only `https://2e.aonprd.com/` links are kept as sources; with none given, the pages read with `aon_get` are listed. The system prompt is cached (`cache_control` on the system block, which also covers the tools).
- `search` (in `aon.mjs`): `match_phrase` and fuzzy `match` on `name`, `match` on `text`, reprints hidden with `exclude_from_search`, a category filter; then entries with `remaster_id` are swapped for their Remaster version (one `ids` query), with `oldName` only when the category is the same. `get` takes an id (`ids` query) or a page link (`term` on `url`). Results are cached in memory and in `data/aon-cache.json` for 7 days (at most 200 entries, long texts cut before caching and marked `_cut`, so an entry whose spaces shrink it under the limit after the cut is still called cut, the file written a few seconds after the last lookup and at shutdown, not at each one; review L4); a named User-Agent is sent.
- `cost` (in `claude.mjs`): each call's price from its `usage`. Cache writes are split into 5-minute and 1-hour ones (`usage.cache_creation`), priced 1.25× and 2× the input price (a fifth price in the table overrides the 2×); without the split every write counts at the dearer rate, and a model with no price (one she typed in) counts at the dearest known price, so the caps never undercount. `answerQuestion` also returns the cache tokens written and read, which `npm run ask` prints.
- `create` (in `claude.mjs`): plain fetch to the Messages API with a 45-second limit; retries 429, 529, 5xx and network failures (twice, honouring `retry-after`), but never a timed-out call (it may have run and been billed; review L8); `cost(model, usage)` from the price table (fresh input, 5-minute cache write, cache read, output).
- `typedAnswer` keeps the message under 2,000 characters and wraps links in `<…>` so Discord shows no previews.

## Checks
- (an-1) {live} `npm run ask` with ten real rules questions the owner picks: the right rule, Remaster names, working AoN links, "the GM's call" for judgment calls; the time and cost of each noted.
- (an-2) {live} in a session, describing a situation and then asking "Angel, what's the ruling on this?" gets an answer about that situation.
- (an-3) {live} a rule written in `house-rules.md` wins over AoN in an answer about it.
- (an-4) {unit} the tool loop, forced answer, sources, a failed lookup, the prompt, the typed copy, the cache's cut texts, the Claude client, pricing the two kinds of cache write, and the 1-hour cache setting reaching every answering call (`test/answer.test.mjs`, `test/aon.test.mjs`).
- (an-5) {live} `npm run test:aon` passes against the real Archives of Nethys (runs from the cloud workspace too).

## Traps
- The AoN index answers `_mapping` with a permissions error for anonymous users; field types were found by probing: `url` and `category` are keywords (`term` works), the `id` field is not (use an `ids` query on `_id`).
- A legacy entry's `remaster_id` can point to a different kind of entry (an old class feature now inside its class page): hence `oldName` only for the same category.

## Open items
- Phase 2 (design doc): the party's sheets through the bridge, player-safe campaign facts, answers only the GM sees.
