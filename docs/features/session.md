---
feature: session
files: [src/session.mjs]
functions: []
dependsOn: [voice, deepgram, wake, answering, transcript]
since: 0.1.0
---
One game session from join to leave: speech to transcript, the wake check, answers one at a time, typed and spoken, costs and the cap.

## Decisions
- A short phrase is spoken at once while she looks something up (`ackPhrase`, default "One sec, let me check."; made once at the start of the session), and a "Looking it up…" placeholder is posted and later replaced with the answer, so the table knows she heard. (Angel's choice.)
- A spending cap per session (`maxSessionDollars`, default $5): past it she says so once and pays for nothing more until a new session. (Angel's choice, a guard on top of the Console workspace's monthly cap.)
- Questions are answered one at a time, in the order asked; the next answer is worked out while the previous one is still being spoken.

## How it works
- All outside parts come in as functions (`voice`, `post`, `stt`, `tts`, `gate`, `answer`, `speakerOf`), so `test/session.test.mjs` runs the whole flow with stand-ins and real Opus packets.
- `onSpeech`: decoder per speaker → `packetsToWav` (skips short or quiet) → `stt` → `transcript.add` → `onLine`.
- `onLine`: a stop phrase stops her; a line without her name is only transcript (unless that speaker has a question pending); speech that began in the echo window is ignored; then the gate. "Not complete" keeps the line pending for `followUpMs`.
- `runAsk`: placeholder → acknowledgement phrase → `answer` with the last `memoryMinutes` of transcript → the placeholder edited to the typed answer → Angel's line in the transcript → the spoken copy queued. A failure gives a short apology instead of silence.
- Costs: Claude by each call's own usage; listening by billed seconds × (Nova-3 rate + key-term rate when names are given); voice by characters. `status()` and `summaryText()` report them.

## Checks
- (se-1) {live} a real session of 30 minutes or more: the phrase, then the full answer spoken; the typed copy replaces the placeholder; `/angel status`'s cost is within about 20% of what the Console and Deepgram show for that time.
- (se-2) {live} with `maxSessionDollars` set very low, she says so once and stops answering.
- (se-3) {unit} the whole flow with stand-ins: a spoken question, story talk, two-part questions, stop, the echo window, skipped noise, the cap, typed questions, failures, ending, typing only (`test/session.test.mjs`).

## Traps
- A cost worked out as the change in a running total is wrong while two calls overlap (a gate check during an answer); each call returns its own cost instead.

## Open items
