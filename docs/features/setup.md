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
- **What setup writes** (third review, 2026-11-13): the keys and every setting she might change, so she can see them in Notepad, but not the models, prices or AoN user agent (`FOLLOW_RELEASES`) unless they differ from the defaults. Saved values win over the code's, and an update keeps `config.json`, so writing those would have frozen them at the first install: a retired model would break every answer until she edited the file by hand.
- Command Prompt, not PowerShell, for every install step: on a default Windows 11, PowerShell refuses `npm.ps1` (scripts disabled), a widely reported trap. The README says so at step 2.

## How it works
- `config.mjs`: `DEFAULTS` merged under `config.json` (prices merge per model). A setting keeps its default's kind (`"false"` with quote marks is false, `"$5"` is 5); one that can't be read that way gets the default and a line in `cfg.problems` (not enumerable, so never saved), which `npm run check` shows as a FAIL and `main` logs as a warning. Before this, a cap typed as `"$10"` stayed text and never tripped (fourth review). A `guildId` without quote marks is a problem too: JSON rounds an 18 or 19 digit number. So is an answer or check model with no price. `readKeyterms` always puts "Angel" first and caps the list at 100. `readText` reads every file the way Notepad may save it: UTF-8 with or without a byte-order mark, "Unicode" (UTF-16 LE) or "Unicode big endian". `tableFilesReport` tells `npm run check` what it found of the table's files, and fails a `house-rules.md.txt` or `keyterms.txt.txt` (extensions hidden in File Explorer) or a broken `speakers.json`. `fixFor` adds what to do to a FAIL line: a refused key or no credit only for Claude and Deepgram (Archives of Nethys has no key, and a JSON error's "position 402" isn't a status), a refused Discord token, and no connection or a time-out for any; `keyLooksWrong` warns at setup about a key pasted twice (its two halves the same) or into the wrong question.
- `services.mjs` builds the shared wiring once (Claude, AoN with its cache file, Deepgram listening and voice, the gate, the answering); `main.mjs` and `check.mjs` both use it. House rules are read for each question, so an edit counts without a restart.
- `main.mjs` exits 2 for "needs setup" (missing keys, a refused token, a `config.json` that can't be read) so `Start Angel.cmd` stops with a message instead of restarting every 10 seconds; other failures exit 1 and restart. Ctrl+C, closing the window (SIGHUP, and SIGBREAK for Ctrl+Break on Windows) and SIGTERM book the day's spending at once, end sessions within 4 seconds (Windows gives a closing window only a few) and save the AoN cache, then exit 3, which `Start Angel.cmd` takes as "stopped on purpose" and ends; a second signal books and quits at once. A crash books the live sessions' spending and saves the cache before exiting 1.
- `Start Angel.cmd` first checks that `node` is found and that `node_modules` holds the packages, and otherwise says what to do and stops (before, a missing Node or a run before `npm install`, or from inside the zip, restarted every 10 seconds forever). In the loop it stops with a message on exit 2, ends on exit 3, and restarts on anything else. It waits with `ping`, not `timeout`, which fails at once without a console window (Task Scheduler's "run whether logged on or not") and would make a fast restart loop (review L13). Pure ASCII with CRLF line ends (`.gitattributes`).
- `check.mjs` runs on the owner's PC: the table's files, both Claude models, Deepgram voice (WAV saved to hear, Ogg Opus read back packet by packet and decoded), Deepgram listening of that same WAV, AoN, Discord and the Message Content intent (with a 30-second limit, so a blocked connection can't hang it). `--voices` saves samples; `--ask` runs one real answer without Discord and shows the prompt cache's tokens written and read.
- `setup.mjs` stops with the plain message on a `config.json` it can't read; Ctrl+C at a question stops it without saving; a window that isn't a terminal (Git Bash's) gets a warning that pasted keys may show. Its Discord check has a 30-second limit (`within`), and only blames the token when Discord refused it (`tokenRefused`); anything else says the keys are saved and to check the connection. It exports `inviteUrl` and `INVITE_PERMISSIONS` (View Channel, Send Messages, Embed Links, Read Message History, Add Reactions, Connect, Speak, Use Voice Activity); it only runs its prompts when started as `src/setup.mjs`.

## Checks
- (st-1) {live} `npm install` on the owner's Windows PC (Node 22.12 or newer) finishes without errors, and `@snazzah/davey-win32-x64-msvc` is in `node_modules`.
- (st-2) {live} `npm run setup` on Windows: pasted keys don't show; it names the bot and the server and prints an invite link that adds the bot with the permissions above and the slash command.
- (st-3) {live} `npm run check` on the owner's PC: every line OK, and `data\check\angel-voice.wav` plays. (It reads a refused Message Content intent with the bot's own `isIntentRefusal`.)
- (st-4) {live} `Start Angel.cmd` starts her; Ctrl+C ends a running session with its summary posted and the window closes; with no `config.json` it stops with the setup message instead of looping; renamed `node_modules` (a run before `npm install`) stops with the npm install message.
- (st-5) {unit} defaults and merging, what setup saves, settings typed as text, a broken, BOM-prefixed or UTF-16 `config.json`, the table's files and their report, the FAIL advice, odd-looking keys, the time limit, keys blanked in the log, the invite link (`test/setup.test.mjs`).

## Traps
- `npm install prism-media` as a direct dependency fails: prism-media 1.3.5 wants `opusscript ^0.0.8` as a peer and this package uses 0.1.1. Don't add it; `tts.mjs` has its own small Ogg reader for the checks, and playback uses the copy inside @discordjs/voice.
- A time limit's timer must not be `unref`'d when it guards a step that may be the only thing running: a hung login would then end the process silently instead of with the reason (caught by its own test, 2026-11-13).
- On Node 22, `node --test test/` treats the folder as a file; the test script uses the quoted glob `"test/*.test.mjs"`.

## Open items
