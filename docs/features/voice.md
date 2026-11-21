---
feature: voice
files: [src/voice.mjs, src/capture.mjs, src/audio.mjs]
functions: []
dependsOn: []
since: 0.1.0
---
Being in the voice channel: joining with Discord's end-to-end encryption, hearing each speaker in pieces, playing Angel's voice.

## Decisions
- **Who is talking goes to the floor** (0.1.3, the busy table, Rhea's d-7): the receiver's speaking "start" and "end" become "talking" events, for people only (`isPerson`: another bot's sound isn't the table talking; a player who opted out still counts, since only the fact that they talk is used). `ownSpeech()` gives her recent clips and the one playing now, so the floor can tell her own voice coming back through a microphone from the table.
- The echo guard's time rule is softened for one case (session.mjs `echoOf`): a reply without her name, from the person she just answered, that begins inside the guard is kept unless 70% of its words are in what she just said (2026-11-14: Rhea's "Nice. And does that stack...?" began 2 s after Angel stopped and was dropped).
- **A join that times out says where it stopped** (2026-11-14: the first live `/angel join` on Rhea's PC timed out and the log was empty): every connection step is logged as `voice: <status>` while joining, the timeout logs the steps, and stuck at `connecting` (Discord answered, the UDP voice link never opened) the message names Windows Firewall instead of permissions.
- Node with `@discordjs/voice` 0.19.2 and `@snazzah/davey` (pinned). Since 2 March 2026 Discord refuses voice connections without DAVE end-to-end encryption, bots included; @discordjs/voice's receive bug with encrypted audio (discord.js issue 11419) was fixed by PR 11449 (13 March 2026) and 0.19.2 (17 March 2026) has it. (Angel's choice, 2026-11-12, in the design.)
- **Deaf: she leaves and joins again** (0.1.3, field test of 2026-11-21: about a minute after a third person first spoke she heard nothing for 13 minutes, 148 pieces skipped as too short, and the log said nothing until the owner's Ctrl+C). Most likely the voice encryption (DAVE): when someone joins, the call's keys change, and in 0.19.2 a change that doesn't finish leaves `DAVESession.decrypt` returning nothing for good (while a transition is pending it never counts failures), or throwing on every packet after a welcome at transition 0 (discord.js issue 11653, fixed upstream by moving to davey 0.2.0, not in a release yet). Unproven: the library tells of it only in debug messages, which Angel didn't keep. So 0.1.3 keeps them, and judges by the result, whatever the cause: the people she listens to talked 10 s or more in the last 30 s and under 15% of that came through as sound, she leaves, waits a second, joins again (fresh keys), and says so in writing and with one short spoken line. At most 3 rejoins a session, at least 2 minutes apart; after the third she leaves with a note. Rhea chose it ("Yes, add it to 0.1.3").
- Opus is decoded with `opusscript` (WebAssembly), so nothing needs compiling on Windows.
- Angel's voice is played as Ogg Opus straight from Deepgram (`StreamType.OggOpus`): no FFmpeg on the owner's PC.
- Speech that began while Angel was talking, or within `echoGuardMs` after, is not taken as a question (her voice can come back through a microphone); "Angel, stop" always works.

## How it works
- `join` joins with `selfDeaf: false`, waits up to 30 s for Ready, subscribes an audio player, and listens on `receiver.speaking` "start".
- `receiver.speaking` "start" emits `talking { userId, speaking: true, at }` and then listens; "end" emits `speaking: false`. Nothing after `leave`; an `isPerson` that throws counts as not a person. Who is a person is decided at the start and the end is passed on for whoever's start was (`talkers`; review of 0.1.3: a member cached as a bot between the two left the table busy for good).
- `listen(userId)` subscribes with `EndBehaviorType.AfterSilence` (`silenceMs`, default 900 ms); `gather` collects the packets, cuts a monologue every `maxUtteranceSeconds` and emits "speech" `{ userId, packets, startedAt, final }`. When a stream closes and the speaker is still marked speaking, it listens again at once.
- `packetsToWav`: decode (a rejected packet becomes 20 ms of silence; frames longer than 20 ms decode whole, review L7), stereo to mono, a 63-tap low-pass and every third sample (48 kHz to 16 kHz), loudness check, 16-bit WAV. Pieces under `minUtteranceMs` or below `minLevelDb` are skipped before anything is paid for.
- `speak(clips, { onStart })` queues clips behind what's playing (`onStart` is called once, when the first of them starts to play, for the timing line in the log); `stopSpeaking` bumps a token so queued clips are dropped and stops the player. `inEchoWindow(at)` judges by when the speech began, using the start and end of the last clips.
- The connection is joined with `debug: true`; of its debug messages only the `[DAVE]` ones are kept: key changes as `voice encryption: ...` lines, and packets that couldn't be decrypted (many a second) as one warning and a count every `tallyMs` (10 s). Broken-off audio is counted the same way.
- The deaf check (`checkDeaf`) runs at each speaking end of someone she listens to: talk time from the speaking signal (people `shouldListen` allows, so an opted-out player's talk, whose sound never comes, isn't counted) against packets that came through × 20 ms, over `deafWindowMs` (30 s) back to her last join. Not while the connection isn't Ready (the watchdog's job), nor within `rejoinCooldownMs` (2 min) of a rejoin. `rejoin` stops her speech and the listeners, ends everyone's talk for the floor (or the table would stay busy), destroys the connection, waits `rejoinPauseMs` (1 s), joins again and emits "rejoined"; a join that fails is "lost", and past `maxRejoins` (3) it is "lost" with `"deaf"`, which the bot answers with its own note. Events from the old connection are ignored (`stale`), so its Destroyed is not taken as a loss.
- A watchdog on every `stateChange`: whenever the connection leaves Ready it must be back within `reconnectMs` (30 s), else "lost" (a reconnect stuck half-way left her deaf; review L3). Disconnected: if no reconnect starts within 5 s (Signalling or Connecting), "lost" at once; only that timeout counts, since an `error` event also rejects the wait and is left to the watchdog. A Destroyed connection that wasn't Angel's own leave is "lost" too.

