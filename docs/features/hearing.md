---
feature: hearing
files: [src/hearing.mjs]
functions: []
dependsOn: [voice, session, discord]
since: 0.2.0
---
Is she still hearing the table? A watch on what becomes of each piece of speech; when she stops hearing she mends what she can and tells the owner at once, in writing.

## Decisions
- **When she stops hearing, the owner is told at once** (the owner, 2026-11-22, after a talk of 85 minutes gave 8 lines while she sat in the channel looking fine: "if that happens again, she really needs to message me and tell me"). The owner is whoever typed `/angel join`. It is a direct message, and the same words where the session posts (its thread), with a ping there only if the direct message couldn't be sent. Never aloud: at a table where she only listens she must stay silent in voice.
- **The way a warning would come is tried at every join** (Angel's choice): she sends the owner one direct message as the session starts ("If I stop hearing the table, I'll message you here straight away"). If it can't be sent (Discord's privacy setting), the session's channel says so with a ping, and warnings will ping there. A warning path that fails silently would be the same fault again.
- **Three kinds of trouble** (Angel's choice): pieces of sound that can't be decoded, three in a row (`decode`); the transcriber failing three times in a row (`transcriber`), each kind counted by itself, and a piece that decodes (even one too quiet to send) ends the decode run; and, as the net under both, a minute or more of talk by people she listens to with not one word written down for three minutes (`quiet`), whatever the cause. One failed piece among good ones alarms nobody.
- **She mends what she can first** (Angel's choice): for `decode` and `quiet` every speaker's decoder is dropped (fresh ones are made at the next piece) and she leaves and rejoins the voice channel, then says in the message that she is doing so. For `transcriber` there is nothing to mend on her side, so she says why and keeps trying. She leaves the voice link's last rejoin for its own deaf check (after it the link gives up and leaves), and talk without words gets one rejoin a session, since it can be an open microphone. A rejoin that fails to join ends the session as a lost connection, which the owner is told as well. For transcriber trouble the later message says that leaving and joining won't mend it and what to check instead.
- **A rejoin can be asked for, to see it work** (`/angel rejoin`, for hr-19; Angel's choice, offered to the owner 2026-11-22): only whoever started the session, since it costs the table a few seconds of transcript. It is the same leave and join as a mending rejoin, but nothing went wrong, so it is no warning, is never said aloud, and never uses up the rejoins her hearing has.
- **Past a spending cap the watch rests** (review 1): she has stopped listening on purpose and said so, so talk without words is no trouble then.
- **While it lasts she says so again**: after 2 minutes ("still not hearing": `/angel leave` and `/angel join`, then restart her), then every 10 minutes, six messages for one trouble at most. The owner is told when it is over, with from when to when nothing was written down: decode trouble ends when a piece decodes again, transcriber trouble when the transcriber answers, talk without words only when words are written down. "Still" for decode and talk-without-words trouble is said only if people have talked for 20 s since she mended herself, so a table gone quiet isn't reported as unheard. Trouble of the other kind on top of one already told is told and mended as its own.
- A false alarm (a `quiet` warning for an open microphone) is accepted: a message too many is better than a session unheard.

## How it works
- `HearingWatch` (src/hearing.mjs) has no timers and no Discord: the session tells it `ok()` (a piece decoded and the transcriber answered), `line()` (words written down), `bad(kind, detail)`, `talking(userId, speaking, at)`, `fresh()` (after a rejoin) `decoded()` (a piece turned into audio), and calls `tick()` every 15 s (`hearingTick`; not past a cap). It calls back `onTrouble`, `onStill`, `onBack`.
- `ok` ends `decode` and `transcriber` trouble; only `line` ends `quiet`. Talk is counted from Discord's speaking signal for people `shouldListen` allows, from the last words (or the last rejoin) on, talk under way included.
- The session (`toWav`, `transcribe`, `hearingTrouble`, `hearingStill`, `hearingBack`, `tell`): a piece its decoder throws on, or rejects more than half the packets of, is tried once more with a fresh decoder; only if that fails is it `bad("decode")`. `tell` logs the message (`to the owner: ...`) and hands it to `alert`, which the bot gives the session.
- The bot (`alert` in the join handler): `{where}` becomes the voice channel and server; a direct message to the starter, then the session's channel. A lost voice connection (`lost`) posts its note in the channel at once, ahead of the summary that closes the thread, and ends the session without waiting; the direct message follows, with a ping in the channel if it can't be sent. Only the session the voice link belongs to is ended, once.
- **Her own leave during a rejoin doesn't end the session** (review 2): Discord reports the leave to the bot (`onVoiceState`), which used to end the session as "removed from the voice channel", so the rejoin stopped half-way and she never came back. The deaf rejoin of 0.1.3 had this fault and had never run live. While `voice.rejoining` the bot ignores her own voice state. The voice link's own deaf rejoin is told too; a rejoin the session asked for is not told twice.

## Checks
- (hr-1) {unit} three lost pieces in a row are trouble, told once, from the first; a good piece between starts the count over (`test/hearing.test.mjs`).
- (hr-2) {unit} "still" after 2 minutes, then every 10, six messages at most.
- (hr-3) {unit} a piece that works ends decode and transcriber trouble, with from and until; the next trouble is told afresh.
- (hr-4) {unit} the net: a minute of talk and no word for three minutes; only words end it; quiet at a quiet table and when words keep coming.
- (hr-5) {unit} a rejoin starts the count of talk without words over.
- (hr-6) {unit} a callback that throws doesn't break the watch.
- (hr-7) {unit} six speakers in one session are all written down (`test/hearing-session.test.mjs`, the real decoder).
- (hr-8) {unit} a decoder gone bad, or one that can't be made, costs at most that piece: a fresh one is used and nobody is alarmed.
- (hr-9) {unit} nobody can be decoded (a throw, or packets rejected): after three pieces the owner is told, decoders dropped, one rejoin, one message however many pieces follow, "still" after two minutes, "again" with the times when sound decodes.
- (hr-10) {unit} the transcriber failing three times running is told with its reason and no rejoin; one timeout among good pieces is not.
- (hr-11) {unit} the net in a session: talk with every piece too quiet to send; an opted-out player's talk not counted; one rejoin a session for it.
- (hr-12) {unit} no rejoin when the voice link has only its last one left.
- (hr-13) {unit} the voice link's own rejoin is told to the owner; a rejoin she asked for, or one already under way when her trouble began, is not a second message.
- (hr-14) {unit} at an answering table the warning is written, never spoken.
- (hr-15) {unit} nothing is told after the session ends; a failing alert breaks nothing.
- (hr-16) {unit} past a spending cap: no trouble, no rejoin, no warning.
- (hr-20) {unit} a rejoin the owner asks for (`/angel rejoin`) is the voice link's real leave and join, logged as asked and not as a warning; it never counts against the rejoins her hearing may use and never gives up, so her own deaf rejoin is still there afterwards; none while one is under way or after she left (`test/voice.test.mjs`).
- (hr-21) {unit} the session's side: an asked rejoin is posted in the thread, never a warning to the owner and never aloud (at an answering table too); refused while a rejoin or a mend is under way and after the session ended; trouble that comes during an asked rejoin takes it as its mend, and the voice link's later rejoins are told as before (`test/hearing-session.test.mjs`).
- (hr-22) {unit} four people talking over each other where she only listens, transcribed out of order: every piece written down in the order it was said, one decoder each, nobody alarmed; and a long session of 400 pieces from twelve people, every piece decoded.
- (hr-19) {live} a rejoin on the owner's PC: the log shows "rejoining the voice channel", then "back in the voice channel", the session goes on and later talk is in the transcript. It has never been seen live; `/angel rejoin` (hr-20, hr-21, dc-14) makes one happen on purpose, through the same leave and join.
- (hr-17) {live} on the owner's PC with four or more people talking in the voice channel for ten minutes: every speaker's words are in the transcript, the log has no "couldn't be decoded", and the owner got the direct message at the join.
- (hr-18) {live} a warning really reaches the owner: with the owner's direct messages from the server switched off, the join says so with a ping in the session's channel.

## Traps
- `tell` runs the alert in a later microtask, so a test waits before counting messages.
- Lines in the log starting `to the owner:` are the messages as sent, with "the voice channel" in place of its name.

## Open items
- Discord's own report of her leave during a rejoin is read from @discordjs/voice's `destroy` (it sends the leave), not seen live; `/angel rejoin` is the way to see it (hr-19).
- A warning the owner would notice away from Discord (a sound on her PC, a phone notification) is not built.
