---
feature: voice
files: [src/voice.mjs, src/capture.mjs, src/audio.mjs]
functions: []
dependsOn: []
since: 0.1.0
---
Being in the voice channel: joining with Discord's end-to-end encryption, hearing each speaker in pieces, playing Angel's voice.

## Decisions
- The echo guard's time rule is softened for one case (session.mjs `echoOf`): a reply without her name, from the person she just answered, that begins inside the guard is kept unless 70% of its words are in what she just said (2026-11-14: Rhea's "Nice. And does that stack...?" began 2 s after Angel stopped and was dropped).
- **A join that times out says where it stopped** (2026-11-14: the first live `/angel join` on Rhea's PC timed out and the log was empty): every connection step is logged as `voice: <status>` while joining, the timeout logs the steps, and stuck at `connecting` (Discord answered, the UDP voice link never opened) the message names Windows Firewall instead of permissions.
- Node with `@discordjs/voice` 0.19.2 and `@snazzah/davey` (pinned). Since 2 March 2026 Discord refuses voice connections without DAVE end-to-end encryption, bots included; @discordjs/voice's receive bug with encrypted audio (discord.js issue 11419) was fixed by PR 11449 (13 March 2026) and 0.19.2 (17 March 2026) has it. (Angel's choice, 2026-11-12, in the design.)
- Opus is decoded with `opusscript` (WebAssembly), so nothing needs compiling on Windows.
- Angel's voice is played as Ogg Opus straight from Deepgram (`StreamType.OggOpus`): no FFmpeg on the owner's PC.
- Speech that began while Angel was talking, or within `echoGuardMs` after, is not taken as a question (her voice can come back through a microphone); "Angel, stop" always works.

## How it works
- `join` joins with `selfDeaf: false`, waits up to 30 s for Ready, subscribes an audio player, and listens on `receiver.speaking` "start".
- `listen(userId)` subscribes with `EndBehaviorType.AfterSilence` (`silenceMs`, default 900 ms); `gather` collects the packets, cuts a monologue every `maxUtteranceSeconds` and emits "speech" `{ userId, packets, startedAt, final }`. When a stream closes and the speaker is still marked speaking, it listens again at once.
- `packetsToWav`: decode (a rejected packet becomes 20 ms of silence; frames longer than 20 ms decode whole, review L7), stereo to mono, a 63-tap low-pass and every third sample (48 kHz to 16 kHz), loudness check, 16-bit WAV. Pieces under `minUtteranceMs` or below `minLevelDb` are skipped before anything is paid for.
- `speak(clips, { onStart })` queues clips behind what's playing (`onStart` is called once, when the first of them starts to play, for the timing line in the log); `stopSpeaking` bumps a token so queued clips are dropped and stops the player. `inEchoWindow(at)` judges by when the speech began, using the start and end of the last clips.
- A watchdog on every `stateChange`: whenever the connection leaves Ready it must be back within `reconnectMs` (30 s), else "lost" (a reconnect stuck half-way left her deaf; review L3). Disconnected: if no reconnect starts within 5 s (Signalling or Connecting), "lost" at once; only that timeout counts, since an `error` event also rejects the wait and is left to the watchdog. A Destroyed connection that wasn't Angel's own leave is "lost" too.

## Checks
- (vo-1) {live} in an encrypted call with three or more people talking for five minutes, the transcript has each person's words under their own name, with no stretches missing.
- (vo-2) {live} a 45-second monologue comes out as two lines, the first before the speaker stops.
- (vo-3) {live} Angel's voice is clear in the channel, and "Angel, stop" cuts her off mid-sentence.
- (vo-4) {live} someone joining and leaving mid-session (a DAVE key change) loses at most a word or two, and the log shows no crash.
- (vo-5) {unit} gathering, decoding, resampling, the echo window, the play queue and stop, the watchdog and the lost connection, and the real library reading an Ogg Opus clip into packets (`test/audio.test.mjs`, `test/capture.test.mjs`, `test/voice.test.mjs`).

## Traps
- @discordjs/voice destroys a speaker's stream with an error when a packet can't be parsed (`VoiceReceiver.onUdpMessage`): an unhandled "error" would crash the process. `gather` listens with `on("error")`, not `once`, keeps what was heard and the speaker is listened to again.
- `receiver.speaking` marks someone stopped 100 ms after their last packet, long before the 900 ms stream end, so a speaker can start again while the old stream is closing: hence the re-listen on close.
- @discordjs/voice reconnects most drops by going from Ready straight to Signalling, never through Disconnected, so the first fix (a wait for Ready inside the Disconnected handler) rarely ran (second review). Hence the watchdog on every state change.
- Discord sends no audio while someone is silent, so a stream's length is speech time, not wall time; `durationMs` is packets × 20 ms.

## Open items
