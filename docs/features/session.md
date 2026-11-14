---
feature: session
files: [src/session.mjs]
functions: []
dependsOn: [voice, deepgram, wake, answering, transcript]
since: 0.1.0
---
One game session from join to leave: speech to transcript, the wake check, answers one at a time, typed and spoken, costs and the cap.

## Decisions
- **Back and forth** (Rhea at the live test, 2026-11-14: "you replied first but not when I replied to you"): for `replyWindowMs` (20 s) from when her spoken answer finishes playing, the person she just answered by voice can reply without her name; the line still goes through the check, which decides it was for her, and the echo guard still applies. At most three unnamed replies in a row; "Angel, stop" and the end of the session close the window. Anyone else still has to name her.
- **Small talk isn't posted** (Rhea, 2026-11-14: "you don't need to post the questions and replies to non game related questions"): when the check marks a spoken line as small talk (`chat`), there's no "let me check" phrase, no placeholder and no post, only her spoken reply. Posted after all when it failed, couldn't be spoken, or looked something up (the check called a rules question small talk).
- Only the short spoken answer (`say`) is spoken and goes in the transcript; the channel gets the fuller written one (`details`) (d-1 as changed by Rhea, 2026-11-14).
- A short phrase is spoken at once while she looks something up (`ackPhrase`, default "One sec, let me check."; made once at the start of the session), and a "Looking it up…" placeholder is posted and later replaced with the answer, so the table knows she heard. (Angel's choice.)
- A spending cap per session (`maxSessionDollars`, default $5) and one per day for everything the bot does (`maxDailyDollars`, default $10, kept in `data/spend.json`): past either she says so once, and the cap is checked again before every paid step (listening, the check, each answer, its voice), so nothing more is paid for; a typed question is told so. (Angel's choice, a guard on top of the Console workspace's monthly cap.)
- **Stop means stop** (review M2, 2026-11-13): "Angel, stop" cuts her off, drops questions still waiting their turn (a typed one is told), and an answer still being looked up is typed but not spoken.
- Questions are answered one at a time, in the order asked; the next answer is worked out while the previous one is still being spoken.

## How it works
- All outside parts come in as functions (`voice`, `post`, `stt`, `tts`, `gate`, `answer`, `speakerOf`), so `test/session.test.mjs` runs the whole flow with stand-ins and real Opus packets.
- `onSpeech`: decoder per speaker → `packetsToWav` (skips short or quiet) → `stt` → `transcript.add` → `onLine`.
- `onLine`: a stop phrase stops her; a line without her name is only transcript (unless that speaker has a question pending, or a check on their last line is still running, in which case it is kept as the rest of the question); speech that began in the echo window is ignored; then the gate. Lines the speaker added while the check ran are always added to the question, finished or not. "Not complete" keeps the line pending for `followUpMs`. A gate that says stop and also found a question (a "?" in the line) stops her and then answers it.
- Stops go by time: `stop(at)` records when the stop was said, and a question is dropped when a stop was said after the question was (`stoppedSince(at)`), checked when the check comes back and again when its turn comes. So a stop said while the check on a question runs covers that question too. `runAsk` tells a typed question that was dropped, or that the session ended before its turn, so a deferred `/angel ask` never hangs; it checks the cap; then placeholder → acknowledgement phrase → `answer` with the last `memoryMinutes` of transcript → the placeholder edited to the typed answer → Angel's line in the transcript → the spoken copy queued. A failure gives a short apology instead of silence, and what its rounds cost is still counted (`answerQuestion` attaches `dollars` to the error).
- Costs: Claude by each call's own usage; listening by billed seconds × (Nova-3 rate + key-term rate, since "Angel" is always sent as a key term); voice by characters. `status()` and `summaryText()` report them.

## Checks
- (se-1) {live} a real session of 30 minutes or more: the phrase, then the full answer spoken; the typed copy replaces the placeholder; `/angel status`'s cost is within about 20% of what the Console and Deepgram show for that time.
- (se-2) {live} with `maxSessionDollars` set very low, she says so once and stops answering; `/angel status` shows today's total.
- (se-3) {unit} the whole flow with stand-ins: a spoken question, story talk, two-part questions (also when the rest comes while the check runs, finished or not), stop (also while she looks something up, and while the check on a question, finished or not, still runs), a typed question waiting when the session ends, the echo window, skipped noise, the session and daily caps, a failed answer's cost, typed questions, failures, ending, typing only (`test/session.test.mjs`).

## Traps
- A line said while the check on the speaker's previous line was still running had neither her name nor a pending entry, so it was dropped and the question expired (review M6): hence `checking`.
- Stops were first counted (a question stamped with the stop count when it was queued): a stop said while the check ran came before the stamp, so it didn't cover the question it was meant for (second review). Hence stops by the time things were said.
- A cost worked out as the change in a running total is wrong while two calls overlap (a gate check during an answer); each call returns its own cost instead.

## Open items