## Checks
- (vo-1) {live} in an encrypted call with three or more people talking for five minutes, the transcript has each person's words under their own name, with no stretches missing.
- (vo-2) {live} a 45-second monologue comes out as two lines, the first before the speaker stops.
- (vo-3) {live} Angel's voice is clear in the channel, and "Angel, stop" cuts her off mid-sentence.
- (vo-4) {live} someone joining and leaving mid-session (a DAVE key change) loses at most a word or two, and the log shows no crash.
- (vo-6) {unit} "talking" for people only (an opted-out player counts, a bot doesn't), nothing after leaving, and `ownSpeech` with the clip playing now (`test/voice.test.mjs`).
- (vo-7) {unit} the deaf check: talk with its sound isn't deaf, under 10 s of talk isn't, an opted-out player's talk isn't counted; deaf rejoins once, ends the talk for the floor, ignores the old connection, hears on the new one, holds off within the cool-down, gives up after `maxRejoins` with "lost" (deaf), a failed rejoin is "lost", a leave during the pause joins nothing; DAVE messages kept and counted; the session's spoken and written note; the bot's wiring (`test/voice.test.mjs`, `test/session.test.mjs`, `test/bot.test.mjs`).
- (vo-5) {unit} gathering, decoding, resampling, the echo window, the play queue and stop, the watchdog and the lost connection, and the real library reading an Ogg Opus clip into packets (`test/audio.test.mjs`, `test/capture.test.mjs`, `test/voice.test.mjs`).

## Traps
- @discordjs/voice destroys a speaker's stream with an error when a packet can't be parsed (`VoiceReceiver.onUdpMessage`): an unhandled "error" would crash the process. `gather` listens with `on("error")`, not `once`, keeps what was heard and the speaker is listened to again.
- `receiver.speaking` marks someone stopped 100 ms after their last packet, long before the 900 ms stream end, so a speaker can start again while the old stream is closing: hence the re-listen on close.
- @discordjs/voice reconnects most drops by going from Ready straight to Signalling, never through Disconnected, so the first fix (a wait for Ready inside the Disconnected handler) rarely ran (second review). Hence the watchdog on every state change.
- `receiver.speaking` "end" comes 100 ms after a speaker's last packet (`SpeakingMap.DELAY`, read in @discordjs/voice 0.19.2's code), for every user with an audio stream, bots too.
- In @discordjs/voice 0.19.2, `VoiceReceiver.onUdpMessage` pushes a packet only when decrypting gives one, and `DAVESession.decrypt` gives `null` while a key change is pending or the session reinitializes, without counting the failure: a key change that never completes means a speaking signal with next to no sound, for good. Its messages go only to the "debug" event, and only when the connection was made with `debug: true`.
- `joinVoiceChannel` gives back the existing connection for a guild until it is destroyed: a rejoin must destroy first.
- Discord sends no audio while someone is silent, so a stream's length is speech time, not wall time; `durationMs` is packets × 20 ms.

## Open items
