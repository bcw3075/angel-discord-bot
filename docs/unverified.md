# Unverified items (one running list)

What a release did not prove, until it is checked live or dropped. Change records add to it with
`guide unverified add "<text>"`; close an item by editing its status in place:
`verified <date> in <version>: <text>. Seen: <what was seen>` or `dropped <date>: <text>. Why: <reason>`.
The gate counts the open ones; above the limit in `.modtools.json` a release must close some.

- (u-1) [0.1.0] verified 2026-11-13 in 0.1.0: The eight voice names in npm run voices (thalia, andromeda, helena, luna, athena, cora, electra, asteria, all aura-2-*-en) are real Deepgram voices: taken from third-party lists, not Deepgram's own catalogue; npm run voices on the owner's PC shows any that fail. Seen: all eight on Deepgram's own catalogue (developers.deepgram.com/docs/tts-models) as feminine American Aura-2 English voices; a voice that fails on the owner's PC would still show in npm run voices
- (u-2) [0.1.0] dropped 2026-11-13: Claude's prompt cache: the answering system prompt (house rules included, about 6,000 tokens) is marked for the 5-minute cache; with questions often more than 5 minutes apart most calls will write the cache again. The 1-hour cache would likely be cheaper over a session but wasn't used because it couldn't be tried here; check the real cost per question at install (an-1, se-1) and decide. Why: decided from the pricing and caching docs instead: the 1-hour cache is now the default (answerCacheTtl), about 4 cents of cache writes a session instead of about 30; that it really reads on the live API is u-3
- (u-3) [0.1.0] open: The 1-hour prompt cache works on the live API: on the owner's PC, two npm run ask questions a minute apart, the first showing tokens written and the second about 6,000 read (and no 400 error for the ttl field)
- (u-4) [0.1.0] open: How long Windows lets Angel run after her window is closed (Node's docs say about 10 seconds; Microsoft's figure for closing a console may be 5): sessions get 4 seconds to end and post their summaries, after the day's spending is booked, so at worst a summary post is lost
