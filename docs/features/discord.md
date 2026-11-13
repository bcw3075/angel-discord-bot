---
feature: discord
files: [src/bot.mjs, src/commands.mjs]
functions: []
dependsOn: [session]
since: 0.1.0
---
The Discord side: logging in, the /angel commands, typed questions, a session per server, leaving an empty channel.

## Decisions
- **Anyone at the table can ask** (the owner, 2026-11-12, d-3; the other choices were only the GM, or everyone with a switch to turn players off). Any player can use every subcommand.
- Typed questions count without the wake-word check: `@Angel ...`, a message starting "Angel, ...", or `/angel ask`. Other chat in the session's text channel goes into the transcript as typed lines, so Angel knows what was written as well as said.
- The GM label: `speakers.json` decides; without a role there, whoever has Manage Server counts as the GM, and the server owner's name is the GM's name for the answering prompt. `/angel iam` sets only the name, so the GM keeps that label. (Angel's choice.)
- `/angel optout` is a toggle kept in `data/optout.json`; it takes effect at once in a running session.
- A typed "Angel, ..." counts only with a comma, colon or question mark after her name, or as "hey Angel ..." ("Angel wings sprout from her back" is chat; review L1). A typed "Angel, stop" stops her and is not a question (review M4).
- With `guildId` set, Angel answers only in that server: every answer costs money (review M5). Typed questions outside a session count toward the daily cap.
- `/angel iam` drops brackets and parentheses from names, and never writes over a `speakers.json` that can't be read (it would wipe the others' names; review M7).
- Joining announces that Angel is transcribing, text only, and how to opt out (players should know; Angel's choice, in the design).

## How it works
- `start` logs in with Guilds, GuildVoiceStates, GuildMessages and MessageContent; if Discord refuses the privileged intent it logs how to switch it on and logs in without it (mentions and `/angel ask` still work).
- On ready, `/angel` is registered per server (`commands.set`), so it appears at once; `serves` limits that and every command and message to `guildId` when it is set.
- `join` marks the server in `joining` before its first await (two quick joins made two sessions before; review M8), refuses past the daily cap, fetches the server owner (one member, allowed without the Server Members intent) so the GM's name is known, then makes a `VoiceLink` (stand-in class injectable for tests), a `Session` with a transcript folder under `data/sessions/<start>/`, and keeps `{ session, voiceChannelId, textChannel, emptyTimer }` per server.
- `onVoiceState`: when no non-bot members remain in Angel's channel for `leaveWhenEmptySeconds`, the session ends with its summary; Angel moved or disconnected by someone ends it at once.
- `answerAlone` answers a typed question when no session is running: text only, no conversation; refused past the daily cap, and its cost (a failed one's too) is added to `data/spend.json`.
- The daily ledger is the closed sessions and lone answers of the day plus every live session's running total.

## Checks
- (dc-1) {live} `/angel` shows in the owner's server with its seven subcommands within a minute of starting.
- (dc-2) {live} `/angel join` from a voice channel: Angel joins (not deafened, Discord shows the call as end-to-end encrypted) and the notice appears in the text channel.
- (dc-3) {live} with and without a session: a typed `@Angel ...` and a typed "Angel, ..." each get the placeholder, then the answer in place; with a session she also speaks it.
- (dc-4) {live, player} `/angel iam`, `/angel optout` (that player's voice then missing from the transcript, and back after the second optout), `/angel status` and `/angel leave` (summary posted) work for a player and for the owner.
- (dc-5) {live} everyone leaves the voice channel: Angel leaves about a minute later and posts the summary; disconnecting her by hand ends the session too.
- (dc-6) {unit} the command shape, typed-question parsing, every subcommand, table chat, the empty-channel timer, typed stop, the home-server limit, two joins at once, a broken `speakers.json`, the daily cap and the intent refusal, with stand-ins (`test/bot.test.mjs`, `test/setup.test.mjs`).

## Traps
- discord.js reports a refused privileged intent as code `DisallowedIntents` with the message "Privileged intent provided is not enabled or whitelisted." (no "disallowed intents" in it): matching the wording alone missed it and the bot would restart-loop with the intent off (review L10). `isIntentRefusal` checks the code; a test throws the library's own error.
- An interaction must be answered within 3 seconds: `join` and `ask` call `deferReply` before any slow work, then `editReply`.
- A question asked in another channel during a session is answered where it was asked (the `reply` target), not in the session's channel.

## Open items
