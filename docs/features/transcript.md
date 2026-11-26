---
feature: transcript
files: [src/transcript.mjs, src/tidy.mjs]
functions: []
dependsOn: []
since: 0.1.0
---
The session's transcript: every line with its time and speaker, kept in order, written to a folder per session.

## Decisions
- A line is one line: line breaks in a typed message are made spaces, so it can't look like another speaker's line in what Angel is given (full code check, 2026-11-14).
- Text only, never audio, kept on the owner's PC (in the design; the join notice says so).
- The file can be turned off with `saveTranscript` (Angel's addition, 2026-11-13, after the owner said Archivist already transcribes her games; whether hers stays on is q-1 in the plan). The transcript in memory is kept either way: it is what Angel answers from.
- Angel's own answers go into the transcript too, so a later question can build on an earlier answer and a later recap has them.
- The readable `transcript.md` is tidied when the session ends (0.2.1, the owner's ask after a real two-hour listen-only session of 2026-11-25: 942 lines, 28% of them one or two words like "Yeah" or "Mhmm", and one speaker's sentence often cut into pieces a few seconds apart). `transcript.jsonl` is never tidied: it keeps every piece as heard, so nothing is lost and a misheard word can still be found.
- What is left out is only backchannel: one or two words, all of them listener noises ("yeah", "mhmm", "okay", "got it", "but yeah"). "No", "Yes", "Nope" and "Mm-mm" always stay, a "Yeah" right after someone else's question stays (it is an answer), and Angel's lines and typed lines are never left out. A lone "But" or "And" is a cut-off piece, so it is joined instead.
- Joining: a voice piece goes onto the same speaker's previous one when it began within 3 s of that one's end, nobody else said anything kept in between, and the joined line spans at most 90 s (so its time still says where it is). The line keeps its first piece's time. A note under the title says how many lines were left out and joined.
- Each line records when its piece ended (`end`, from 0.2.1), so the gap is measured, not guessed; for older transcripts it is guessed at 0.4 s a word (the pace of that session), at most 30 s.
- `npm run tidy -- <session folder>` writes `transcript.md` again from `transcript.jsonl`, for a session that ended without closing or one from before 0.2.1. It only reads the jsonl.

## How it works
- `add` inserts by the time the speech began (pieces are transcribed in parallel and can arrive out of order) and appends to `transcript.md` (to read) and `transcript.jsonl` (one JSON line each, for tools such as a later recap).
- `recent(minutes)` is what Angel is given with a question (`memoryMinutes`, default 15); `before(line, n)` gives the wake-word check its few lines of context.
- `format` writes `[19:04:12] Name (GM): text`, with "(typed)" for typed lines.
- `transcript.md` is appended as text arrives (which can be a few seconds out of order); `close` at the end of the session writes it again in the order things were said (review L6), tidied by `tidy` (`readable` adds the note).

## Checks
- (tr-9) {unit} a typed message with line breaks is one line (`test/transcript.test.mjs`).
- (tr-1) {live} after a real session, `data\sessions\<date>\transcript.md` reads in order with names and times, Angel's answers included.
- (tr-10) {unit} what counts as backchannel, and a "yeah" that answers a question, Angel's and typed lines kept (`test/transcript.test.mjs`).
- (tr-11) {unit} joining one speaker's pieces across left-out backchannel, never across someone else, the 90 s limit, the guess for old lines, and speed on 20,000 lines (`test/transcript.test.mjs`).
- (tr-12) {unit} the tidied file and its note, jsonl and memory untouched, each line's `end` from the session (`test/session.test.mjs`, `test/tables.test.mjs`), `npm run tidy` (`test/transcript.test.mjs`).
- (tr-13) {live} after a real session, `transcript.md` reads as whole sentences without the "mhmm"s and `transcript.jsonl` still has every piece. Tried 2026-11-26 on the 2026-11-25 session's jsonl with `npm run tidy`: 942 pieces became 622 lines (168 left out, 154 joined); still to see from a session's own end.
- (tr-2) {unit} ordering, the window, `before`, the files and the rewrite in order at the end (`test/transcript.test.mjs`); no folder with `saveTranscript` off (`test/bot.test.mjs`).

## Traps

## Open items
