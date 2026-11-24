---
feature: messages
files: [src/outbox.mjs, src/dm.mjs]
functions: []
dependsOn: [discord, setup]
since: 0.2.0
---
Messages outside a session: approved messages a Claude chat leaves in her outbox are sent once (a direct message or a channel post), and direct messages from a named contact are answered from that contact's notes file, with requests, bugs and unanswered questions saved for the owner.

## Decisions
- **She sends what the owner approved, nothing of her own** (the owner, 2026-11-23: "have you send people messages and updates for me"). A Claude chat linked to the owner's PC writes one small JSON file per message into `data/outbox/`; Angel only delivers it. Full automation is the goal, but the first messages to anyone are drafted with the owner and sent on her yes; the chat that writes the file is the one that asks.
- **Never sent twice** (Angel's choice): a file is moved into `sending/` before it is sent, so a second look can't take it; one still there at the start (she stopped mid-send) is filed as failed with a note to check Discord, never retried. Results go to `sent/` (where, when, the message id) or `failed/` (why). A file written in the last two seconds waits for the next look, as it may still be arriving.
- **Nobody is pinged** (`allowedMentions: { parse: [] }`): a mention in the text shows as a name only.
- **20 messages an hour at most** (Angel's choice): the rest wait in the outbox for the next hour, so a runaway chat can't flood anyone.
- **Contacts by name** (Angel's choice): `data/contacts.json` on the owner's PC maps a name to a user id, a Discord username or a channel id, so a chat in another project can write `{ "contact": "<name>" }` without knowing (or keeping) anyone's id. A username is looked up on the servers she shares with them by exact username (`members.search`, which needs no members intent).
- **Answers only from the notes** (the owner, 2026-11-23: a contact can reply "with questions and have you answer him"): only a contact with a `notes` file in `data/notes/` is answered; anyone else gets nothing and costs nothing. She says so when the notes don't cover something and saves the question for the owner rather than guessing. A notes path outside `data/notes/` is refused.
- **Requests and bugs** (the owner, 2026-11-23): a request is thanked at once, told it is logged and that the owner will look it over, and told it will hear when it is accepted, being built and live; she may push back kindly, or show a way that already exists first. A reported bug is told it will be checked and fixed: bugs don't wait for the owner's approval (her rule). Both are saved in `data/inbox/` and sent to the owner by direct message.
- **The notes can be long** (the owner, 2026-11-23: "She needs to be able to answer any question" about what the notes describe; "index ... so ... she knows exactly what info to pull"): notes with the marker `<!-- angel: sections below -->` are split into a summary and one section per heading (levels 2 to 4). She gets the summary and an index of the sections in her cached instructions, and two tools, `search_notes` and `read_sections`, five lookups at most; after that she is told to answer from what she has. Notes without the marker are given whole.
- **Cached for an hour** (`answerCacheTtl`, the owner's ask to use the cache): the notes and instructions are one cached block, so the first message of a conversation pays for them and the rest read them cheaply.
- **Short paragraphs and bullets** (the owner's request, made to her by direct message during a test): no run-on sentences, a bullet for any list.
- **Spending is capped**: each reply is counted against the daily dollar cap (`maxDailyDollars`), 40 replies a day at most, one exchange at a time per person.

## How it works
- A message file: `{ "to": "owner" | { "user": "<id>" } | { "channel": "<id>" } | { "contact": "<name>" }, "text": "..." }`, 2,000 characters at most. "owner" is whoever owns the bot in the Developer Portal (a team's owner too). A channel must be a text channel on a server she is in.
- `Outbox` (src/outbox.mjs) looks every 5 s; `send` is the bot's `sendOut`, passed in so tests stand in for Discord. `readMessage` checks a file; `resolveContact` turns a contact into a user, username or channel. At start the bot writes `data/places.json`: each server and the text channels she can post in, with ids.
- `DirectReplies` (src/dm.mjs): the bot hands it every direct message (`onMessage` without a guild; the DirectMessages intent and the Channel partial). `contactOf` finds the contact by id or username; the reply is one JSON object `{ reply, kind, forOwner }` (kind is answer, request, bug, unknown or chat), read by `readReply` (the last valid object, so a reply written twice or with words around it sends only the reply). Both sides go to `data/conversations/<name>.md` and `.json`; the last 8 exchanges are given with the next message.
- `splitNotes`, `indexText`, `searchNotes` (every word, any capitals), `readSections` (90,000 characters at most), `NOTE_TOOLS`. After the last lookup the call is made with `tool_choice: { type: "none" }`; a tool choice is never forced.
- Settings: `outbox` and `directReplies` (both on by default; `false` turns each off), `answerCacheTtl`.

## Checks
- (ms-1) {unit} a message file names the owner, a user id, a channel id or a contact; anything else is refused (`test/outbox.test.mjs`).
- (ms-2) {unit} an approved message is sent once and filed in sent/ with where it went.
- (ms-3) {unit} a bad file or a refused send goes to failed/ with why and is not tried again.
- (ms-4) {unit} a file still arriving waits; other files are left alone.
- (ms-5) {unit} a file left in sending/ by a crash is filed as failed, never sent.
- (ms-6) {unit} past the hourly limit the rest wait.
- (ms-7) {unit} places lists each server's text channels she can post in.
- (ms-8) {unit} sendOut: the owner, a user, a text channel, with no pings; a voice channel is refused.
- (ms-9) {unit} a contact's name or username is resolved; an unknown one fails and is not sent.
- (ms-10) {unit} readReply takes the JSON asked for, a fenced or wrapped one, and the last of two (seen live) (`test/dm.test.mjs`).
- (ms-11) {unit} a contact's question is answered from the notes, counted, both sides kept, the conversation carried on.
- (ms-12) {unit} a request or a bug is thanked, saved in the inbox and sent to the owner.
- (ms-13) {unit} someone not a contact, or without notes, gets no answer and costs nothing; a notes path outside data/notes, a failed call or the limit gives a holding reply saved for the owner.
- (ms-14) {unit} two messages at once are answered in order.
- (ms-15) {unit} long notes split at the marker, searched and read by section; past the lookup limit no more tools.
- (ms-16) {live} her PC, 2026-11-23: the owner's direct message, a username lookup, an outbox message to a contact, and a contact's questions answered from indexed notes (search_notes then read_sections in the log).

## Traps
- The device link can't delete or move files on the owner's PC, so dealt-with inbox files are listed in a file beside them instead of being moved (whoever deals with them keeps that list; the bot never reads it).
- A model asked for JSON may write prose around it, or the object twice with a correction between: `readReply` takes the last valid object (seen live, 2026-11-23).
