---
feature: setup
files: [src/config.mjs, src/log.mjs, src/setup.mjs, src/check.mjs, src/services.mjs, src/main.mjs]
functions: []
dependsOn: []
since: 0.1.0
---
Settings, keys and the owner's own files; the setup and check scripts; the logger; building the services; starting.

## Decisions
- Runs on the owner's Windows PC beside her other tools, started by `Start Angel.cmd` with a restart loop (the bridge's pattern). It only connects out, so no tunnel or port. (Angel's choice, 2026-11-12, in the design.)
- Its own Claude Console workspace and key with a monthly cap, separate from other API spend. (Angel's choice, 2026-11-12.)
- Keys are pasted into `npm run setup` without echo and live only in `config.json`; the logger blanks them out of every line. Nothing ever prints them.
- The table's own files (`house-rules.md`, `keyterms.txt`, `speakers.json`) sit beside the code and are git-ignored: the repo is public and holds no campaign content.
- Models: Sonnet 5.5 answers, Haiku 5.5 checks wake words (the owner chose Sonnet by default for her other API work, 2026-11-12). One setting each in `config.json`.

## How it works
- `config.mjs`: `DEFAULTS` merged under `config.json` (prices merge per model). `readKeyterms` always puts "Angel" first and caps the list at 100. A byte-order mark from Notepad is stripped everywhere.
- `services.mjs` builds the shared wiring once (Claude, AoN with its cache file, Deepgram listening and voice, the gate, the answering); `main.mjs` and `check.mjs` both use it. House rules are read for each question, so an edit counts without a restart.
- `main.mjs` exits 2 for "needs setup" (missing keys, a refused token, a `config.json` that isn't valid JSON) so `Start Angel.cmd` stops with a message instead of restarting every 10 seconds; other failures exit 1 and restart. Ctrl+C, closing the window (SIGHUP, and SIGBREAK for Ctrl+Break on Windows) and SIGTERM end sessions within 5 seconds (a second signal quits at once) and save the AoN cache; a crash books the live sessions' spending and saves the cache before exiting 1.
- `Start Angel.cmd` waits with `ping`, not `timeout`, which fails at once without a console window (Task Scheduler's "run whether logged on or not") and would make a fast restart loop (review L13).
- `check.mjs` runs on the owner's PC: both Claude models, Deepgram voice (WAV saved to hear, Ogg Opus read back packet by packet and decoded), Deepgram listening of that same WAV, AoN, Discord and the Message Content intent. `--voices` saves samples; `--ask` runs one real answer without Discord.
- `setup.mjs` exports `inviteUrl` and `INVITE_PERMISSIONS` (View Channel, Send Messages, Embed Links, Read Message History, Add Reactions, Connect, Speak, Use Voice Activity); it only runs its prompts when started as `src/setup.mjs`.

## Checks
- (st-1) {live} `npm install` on the owner's Windows PC (Node 22.12 or newer) finishes without errors, and `@snazzah/davey-win32-x64-msvc` is in `node_modules`.
- (st-2) {live} `npm run setup` on Windows: pasted keys don't show; it names the bot and the server and prints an invite link that adds the bot with the permissions above and the slash command.
- (st-3) {live} `npm run check` on the owner's PC: every line OK, and `data\check\angel-voice.wav` plays. (It reads a refused Message Content intent with the bot's own `isIntentRefusal`.)
- (st-4) {live} `Start Angel.cmd` starts her; Ctrl+C ends a running session with its summary posted; with no `config.json` it stops with the setup message instead of looping.
- (st-5) {unit} defaults and merging, a broken or BOM-prefixed `config.json`, the table's files, keys blanked in the log, the invite link (`test/setup.test.mjs`).

## Traps
- `npm install prism-media` as a direct dependency fails: prism-media 1.3.5 wants `opusscript ^0.0.8` as a peer and this package uses 0.1.1. Don't add it; `tts.mjs` has its own small Ogg reader for the checks, and playback uses the copy inside @discordjs/voice.
- On Node 22, `node --test test/` treats the folder as a file; the test script uses the quoted glob `"test/*.test.mjs"`.

## Open items
