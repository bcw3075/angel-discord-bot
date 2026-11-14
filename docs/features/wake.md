---
feature: wake
files: [src/wake.mjs]
functions: []
dependsOn: []
since: 0.1.0
---
Knowing when someone is talking to Angel: a free text check for her name, then a cheap model decides.

## Decisions
- The check also says whether a line is small talk (`chat`), and counts a reply to what she just said as said to her even without her name (2026-11-14, for the back and forth Rhea asked for).
- Two steps (Angel's design, 2026-11-12): a line is looked at only when it names her or a word the transcriber makes of her name (Angela, Angie, angle and the like); then Haiku 5.5 reads the last few lines and decides. An angel in the story (a creature, "angelic", a statue) or talk about her doesn't set her off.
- "Angel, stop" (and "be quiet", "that's enough", "never mind" …) acts at once, without the model, but only when her name comes first and at most three words follow the stop word; "Angel, never mind that, how does flanking work?" or "the angel, quiet as death, ..." go through the model check instead (review M3, 2026-11-13).
- "Angel?" with the question still to come waits up to `followUpMs` (12 s) for the same speaker's next line.

## How it works
- `mentionsAngel` and `isStopRequest` are regular expressions; plurals and "angelic" don't match, "Angel's" does. A stop is her name at the start (after an optional "hey", "okay", "so" or "um"), a stop word, and at most three words after it, in a line of at most 120 characters.
- `gate` sends the system prompt and "Earlier lines … LAST line …" (the line with its speaker, `lastText`) and expects `{"to_angel", "complete", "stop", "question"}`; `parseGate` reads it even inside a code fence. If the reply can't be read, or Claude can't be reached, the fallback is the plain rule on what was said (`bareText`, without the speaker's name): her name first, then a request. The session logs the failure.
- Each call returns its own cost (`dollars`), worked out from that call's usage.

## Checks
- (wk-1) {live} in play, "Angel, ..." questions are answered, and at least five in-game uses of "angel" or "angelic" and the word "angle" get no answer.
- (wk-2) {live} "Angel?" followed by the question as its own sentence gets one answer.
- (wk-3) {unit} names, stop phrases (and what is not a stop), reading the model's reply, the fallback on the bare words when the model can't be reached, and every text reader (these, `typedQuestion`, `speakable`) staying fast on 4,000 characters of odd text (`test/wake.test.mjs`).

## Traps
- The fallback once read the speaker-prefixed line ("Mira: Angel, ...") and so never matched: every spoken question was lost whenever the check failed (review M1, 2026-11-13). Hence `bareText`, and a test with the prefix.
- The first stop pattern let "anything, then a stop word" match in many ways: a 60-word line took 1.3 s, and the whole bot (every speaker, the voice) waits while a regex runs (second review, 2026-11-13). It now matches only at the start and counts the words after with plain code, and the fallback reads only the first 300 characters. A new pattern gets a line in the timing test.
- The system prompt is too short for Haiku's prompt cache to take; the `cache_control` mark is harmless and costs nothing.

## Open items
