---
feature: wake
files: [src/wake.mjs]
functions: []
dependsOn: []
since: 0.1.0
---
Knowing when someone is talking to Angel: a free text check for her name, then a cheap model decides.

## Decisions
- **The check has its own limits** (full code check, 2026-11-14): 8 seconds (a call that runs out of time is never sent again) and one more try after at most 1.5 s when the server is busy, not an answer's 45 seconds and two (the table is waiting on it); room for 600 tokens and a rewrite of at most 40 words (it wrote the whole question back: 200 tokens cut a long one off, and in the first self-test run 400 still cut off a 900-character one), leaving JSON that couldn't be read; a reply cut off at the limit, or one that can't be read, is said in the log, and the plain rule decides.
- **A follow-up has its own check** (`FOLLOWUP_SYSTEM`, 2026-11-14: even with the note, the general check judged "Okay. What about stacking?" not for her, 19:14): for the person she just answered, it leans to yes and says no only for a line plainly for someone else or a bare acknowledgement.
- **Her quick reaction** comes from the check (`ack`: three to ten words in her voice about this question, different each time), replacing the fixed "One sec, let me check" (Rhea, 2026-11-14: "getting repetitive. I'd love your personality to come through... I'm ok with using more tokens"). Typed questions and failed checks use one of a few varied lines (`ACKS`); `ackPhrase: ""` still turns it off.
- A follow-up that starts with an acknowledgement and then asks something is for her; only a bare "okay"/"thanks" isn't. A reply without her name is sent to the check with a note that she just answered this person (2026-11-14: "Okay. Good. What about stacking with other penalties or bonuses?" was judged not for her).
- The check also says whether a line is small talk (`chat`), and counts a reply to what she just said as said to her even without her name (2026-11-14, for the back and forth Rhea asked for).
- Two steps (Angel's design, 2026-11-12): a line is looked at only when it names her or a word the transcriber makes of her name (Angela, Angie, angle and the like); then Haiku 5.5 reads the last few lines and decides. An angel in the story (a creature, "angelic", a statue) or talk about her doesn't set her off.
- "Angel, stop" (and "be quiet", "that's enough", "never mind" …) acts at once, without the model, but only when her name comes first and at most three words follow the stop word; "Angel, never mind that, how does flanking work?" or "the angel, quiet as death, ..." go through the model check instead (review M3, 2026-11-13). The model check says stop only when they plainly tell her to stop or that they don't want the answer; a remark about being cut off, interrupted or misheard is not one (live 2026-11-15: "Cut me off there." was read as a stop, her answer was never spoken, and the lines after it went unheard). A stop only the model read into a line gives the speaker a fresh reply window (session), and it counts even when the model calls the line not for her, if it comes from the person she is talking with ("okay, that's enough, thanks"); every stop is logged.
- "Angel?" with the question still to come waits up to `followUpMs` (12 s) for the same speaker's next line.

## How it works
- `mentionsAngel` and `isStopRequest` are regular expressions; plurals and "angelic" don't match, "Angel's" does. A stop is her name at the start (after an optional "hey", "okay", "so" or "um"), a stop word, and at most three words after it, in a line of at most 120 characters.
- `gate` sends the system prompt and "Earlier lines … LAST line …" (the line with its speaker, `lastText`) and expects `{"to_angel", "complete", "stop", "question"}`; `parseGate` reads it even inside a code fence. If the reply can't be read, or Claude can't be reached, the fallback is the plain rule on what was said (`bareText`, without the speaker's name): her name first, then a request. The session logs the failure.
- Each call returns its own cost (`dollars`), worked out from that call's usage.

## Checks
- (wk-10) {live} the self-test cases `cut-off-is-not-stop` and `real-stops` on her PC: remarks about being cut off are not stops, "that's enough, thanks" and "never mind, forget it" are.
- (wk-9) {unit} the check's time limit and one retry, and a cut-off reply reported (`test/wake.test.mjs`).
- (wk-1) {live} in play, "Angel, ..." questions are answered, and at least five in-game uses of "angel" or "angelic" and the word "angle" get no answer.
- (wk-2) {live} "Angel?" followed by the question as its own sentence gets one answer.
- (wk-3) {unit} names, stop phrases (and what is not a stop), reading the model's reply, the fallback on the bare words when the model can't be reached, and every text reader (these, `typedQuestion`, `speakable`) staying fast on 4,000 characters of odd text (`test/wake.test.mjs`).

## Traps
- The fallback once read the speaker-prefixed line ("Mira: Angel, ...") and so never matched: every spoken question was lost whenever the check failed (review M1, 2026-11-13). Hence `bareText`, and a test with the prefix.
- The first stop pattern let "anything, then a stop word" match in many ways: a 60-word line took 1.3 s, and the whole bot (every speaker, the voice) waits while a regex runs (second review, 2026-11-13). It now matches only at the start and counts the words after with plain code, and the fallback reads only the first 300 characters. A new pattern gets a line in the timing test.
- The system prompt is too short for Haiku's prompt cache to take; the `cache_control` mark is harmless and costs nothing.

## Open items
