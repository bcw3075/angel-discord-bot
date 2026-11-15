---
feature: discord
files: [src/bot.mjs, src/commands.mjs]
functions: []
dependsOn: [session]
since: 0.1.0
---
The Discord side: logging in, the /angel commands, typed questions, a session per server, leaving an empty channel.

## Decisions
- **One thread a day** (Rhea, 2026-11-14 22:0x, after an evening of test joins left six threads all named "Angel · Sat, Nov 14"; she chose "One thread per day" over the time in the name or leaving it): a join looks for her own open thread of today's name in that channel (`threads.fetchActive`, read in discord.js: it lists the server's active threads and keeps this channel's) and goes on in the newest; an archived or locked one, another day's, or someone else's of the same name is not used; if the look fails or takes over 5 s a new thread is made as before.
- **The spend file can't stop her** (full code check, 2026-11-14): it is written whole beside itself and swapped in, so a crash mid-write can't leave half a file; a write that fails (a locked file, a full disk) is said once in the log, kept in memory and tried again. Before, a failed write on the one-minute timer ended the program. A total that isn't a number counts as over the cap.
- Typed questions outside a session are answered one at a time, so each is checked against the day's cap after the one before it was counted.
- **One thread per session** (Rhea, 2026-11-14: "instead of posting and spamming the channel... could she start a thread for this session and then keep everything in that thread?"): `/angel join` starts a thread named like "Angel · Sat, Nov 14" in the channel it was typed in; the transcribing notice, every answer, a lost-connection note and the summary go there, and a typed question asked in the channel is answered in the thread. The join reply only points to it. Without both thread permissions (Create Public Threads, Send Messages in Threads), when the thread takes over 5 s, or when its first post fails, she posts in the channel as before. A typed question answered in the thread gets a 🧵 on it in the channel. The thread is archived after the summary. Anything failing after the voice join leaves voice and deletes an empty thread. `sessionThread: false` turns it off. Rhea gave Angel's role Administrator on her server (2026-11-14), which covers it.
- The typed copy of an answer is its written part (`details`), the fuller one; only the short `say` is spoken (d-1 as changed 2026-11-14, see answering).
- Angel needs to see the game's text and voice channels: a private channel hides her, and `/angel join` there timed out (2026-11-14, Rhea gave her access). The join's timeout message names this.
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
- The daily ledger is the closed sessions and lone answers of the day plus every live session's running total. The running totals are written to `data/spend.json` every minute (`bookLive`) and counted for their day at the next start, so a crash or a closed window can't reset the cap; what an answer still running at the end costs is booked when it finishes, and a crash books before exiting.
- `serves` compares ids as text, so `guildId` matches written either way; on ready, a `guildId` that is none of the bot's servers is warned about (otherwise `/angel` would silently appear nowhere).
- `speakerOf` drops brackets from Discord nicknames as `/angel iam` does (`cleanName`), so a nickname like "Sam (GM)" can't make a GM line.
- `join` gets the text channel before the voice join, so a channel she can't post in leaves no voice connection open.
- A typed stop is read with the bot's mention replaced by "Angel", so "@Angel stop" stops her like "Angel, stop".

## Checks
- (dc-10) {live} a second /angel join on the same day posts in the thread the first one made.
- (dc-11) {unit} today's open thread reused, and a new one when there is none or the look fails (`test/bot.test.mjs`).
- (dc-9) {unit} a spend file that can't be written, a total that isn't a number, typed questions one at a time (`test/bot.test.mjs`).
- (dc-1) {live} `/angel` shows in the owner's server with its seven subcommands within a minute of starting.
- (dc-2) {live} `/angel join` from a voice channel: Angel joins (not deafened, Discord shows the call as end-to-end encrypted) and the notice appears in the text channel.
- (dc-3) {live} with and without a session: a typed `@Angel ...` and a typed "Angel, ..." each get the placeholder, then the answer in place; with a session she also speaks it.
- (dc-4) {live, player} `/angel iam`, `/angel optout` (that player's voice then missing from the transcript, and back after the second optout), `/angel status` and `/angel leave` (summary posted) work for a player and for the owner.
- (dc-5) {live} everyone leaves the voice channel: Angel leaves about a minute later and posts the summary; disconnecting her by hand ends the session too.
- (dc-6) {unit} the command shape, typed-question parsing, every subcommand, table chat, the empty-channel timer, typed stop ("Angel, stop" and "@Angel stop"), the home-server limit (`guildId` as text or a number, and the warning), two joins at once, a broken `speakers.json`, nicknames, the text channel before voice, the daily cap (and its running totals across a crash, and an answer finishing after the end) and the intent refusal, with stand-ins (`test/bot.test.mjs`, `test/setup.test.mjs`).

## Traps
- A refused privileged intent (close code 4014) makes `client.login` reject with @discordjs/ws's `Error("Used disallowed intents")`, read in the installed library. discord.js also defines a `DisallowedIntents` code with other wording ("Privileged intent provided is not enabled or whitelisted."), which login doesn't throw today. `isIntentRefusal` accepts either; the bot and `npm run check` share it, and a test throws both. The first review (L10) claimed only the code form was thrown; the second review showed that was wrong, so read the library's throw site before trusting an error's wording.
- An interaction must be answered within 3 seconds: `join` and `ask` call `deferReply` before any slow work, then `editReply`.
- A question asked in another channel during a session is answered where it was asked (the `reply` target), not in the session's channel.

## Open items
