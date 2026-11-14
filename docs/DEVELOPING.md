# Developing Angel

How the code works in general. Each feature's own decisions, details, checks and traps are in `docs/features/<name>.md`
(the index below); each release's record is `docs/changes/<version>.md`. This repo is public: no campaign content in
code, comments, tests, fixtures or docs (the privacy scan checks against a private word list).

## Layout
- `src/main.mjs` starts the bot; `src/services.mjs` builds the shared wiring from `config.json`.
- `src/bot.mjs` (Discord) → `src/session.mjs` (one session) → `src/voice.mjs` (the voice channel), `src/stt.mjs` /
  `src/tts.mjs` (Deepgram), `src/wake.mjs` (was that for me?), `src/answer.mjs` (Claude + `src/aon.mjs`).
- `src/setup.mjs` and `src/check.mjs` are the owner's setup and check scripts.
- `test/*.test.mjs` run with `npm test` (Node's own test runner, no packages); `test/live/aon-live.mjs` is the live
  Archives of Nethys check (`npm run test:aon`).
- On the owner's PC, beside the code and git-ignored: `config.json`, `data/` (transcripts, log, caches, opt-outs),
  `house-rules.md`, `keyterms.txt`, `speakers.json`.

## Rules for the code
- **Every outside part is passed in.** Discord's voice library (`lib` in `VoiceLink`), fetch (Claude, AoN, Deepgram),
  the session's services and the bot's `VoiceLinkClass` are parameters with real defaults, so the tests run the whole
  flow without Discord or keys. Keep it that way: new outside calls get the same treatment and a stand-in test.
- **Secrets** are only in `config.json`; never print them. `log.mjs` blanks them out of every line.
- **Every paid call reports its own cost** (the usage of that call), never as a change in a running total.
- **Nothing the session does may crash the process**: stream errors are listened for, async handlers end in
  `.catch`, and a failed answer is an apology in the channel.
- **No slow regex on text from the table**: the whole bot waits while one runs (a stop pattern once took 1.3 s on a
  60-word line). Anchor patterns, avoid two unbounded parts that can match the same characters, count words in plain
  code, and add each new pattern to the timing test in `test/wake.test.mjs`.
- **Library behaviour is checked where it happens**: before writing that a library throws or emits something, read
  the code that does it (the throw site, the state changes), not a message table or a type comment, and build the
  test from that real output. The intent error and the reconnect path were both "verified" from the wrong place once.
- **A new test is checked by breaking its fix**: undo the fix, see the test fail, put it back. Two tests passed with
  their fix removed (a later guard caught the case; a stand-in never answered) until this was done.
- **A test waits for what it checks, not for a fixed time**, when the step runs through `setImmediate` or I/O: on a
  busy machine a short timer can fire first. The voice test for listening again after a close failed 37 times in 60
  runs four at a time until it waited for the new listen. A wait for a timer the code itself sets is fine (timers
  fire in order). Before trusting a fix to a test like this, run it many times in parallel.
- **One review goes to the install path**: setup, `npm run check`, `Start Angel.cmd` and the README, read as the
  owner meets them on Windows (Command Prompt, Notepad, File Explorer with extensions hidden). The code reviews read
  the logic and missed all 18 things this found (2026-11-13).
- **Every round of fixes gets its own fresh review before a release.** Each round so far has brought in new
  problems: the third review's fixes made a spending cap typed as "$10" switch itself off, and a README line they
  added invited a server id that JSON rounds (fourth review, 2026-11-14). A setting read from `config.json` that
  guards money or access is checked for its kind, never trusted.
- Plain fetch, no SDKs: fewer moving parts on the owner's PC.
- Pinned versions (`--save-exact`). `@discordjs/voice` and `@snazzah/davey` follow Discord's voice encryption: before
  updating them, read their changelogs for receive and DAVE changes, then run the live voice checks.
- `check.mjs` and `setup.mjs`'s prompts run when started, so no unit test imports `check.mjs`: a test parses every source file (`node --check`), and a change to a script gets one real run (2026-11-14, a syntax error passed `npm test`).

## Running and testing here
- `npm install`, `npm test` (all stand-in tests), `npm run test:aon` (live AoN; works from the cloud workspace).
- The cloud workspace reaches Discord's API, the Claude API, Deepgram and the AoN index over HTTPS (checked
  2026-11-13), but not Discord voice (UDP), and it has no keys: the voice and keyed checks run on the owner's PC.
- A one-off lint for undefined names (not a dependency): install `eslint@9` and `globals@15` in a scratch folder and
  run `<scratch>/node_modules/.bin/eslint --no-config-lookup -c <scratch>/eslint.config.mjs "src/*.mjs" "test/*.mjs"`
  from this repo, with a flat config that sets `globals.node` and turns on `no-undef` and `no-unused-vars`. The
  Discord handlers had an undefined name that no test reached before `test/bot.test.mjs` existed.

## Releasing
The build protocol of `bcw3075/foundry-mod-tools` (its README): `guide start <version> "<title>" --plan <private plan>`,
fill the change record, `gate` (it runs the doc check, the privacy scan and the tests, and builds
`dist/angel-discord-bot.zip` from the tree), commit and push. The owner installs by unzipping over her folder, keeping
`config.json`, `data/` and her own files, then `npm install` and a restart. A release that adds a config key needs
nothing from her: defaults fill the gap.

## Features
<!-- feature-index:start -->
| Feature | Doc | Owns | Checks |
|---|---|---|---|
| answering | `docs/features/answering.md` | src/answer.mjs, src/claude.mjs, src/aon.mjs | 5 |
| deepgram | `docs/features/deepgram.md` | Choose Voice.cmd, src/stt.mjs, src/tts.mjs, src/speech.mjs | 4 |
| discord | `docs/features/discord.md` | src/bot.mjs, src/commands.mjs | 6 |
| session | `docs/features/session.md` | src/session.mjs | 3 |
| setup | `docs/features/setup.md` | Install Angel.cmd, src/config.mjs, src/log.mjs, src/setup.mjs, src/check.mjs, src/services.mjs, src/main.mjs | 6 |
| transcript | `docs/features/transcript.md` | src/transcript.mjs | 2 |
| voice | `docs/features/voice.md` | src/voice.mjs, src/capture.mjs, src/audio.mjs | 5 |
| wake | `docs/features/wake.md` | src/wake.mjs | 3 |
<!-- feature-index:end -->
