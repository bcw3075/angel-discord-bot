---
feature: transcript
files: [src/transcript.mjs]
functions: []
dependsOn: []
since: 0.1.0
---
The session's transcript: every line with its time and speaker, kept in order, written to a folder per session.

## Decisions
- Text only, never audio, kept on the owner's PC (in the design; the join notice says so).
- The file can be turned off with `saveTranscript` (Angel's addition, 2026-11-13, after the owner said Archivist already transcribes her games; whether hers stays on is q-1 in the plan). The transcript in memory is kept either way: it is what Angel answers from.
- Angel's own answers go into the transcript too, so a later question can build on an earlier answer and a later recap has them.

## How it works
- `add` inserts by the time the speech began (pieces are transcribed in parallel and can arrive out of order) and appends to `transcript.md` (to read) and `transcript.jsonl` (one JSON line each, for tools such as a later recap).
- `recent(minutes)` is what Angel is given with a question (`memoryMinutes`, default 15); `before(line, n)` gives the wake-word check its few lines of context.
- `format` writes `[19:04:12] Name (GM): text`, with "(typed)" for typed lines.
- `transcript.md` is appended as text arrives (which can be a few seconds out of order); `close` at the end of the session writes it again in the order things were said (review L6).

## Checks
- (tr-1) {live} after a real session, `data\sessions\<date>\transcript.md` reads in order with names and times, Angel's answers included.
- (tr-2) {unit} ordering, the window, `before`, the files and the rewrite in order at the end (`test/transcript.test.mjs`); no folder with `saveTranscript` off (`test/bot.test.mjs`).

## Traps

## Open items
