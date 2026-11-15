---
feature: floor
files: [src/floor.mjs]
functions: []
dependsOn: [voice]
since: 0.1.3
---
Who has the floor: who is talking now, from Discord's speaking signal, and a wait for a gap before she speaks.

## Decisions
- **A busy table means anyone talking**, the asker included; a blip under about half a second (a cough, "mm") doesn't count (Rhea, 2026-11-15, design d-7: "Anyone talking", the recommended choice; the others offered were "others, not the asker" and "anyone, blips too").
- **It comes from Discord's speaking signal, not from what is heard** (Angel's choice within d-7): free, nothing is transcribed or paid for, and it knows at once. A person who opted out of being transcribed still counts as talking, since only the fact that they talk is used; other bots don't count (`isPerson`, voice).
- **One reusable piece** (Rhea's plan: "it shares 'notice a busy table, wait for a gap' with chiming in"): the session asks `busy()` and waits on `waitForQuiet`; chiming in will use the same.
- **Talk that began while she was speaking counts only from the end of her speech plus half a second** (Angel's choice): her voice can come back through a player's microphone and mark that player as talking, and right after her quick reaction that would read as a busy table. Someone who started over her and keeps going past that counts.
- A pause shorter than 0.4 s between one speaker's words is the same stretch of talk, so a breath mid-sentence isn't a gap.

## How it works
- `talk(userId, speaking, at)` keeps each speaker's stretches of talk `{ start, end }` (end null while talking); a start within `mergeMs` of their last end reopens it. Stretches older than five minutes are dropped.
- `effectiveStart` moves a stretch's start to the end of her own speech (plus `echoTailMs`) when it began inside it; `ownSpeech()` comes from the voice link: her recent clips and the one playing now as `[start, null]`. `counted` is a stretch whose counted part is at least `blipMs`.
- `busy(at)`: anyone whose last stretch counts and is still going, or paused shorter than `mergeMs`.
- `quietFor(at, since)`: how long since the last counted talk ended, from `since` at the earliest; 0 while anyone is mid-word (a blip so far included), unless all of it is still inside her own echo window.
- A stretch still open after `maxSpellMs` (ten minutes) is taken as ended then, and the speaker's next start counts: a lost end can't keep the table busy for good (review of 0.1.3).
- `lastEnds(minMs, joinMs)`: each speaker's latest finished talk at least `minMs` long, measured from when it really began, stretches less than `joinMs` apart taken together; talk that is all her own voice coming back is left out. The session waits until it has been heard (review 4 and 5 of 0.1.3). `waitForQuiet`'s `blocked()` holds a quiet back while the caller still has something unheard, and `orBusy` also resolves "busy" when someone talks again.
- `waitForQuiet(needMs, { maxMs, since })` polls every `pollMs` (100 ms) and resolves `"quiet"`, `"timeout"`, or the reason given to `wake(reason)` (the first one stands). `needMs` Infinity waits for a wake or the timeout only. The poll timer is not unref'd: a hold always has a limit.

## Checks
- (fl-1) {unit} a blip doesn't count, a breath between words is the same stretch, quiet is measured from the last real talk and from `since`, talk inside her own echo window doesn't count, and the wait resolves on quiet, on its limit or on a wake (`test/floor.test.mjs`).
- (fl-2) {live} at a table of two or more on her PC: while someone talks as her answer is ready, the log says "the table is busy"; a cough doesn't; right after her quick reaction, nobody talking, she isn't held (her own voice in a microphone is not the table).

## Traps
- Discord marks a speaker stopped 100 ms after their last packet (`SpeakingMap.DELAY`, @discordjs/voice 0.19.2), so a short pause mid-sentence flips it off and on: hence `mergeMs`.

## Open items
