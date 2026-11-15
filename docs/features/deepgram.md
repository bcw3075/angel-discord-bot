---
feature: deepgram
files: [Choose Voice.cmd, src/stt.mjs, src/tts.mjs, src/speech.mjs]
functions: []
dependsOn: []
since: 0.1.0
---
Deepgram: turning each piece of speech into text, and Angel's voice; making answers sound right when spoken.

## Decisions
- **Every feminine Aura-2 English voice to choose from** (Rhea: "I want a sample of all female voices", 2026-11-14): `VOICES` in `tts.mjs` lists 24 of the 25 (one shares its name with a campaign name on the private word list, which no public file may hold), from a third-party copy of Deepgram's catalogue (Deepgram's own page isn't reachable from the build workspace), so `npm run voices` reports any that fail; `voiceFromName` takes a short name ("luna"). Deepgram now calls Aura-2 its previous generation, beside the newer Flux voices on /v2/speak: a later choice, not this release.
- **Deepgram for both listening and Angel's voice** (the owner, 2026-11-12, d-2; the other choices were a free program on her PC using the graphics card, or OpenAI). One account and key; new accounts get $200 of credit; billed per second.
- Listening: Nova-3 pre-recorded, one request per piece of speech, with the campaign's names as key terms (`keyterms.txt`).
- Voice: an Aura-2 voice (default `aura-2-thalia-en`; the owner picks from `npm run voices`), asked for as Ogg Opus. The eight voices `npm run voices` plays are all on Deepgram's own catalogue as feminine American Aura-2 English voices (checked 2026-11-13).
- **Aura-2 on `/v1/speak`, not Flux TTS** (checked 2026-11-13). Deepgram now calls Aura-2 its previous generation and recommends Flux TTS (`/v2/speak`) for new builds, but Aura-2 has no retirement date and `/v1/speak` is unchanged. Flux is built for streaming voice agents (speaking while the text is still being written); Angel speaks a finished answer, so it gains little, and it costs 50% more ($0.045 against $0.030 per 1,000 characters). Revisit if Aura-2 gets a retirement date, or if the owner prefers a Flux voice.
- **She speaks the whole answer** (the owner, 2026-11-12, d-1: "explain the answer in full in voice as well"), so the spoken copy is the full text minus links and symbols.

## How it works
- `transcribe(wav)`: POST to `/v1/listen` with `model` nova-3, `language` en, `smart_format`, `punctuate` and one `keyterm` per name, header `Authorization: Token <key>`; returns the text, its confidence and the billed seconds.
- `synthesize(text, { format })`: POST to `/v1/speak` with `model` (the voice), `encoding` opus and `container` ogg (or `mp3`, or 16 kHz `linear16` WAV for the check), body `{ "text": … }`.
- `chunkText` splits at sentence ends, then commas, then spaces, at most `TTS_MAX_CHARS` (1,800) a piece; the pieces play one after another.
- `SentenceCutter` (in `speech.mjs`) cuts text into sentences while it is still being written, for speaking an answer as it comes: a sentence ends at . ! or ? once the space after it has arrived (so "2.5" is never cut), sentences under 16 characters stay with the next, "e.g." and its kind end nothing; plain character steps, no regex. Each sentence is its own voice request, so a short pause between sentences is possible when the next clip isn't ready yet.
- `speakable` drops markdown and links and says "2d6" as "2 d 6", "+2" as "plus 2", "-1" as "minus 1", "e.g." as "for example".
- `oggPackets` reads the packets out of an Ogg file (used by the check and tests).
- `deepgramError` turns a refusal into a plain line: Deepgram explains it in JSON (`{"err_msg": "Invalid credentials."}`), and the words are kept without the braces, so `npm run check` can say what to do about it.

## Checks
- (dg-1) {live} in a real session, ten of the names in `keyterms.txt` said aloud come out spelled right in the transcript.
- (dg-2) {live} an answer of 1,500 characters or more is spoken whole, in pieces with no long gaps between them.
- (dg-4) {live} `Choose Voice.cmd` on the owner's PC saves a sample of every voice (any that fail are listed), opens the folder, and a typed name becomes her voice after a restart.
- (dg-5) {live} an answer spoken sentence by sentence sounds like one answer: no long gap or odd break between the sentences.
- (dg-3) {unit} the voice names, the request shapes, chunking, the sentence cutter, the spoken copy and the Ogg reader (`test/speech.test.mjs`).

## Traps
- `/v1/speak` takes at most 2,000 characters a request; longer answers must be split (`chunkText`).
- Key terms (`keyterm`) are a Nova-3 feature and a small extra charge per minute; the cost tally adds it when there is more than "Angel" in the list.

## Open items
- Deepgram calls Aura-2 its previous generation and points new work at its newer voice model; the voice is a config setting, so a newer model can be tried by name once its model string is known (check Deepgram's docs then).
