# Angel: a rules helper in your Discord voice chat

Angel sits in your game's Discord voice channel, keeps a transcript of the session, and answers when someone talks to
her: "Angel, what's the ruling on this?" She looks the rule up on Archives of Nethys (Remaster first), says the answer
aloud in the voice channel and types it in your text channel with the page links. Typed questions work too.

She runs on your own Windows PC. She only connects out to Discord, Claude, Deepgram and Archives of Nethys, so no
port or tunnel is needed.

## What you need
- **Node.js 22.12 or newer** (https://nodejs.org, the LTS installer).
- **A Discord application** for the bot (free).
- **A Claude API key**, ideally in its own Console workspace with a monthly spending limit.
- **A Deepgram API key** (https://console.deepgram.com; new accounts get $200 of free credit). Deepgram does both the
  listening (speech to text) and Angel's voice.

## Install
1. Unzip this folder somewhere permanent, for example C:\AngelBot.
2. Open a command window in that folder: in File Explorer click the address bar, type `cmd` and press Enter.
3. Run `npm install`.
4. **Discord:** https://discord.com/developers/applications → **New Application**, name it **Angel**.
   - **Bot** tab → **Reset Token** → copy the token (you'll paste it in step 5; it's a password, so keep it private).
   - Same tab, under **Privileged Gateway Intents**, switch on **Message Content Intent** and save. (It lets Angel
     see typed "Angel, ..." messages.)
5. Run `npm run setup` and paste the Discord token, the Claude key and the Deepgram key when asked. Nothing you paste
   shows on screen. Setup checks the token and prints an **invite link**: open it, pick your server and approve.
6. Put your table's files beside `package.json` (examples are in `examples/`):
   - `house-rules.md`: your house rules, in plain words. Angel reads them with every question. Players hear
     everything she says, so keep GM secrets out of it.
   - `keyterms.txt`: your campaign's names, one per line, so the transcriber spells them right.
7. Run `npm run check`. Every line should say OK. It also saves a sample of Angel's voice as
   data\check\angel-voice.wav.
8. Optional: `npm run voices` saves samples of eight voices in the data\voices folder. Put the one you like as `"ttsVoice"`
   in `config.json`.
9. Optional: `npm run ask -- "can I grapple with a shield in my hand?"` asks one question without Discord, so you can
   judge her answers and see what each costs.
10. Start Angel: double-click **Start Angel.cmd** (it restarts her if she ever stops). To start her when you log in:
    Task Scheduler → Create Basic Task → "Angel" → **When I log on** → Start a program →
    C:\AngelBot\Start Angel.cmd, start in C:\AngelBot.

## At the table
- Join your voice channel, then type `/angel join` in the text channel where answers should go. Angel joins, tells
  everyone she's transcribing, and starts listening.
- Ask her by name: **"Angel, ..."**. Or type `@Angel ...`, `Angel, ...` or `/angel ask`.
- She answers in voice and in the text channel. **"Angel, stop"** or `/angel stop` cuts her off.
- `/angel iam` sets the character name the transcript uses for you. `/angel optout` stops her transcribing your
  voice (run it again to undo). `/angel status` shows what this session has cost so far.
- `/angel leave` ends the session. She also leaves on her own a minute after the voice channel empties, and posts a
  short summary with the cost.

## Where things are kept
- `config.json`: your keys and settings (written by setup). Never share it.
- data\sessions\<date>\transcript.md: each session's transcript, text only. No audio is ever saved.
- data\angel.log: what Angel did, with the keys blanked out.
- `speakers.json`: character names from `/angel iam`, and who is the GM. You can edit it by hand. Without an entry,
  whoever can manage the Discord server counts as the GM.

## Settings in config.json
Change them with Notepad, then restart Angel. The most useful:
- `ttsVoice`: Angel's voice (`npm run voices` to hear them).
- `speak`: `false` makes her type only.
- `ackPhrase`: what she says at once while looking something up (`""` for nothing).
- `maxSessionDollars`: she stops listening and answering for the rest of a session past this (default 5).
- `answerModel`: `claude-sonnet-5-5` by default; `claude-opus-5-5` is slower and costs about twice as much.
- `memoryMinutes`: how much of the conversation she's given with a question (default 15).

## Updating
Unzip the new version over the folder, keeping `config.json`, `data\`, `house-rules.md`, `keyterms.txt` and
`speakers.json`. Run `npm install`, then restart Angel.

## Costs
About $2 for a four-hour session: listening is about $0.30 an hour of talk, each answer about 2 to 3 cents on
Sonnet, and her spoken answers a cent or two each. `/angel status` shows the running total.

## Privacy
Angel tells the table when she starts transcribing. Tell your players before the first session, and anyone can opt
out with `/angel optout`. Audio goes to Deepgram to be turned into text and is not kept by Angel; questions and
the recent conversation go to Claude. Transcripts stay on this PC.
