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
- Joining announces that Angel is transcribing, text only, and how to opt out (players should know; Angel's choice, in the design).

## How it works
- `start` logs in with Guilds, GuildVoiceStates, GuildMessages and MessageContent; if Discord refuses the privileged intent it logs how to switch it on and logs in without it (mentions and `/angel ask` still work).
- On ready, `/angel` is registered per server (`commands.set`), so it appears at once; `guildId` in the config limits it to one server.
- `join` makes a `VoiceLink` (stand-in class injectable for tests), a `Session` with a transcript folder under `data/sessions/<start>/`, and keeps `{ session, voiceChannelId, textChannel, emptyTimer }` per server.
- `onVoiceState`: when no non-bot members remain in Angel's channel for `leaveWhenEmptySeconds`, the session ends with its summary; Angel moved or disconnected by someone ends it at once.
- `answerAlone` answers a typed question when no session is running: text only, no conversation.

## Checks
- (dc-1) {live} `/angel` shows in the owner's server with its seven subcommands within a minute of starting.
- (dc-2) {live} `/angel join` from a voice channel: Angel joins (not deafened, Discord shows the call as end-to-end encrypted) and the notice appears in the text channel.
- (dc-3) {live} with and without a session: a typed `@Angel ...` and a typed "Angel, ..." each get the placeholder, then the answer in place; with a session she also speaks it.
- (dc-4) {live, player} `/angel iam`, `/angel optout` (that player's voice then missing from the transcript, and back after the second optout), `/angel status` and `/angel leave` (summary posted) work for a player and for the owner.
- (dc-5) {live} everyone leaves the voice channel: Angel leaves about a minute later and posts the summary; disconnecting her by hand ends the session too.
- (dc-6) {unit} the command shape, typed-question parsing, every subcommand, table chat and the empty-channel timer with stand-ins (`test/bot.test.mjs`, `test/setup.test.mjs`).

## Traps
- An interaction must be answered within 3 seconds: `join` and `ask` call `deferReply` before any slow work, then `editReply`.
- A question asked in another channel during a session is answered where it was asked (the `reply` target), not in the session's channel.

## Open items
