# Unverified items (one running list)

What a release did not prove, until it is checked live or dropped. Change records add to it with
`guide unverified add "<text>"`; close an item by editing its status in place:
`verified <date> in <version>: <text>. Seen: <what was seen>` or `dropped <date>: <text>. Why: <reason>`.
The gate counts the open ones; above the limit in `.modtools.json` a release must close some.

- (u-1) [0.1.0] open: The eight voice names in npm run voices (thalia, andromeda, helena, luna, athena, cora, electra, asteria, all aura-2-*-en) are real Deepgram voices: taken from third-party lists, not Deepgram's own catalogue; npm run voices on the owner's PC shows any that fail
- (u-2) [0.1.0] open: Claude's prompt cache: the answering system prompt (house rules included, about 6,000 tokens) is marked for the 5-minute cache; with questions often more than 5 minutes apart most calls will write the cache again. The 1-hour cache would likely be cheaper over a session but wasn't used because it couldn't be tried here; check the real cost per question at install (an-1, se-1) and decide
