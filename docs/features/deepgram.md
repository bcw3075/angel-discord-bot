---
feature: deepgram
files: [src/stt.mjs, src/tts.mjs, src/speech.mjs]
functions: []
dependsOn: []
since: 0.1.0
---
Deepgram: turning each piece of speech into text, and Angel's voice; making answers sound right when spoken.

## Decisions
- **Deepgram for both listening and Angel's voice** (the owner, 2026-11-12, d-2; the other choices were a free program on her PC using the graphics card, or OpenAI). One account and key; new accounts get $200 of credit; billed per second.
- Listening: Nova-3 pre-recorded, one request per piece of speech, with the campaign's names as key terms (`keyterms.txt`).
- Voice: an Aura-2 voice (default `aura-2-thalia-en`; the owner picks from `npm run voices`), asked for as Ogg Opus.
- **She speaks the whole answer** (the owner, 2026-11-12, d-1: "explain the answer in full in voice as well"), so the spoken copy is the full text minus links and symbols.

## How it works
- `transcribe(wav)`: POST to `/v1/listen` with `model` nova-3, `language` en, `smart_format`, `punctuate` and one `keyterm` per name, header `Authorization: Token <key>`; returns the text, its confidence and the billed seconds.
- `synthesize(text, { format })`: POST to `/v1/speak` with `model` (the voice), `encoding` opus and `container` ogg (or `mp3`, or 16 kHz `linear16` WAV for the check), body `{ "text": … }`.
- `chunkText` splits at sentence ends, then commas, then spaces, at most `TTS_MAX_CHARS` (1,800) a piece; the pieces play one after another.
- `speakable` drops markdown and links and says "2d6" as "2 d 6", "+2" as "plus 2", "-1" as "minus 1", "e.g." as "for example".
- `oggPackets` reads the packets out of an Ogg file (used by the check and tests).

## Checks
- (dg-1) {live} in a real session, ten of the names in `keyterms.txt` said aloud come out spelled right in the transcript.
- (dg-2) {live} an answer of 1,500 characters or more is spoken whole, in pieces with no long gaps between them.
- (dg-3) {unit} the request shapes, chunking, the spoken copy and the Ogg reader (`test/speech.test.mjs`).

## Traps
- `/v1/speak` takes at most 2,000 characters a request; longer answers must be split (`chunkText`).
- Key terms (`keyterm`) are a Nova-3 feature and a small extra charge per minute; the cost tally adds it when there is more than "Angel" in the list.

## Open items
- Deepgram calls Aura-2 its previous generation and points new work at its newer voice model; the voice is a config setting, so a newer model can be tried by name once its model string is known (check Deepgram's docs then).
