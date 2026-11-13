---
feature: wake
files: [src/wake.mjs]
functions: []
dependsOn: []
since: 0.1.0
---
Knowing when someone is talking to Angel: a free text check for her name, then a cheap model decides.

## Decisions
- Two steps (Angel's design, 2026-11-12): a line is looked at only when it names her or a word the transcriber makes of her name (Angela, Angie, angle and the like); then Haiku 5.5 reads the last few lines and decides. An angel in the story (a creature, "angelic", a statue) or talk about her doesn't set her off.
- "Angel, stop" (and "be quiet", "that's enough", "never mind" …) acts at once, without the model.
- "Angel?" with the question still to come waits up to `followUpMs` (12 s) for the same speaker's next line.

## How it works
- `mentionsAngel` and `isStopRequest` are regular expressions; plurals and "angelic" don't match, "Angel's" does.
- `gate` sends the system prompt and "Earlier lines … LAST line …" and expects `{"to_angel", "complete", "stop", "question"}`; `parseGate` reads it even inside a code fence. If the reply can't be read, or Claude can't be reached, the fallback is the plain rule: her name first, then a request.
- Each call returns its own cost (`dollars`), worked out from that call's usage.

## Checks
- (wk-1) {live} in play, "Angel, ..." questions are answered, and at least five in-game uses of "angel" or "angelic" and the word "angle" get no answer.
- (wk-2) {live} "Angel?" followed by the question as its own sentence gets one answer.
- (wk-3) {unit} names, stop phrases, reading the model's reply and the fallback (`test/wake.test.mjs`).

## Traps
- The system prompt is too short for Haiku's prompt cache to take; the `cache_control` mark is harmless and costs nothing.

## Open items
