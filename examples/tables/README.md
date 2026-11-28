# Tables

Each game table Angel serves gets its own folder in `tables\` beside the code, for example `tables\my-table\`.
Nothing in one folder ever reaches another table. Copy `example-table` and change it.

`table.json`:
- `server`: the Discord server's id in quote marks (Developer Mode on, right-click the server, Copy Server ID),
  or its exact name: the first time Angel sees exactly one server of that name she writes its id in here herself,
  and from then on only that server is this table's.
- `channels` (optional): the text channels this table uses, by name (`"#rules-help"`) or id. `/angel join` typed in
  a named channel picks this table even when another table is on the same server. Leave it out to serve the whole
  server. Name the table's voice channel too: `/angel join` typed elsewhere while you sit in it is then refused,
  so one table's game is never heard as another's.
- `game`: the game. Angel can answer rules questions for Pathfinder 2e only; any other game is listen-only.
- `answers`: `true` to answer questions, `false` to only listen and keep the transcript (she says so once in writing
  and never speaks). Left out or unreadable means `false`.
- `transcriptKeptBy` (optional): whose computer the transcript is kept on, as the join notice says it
  (`"Sam"` gives "on Sam's computer"). Left out: "the GM's computer".
- `costs` (optional): where the session's cost goes when it ends. `"channel"` posts it with the summary;
  `"owner"` sends it to the bot's owner by direct message and leaves it out of what the table sees. Left out: posted
  on a server the bot's owner owns, sent by direct message anywhere else.

Beside it, all optional: `house-rules.md`, `keyterms.txt` and `speakers.json`, as described in the main README.
Each session's transcript goes in `data\sessions\<folder name>\`.
