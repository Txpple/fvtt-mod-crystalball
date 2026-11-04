# The Seer's contract

What the module (the client half, `scripts/`) and the Seer (the server half, `seer/`) agree on. Both are built
to this file; a change to it is made here first. The plan is `../../docs/plans/crystalball.md` in the suite repo.

## Words

- **Crystal Ball**: the module, its button and its window. **The Seer**: the Node service beside Foundry.
- **The ball's user**: the Foundry user (role Player) the Seer is logged in as, on its own socket, always.
- **A sitting**: one conversation between one Foundry user and the ball. One open sitting per user.
- **The gaze**: what the ball knows for one user at one moment, built by the Seer from the live world.

## Transport

The window talks to the Seer over HTTP at `serviceUrl` (a world setting). Every request carries
`X-Foundry-Session: <the player's session id>`: the id Foundry handed the client's own socket at connect,
`game.socket.session.sessionId` (Foundry 14 sets the `session` cookie HttpOnly, so `document.cookie` never shows
it); the client takes the socket's copy first and falls back to a `session` cookie only when the socket has none
(older builds); the two are the same value. No other authentication. No cookies are relied on.

- prod: `serviceUrl` is the same-origin path `/crystalball` (the tunnel routes it to the Seer; no CORS).
- a sandbox: `serviceUrl` stays at that default. On a plain-http page the path names Foundry's own origin, which
  a sandbox with no proxy serves nothing at, so the window also tries **the companion port**: the same path on
  port 30001 (the Seer's default `PORT`) of the host the page reached Foundry by,
  `http://localhost:30001/crystalball` from the machine itself and `http://<that host>:30001/crystalball` from
  another device on the network. The companion is tried only on an `http:` page whose setting is the default
  (empty, or a bare path with no scheme, on the page's own origin): an `https:` page sits behind a proxy or tunnel,
  where the Seer answers on the page's own origin and a bare port answers nothing or hangs, so it gets the one
  candidate; a full URL, on Foundry's origin or another, is asked alone (a Seer on another `BASE_PATH` or port is
  named that way and gets no companion); a page already on port 30001 gets none. The Seer on a sandbox binds
  every address (`BIND=::`) and answers CORS for the sandbox's origins (`CORS_ORIGIN`, one origin, a list or `*`;
  preflight `OPTIONS`, `Access-Control-Allow-Origin: <the origin, or *>`, `Access-Control-Allow-Headers:
  Content-Type, X-Foundry-Session`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`).
- the window's search: `healthz` at each candidate in turn, a 3-second probe with no `X-Foundry-Session` header
  (healthz wants none; a simple GET, no preflight); the first that answers 200 is the Seer for every later call
  (a Seer that answers but reports no link or no world is still it: the ball is dark for that reason), and the
  answer counts only while the search that found it is the current one (a `serviceUrl` change starts a new
  search). No candidate answering, the ball is dark. A dark window asks again every ten seconds while it is open
  and the reason can heal: the Seer unreachable, its link or its world down, a server or network failure of the
  sitting call; it stays dark on screen while it asks and lights when an answer comes. A refusal (401, 403, any
  other 4xx) is final until Retry or a reopen; Retry asks at once and shows the loading state.

All responses are JSON (`application/json`) except `POST chat`, which is `text/event-stream`.

### Errors (any endpoint)

| Status | Body | When |
| --- | --- | --- |
| 401 | `{ "error": "unknown-session" }` | the header is missing, or Foundry does not know the session / it has not joined the world |
| 403 | `{ "error": "not-allowed" }` | the user may not ask (the *Who may ask* setting), or the module is disabled in the world |
| 413 | `{ "error": "too-long", "limit": 4000 }` | the message is over the limit |
| 429 | `{ "error": "limit", "scope": "hour" \| "day" \| "table-day" \| "table-month", "retryAfter": <seconds> }` | a cap is hit |
| 503 | `{ "error": "dark", "reason": "foundry-disconnected" \| "world-closed" \| "model" }` | the ball's user is not connected, the world is not open, or the model call failed |
| 500 | `{ "error": "seer", "message": "<short>" }` | anything else; nothing sensitive in `message` |
| 400 / 404 / 405 | `{ "error": "seer" }` | a malformed request, an unknown path, a wrong method |

### `GET healthz`

`{ "version": "<the Seer's version, = module.json's>", "foundry": { "connected": bool, "worldOpen": bool,
"counted": bool | null, "world": "<id or null>", "ballUser": "<name or null>" }, "model": "<model id or 'stub'>",
"uptimeSeconds": n, "timeZone": "<the zone the limits' calendar follows>" }`. Always 200. No secrets, no paths.
`counted` is Foundry's own last word on whether it counts the ball's user present in the world (what `user.active`,
the Players list and `/api/status` read; see *Presence*): null until first asked after a join, false while the
link is down. A tool that discounts the ball from Foundry's count of users discounts it only while this is true.

### `GET sittings/current`

The caller's open sitting: `{ "id": "<id>", "startedAt": "<iso>", "model": "<id>", "turns": [ { "role": "user" |
"ball", "text": "<text>", "at": "<iso>" } ], "usage": { "messages": n, "cost": <usd> } }`. A user with no sitting
yet gets one created (empty) on this call.

### `POST sittings/new`

Closes the open sitting (archived on disk) and opens a fresh one: `{ "id": "<id>", "startedAt": "<iso>" }`.

### `GET usage/me`

`{ "user": { "hour": n, "day": n }, "table": { "day": { "messages": n, "cost": <usd> }, "month": { "messages": n,
"cost": <usd> } }, "limits": { "perUserHour": n, "perUserDay": n, "tableDayUsd": x, "tableMonthUsd": x } }`.
`perUserHour` or `perUserDay` is `null` when the configured model has no such cap (see *Limits*); the window then
shows no count, since there is no allowance to count against.

### `POST chat`

Body `{ "message": "<text>" }`. The reply is a Server-Sent Events stream (`Content-Type: text/event-stream`,
`Cache-Control: no-cache`, `X-Accel-Buffering: no`); each event is `event: <name>\ndata: <json>\n\n`:

| event | data | notes |
| --- | --- | --- |
| `meta` | `{ "sittingId", "model", "gazeTokens": n, "layers": { "instructions": n, "lore": n, "party": n, "own": n } }` | first; token counts are the Seer's estimate (or `count_tokens` when a key is present) |
| `delta` | `{ "text": "<piece>" }` | zero or more; the answer in order; a hop's words after an earlier hop's begin with a blank line (`"\n\n"`) |
| `lookup` | `{ "action": "search", "query": "<words>" }` or `{ "action": "read", "name": "<entry>", "book": "<book>" }` | zero or more, between deltas; the ball is looking something up in the rulebooks; the window says so under the pending turn until the next delta (a window that knows no `lookup` ignores it) |
| `done` | `{ "text": "<the whole answer>", "usage": { "input": n, "cacheWrite": n, "cacheRead": n, "output": n }, "cost": <usd>, "remaining": { "hour": n | null, "day": n | null }, "stop": "<the model's stop reason>" }` | last on success; `stop` is the API's `stop_reason` (`end_turn` for the stub), and `max_tokens` means the answer ran into `config.maxOutputTokens`, which the window marks under the answer |
| `error` | `{ "error": "<code as in the table above>", "message": "<short>", "reason"?: "<as the 503 body's>", "scope"?: "<as the 429 body's>", "retryAfter"?: <seconds> }` | last on failure after the stream opened; `reason` rides with `dark`, `scope` and `retryAfter` with `limit`, so the window words it as it would the status |

The client reads the stream with `fetch` and a `ReadableStream` reader (an `EventSource` cannot send the header).
A sitting's turn is stored only when `done` is sent. The Seer aborts the model call if the client disconnects.

## World settings the Seer reads

Scope `world`, namespace `fvtt-mod-crystalball`, registered by the module, read by the Seer off the world's
`settings` collection (key `fvtt-mod-crystalball.<name>`; a missing setting means its default):

| name | type | default | meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | off: the button is hidden and the Seer answers 403 |
| `serviceUrl` | string | `/crystalball` | where the window calls (the Seer ignores it) |
| `tableNotes` | string | `""` | the DM's standing notes to the ball, appended to the instructions layer |
| `askers` | `"players"` \| `"listed"` | `"players"` | every user may ask, or only `askerIds` |
| `askerIds` | string | `""` | comma-separated user ids when `askers` is `listed` |
| `modelLabel` | string | (unset) | reserved; the window shows what `healthz` reports |
| `rulebooks` | string | the 2024 Player's Handbook, Arcana Unleashed and Heroes of Faerûn's player packs (`scripts/decide/rulebooks.js`) | the compendium packs the ball may look things up in, one pack id a line (commas too); empty: no lookups |
| `rulebookLeaveOut` | string | the Handbook's stat-block appendix; Arcana Unleashed's Chapters 3, 5 and 6 and Appendix (worldbuilding, magic items, creatures, adventure); credits, change logs | folders, journal entries and pages never read in those packs, one name a line, matched without case or accents; a line led by a package or pack id the world has and a colon (`dnd-arcana-unleashed: Chapter 5`) applies to that book alone |

## The gaze

Built per user from the live `world` payload, in this order, deterministically (stable sorts by folder path,
`sort`, then id; no timestamps, no counters, no ids in the text):

1. **instructions**: the standing text of the configured model's **harness**, then, when the table has
   rulebooks, the harness's section naming its books and when to look things up, then the DM's `tableNotes`.
   The harness is chosen by the model id (`seer/src/harness/`, picked in `seer/src/instructions.js`): a Haiku
   model reads Haiku's own, tuned on a real table; every other model reads the general one, untuned. Each is
   versioned on its own (`<name>-<version>`, the gaze's `meta.instructionsVersion`), and a change of wording is
   a new version. Every harness keeps three rules: what the sections say is stated as fact with its source (the
   party's own writing, a clue's note and a thread's stand, weighed as fact and marked as the party's intuition); the
   ball's own reasoning from them (a connection, a theory, a suggestion, advice on a build) is welcome and marked
   as its own; and nothing the sections do not hold (a name, a place, an event, a motive, a number, a secret) is
   ever stated as true. The DM's notes come after the harness and win over it on the ball's manner (its hints,
   its length, its voice, what it declines), never on the third rule.
2. **lore**: every journal page every player can observe (entry `ownership.default ≥ 2` and page `ownership.default`
   `≥ 2` or `-1` inheriting), text pages as Markdown (`@UUID[...]{Name}` → `Name`, `@UUID[...]` without a label →
   the document's name when it can be resolved from the payload, else dropped), image/video/pdf pages as a title
   line and caption. Grouped by entry, entries in folder order.
3. **party**: the Group actor whose `system.members` includes a character the user owns and which the user can
   observe (the first by name when several); members (name, species, classes/levels, HP current/max, AC), the
   stash (currency, items with quantity), and the Clue Board record when `fvtt-mod-clueboard` flags are on the
   group: each entry (keyed by the world Clue item's id) joined to that item (`system.kind`, `system.text`,
   `system.foundAt`; the record's own snapshot when the item is gone) with its readers (actor names) and the
   threads (name, question, status, stand) with their pinned clues in order. World text in layers 2–4 has `<` and
   `>` replaced by `‹` and `›` after conversion, so no page can close or forge a tagged section.
4. **own**: journal pages only this user (not every player) can observe, then each actor of type `character` the
   user owns (ownership level 3, explicit) as a curated sheet (see `seer/src/sheet.js`): identity, classes,
   abilities/saves/skills, HP/AC/speed/senses, proficiencies and languages, currency, spell slots and spells with
   descriptions, features with descriptions, inventory (qty, equipped, attuned, description), effects.
5. **sitting**: the last 24 turns, the new message last.

Permission rule, mirrored from Foundry's `testUserPermission` at OBSERVER: the level is `ownership[userId] ??
ownership.default`, and `≥ 2` passes. Foundry passes a user with role ≥ 3 (Assistant GM) everything; the ball does
not: it is the players' tool, so a GM reads what every player reads plus what is granted to them by name, and the
DM tests what the players get. (A setting that opened the whole world to a GM, `gmGaze`, went in 1.0.8: the DM's own
knowledge lives outside the world, and the DM's assistant is the MCP. A world that saved it keeps an ignored row.) A user with no character gets layers 1 and 2 and whatever of 3 and 4 applies (none, usually).

Layers 1–4 are the system prompt, four text blocks: a `cache_control: { type: "ephemeral" }` marker on the
first three and top-level automatic caching for the rest. The markers carry two TTLs. `config.stableCacheTtl`
(`1h` default) is on layers 1 and 2, the instructions and the lore: the bulk of the gaze, the same for the whole
table, changed only by the DM's hand (the tools ahead of them cache in the same entry). `config.cacheTtl` (`5m`
default) is on layer 3 and the top-level marker: the party changes with every hit point, the asker's own sheet
with every rest, the conversation with every turn, and an hour's price on a block rewritten at the next blow is
money spent for nothing. The API wants the longer TTL first, and the stable layers come first, so a config whose
`stableCacheTtl` is shorter than its `cacheTtl` is refused at start. The gaze is never written to disk.

## The rulebooks

When `rulebooks` names packs the world has (journal and item packs only; an actor, adventure, scene, table or
effect pack is refused whatever the setting says), the model is given two tools, the same bytes for every player
at the table (the books' names in them, never the asker's view), so they cache ahead of the instructions:

- `search_rulebooks { query, kind? }`: up to 8 entries, the exact name first, then names, folders and text; every
  term must match the start of a word somewhere; `kind` one of `spell`, `spell list`, `class`, `subclass`,
  `feature`, `feat`, `species`, `background`, `equipment`, `facility`, `rules`. Each hit is a line: title,
  hint, book, `id: <pack>/<document>[.<page>]`.
- `read_rulebook { id }`: one entry as Markdown, at most 24,000 characters: a spell's facts and class lists, a
  class's features by level, scale values and subclasses, a subclass's or species' granted features with their
  text, a feature's granting class and level, a feat's prerequisites, an item's facts, a rules page with each
  embedded journal page placed (two levels; an embedded actor, table or picture dropped), a spell list by level.

The entries are an item pack's items of those kinds (never a monster's feature) and a journal pack's text, rule
and class or subclass spell-list pages (class, subclass, image, map, video and pdf pages never). An entry whose
name, entry or folder is in `rulebookLeaveOut` is neither found nor read; a scoped line counts only for entries of
its package or pack (books share folder names: the Handbook and Arcana Unleashed both have a "Chapter 5").

**Whose view**: Foundry 14.369 checks no read permission on a compendium get, so the Seer applies it: a pack's
level for a user is the highest level of any role they hold in `core.compendiumConfiguration[<pack>].ownership`
(a GM's row only), else the pack's own `ownership`, else `{ PLAYER: "OBSERVER", ASSISTANT: "OWNER" }`, as
`getUserLevel` computes it; Observer reads. A GM reads at the Player role. An embedded page's pack must pass the same test.

**Loading**: a pack is read the first time a lookup needs it and held six hours (a world change or a pack whose
index grows reads it again); a pack that fails is said in the search's answer and tried again on the next lookup.

## The model call

`@anthropic-ai/sdk`, `client.messages.stream(...)`: `model` from config (`claude-haiku-5-5` default, a hobby
table's pocket: about a twentieth of Sonnet's price; `claude-sonnet-5-5` and `claude-opus-5-5` priced too), no
`thinking` parameter (adaptive is the model's default), `output_config: { effort: config.effort }` (`high`
default), `max_tokens: config.maxOutputTokens` (16000: the model's thinking counts against it, and a high effort
can think through 4,096 before it says a word), `betas: ["server-side-fallback-2026-07-01"]` with `fallbacks:
"default"` through the beta client when `config.refusalFallback` is true (default false: Haiku has no
server-side fallback; true for Sonnet or Opus). With the rulebooks, `tools` as above; a reply that stops on
`tool_use` has its calls run, and the next hop carries the assistant's content whole (thinking included) and a
`tool_result` per call (`is_error` for a refused or failed one), up to `config.lookupRounds` (4) rounds and
`config.lookupCalls` (8) calls, the hop after the last round sent with `tool_choice: { type: "none" }` and a line from
the Seer after that round's results (a text block after the `tool_result`s): the lookups are spent, answer now from
what was read. A turn whose hops wrote no words and did not stop on `refusal` is asked once more: the last request
again with a line from the Seer after it (no words reached the player, answer now), `tool_choice: none` when the
table has rulebooks; still no words, the ball's empty sentence stands. (Haiku ended the answer-only hop after a
fourth round of lookups with no content at all in 2 of 15 rules questions measured.) A hop the
fallback model served goes on with that model. The stored answer is every hop's words joined by a blank line. The response `usage` fields `input_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` make the ledger line, priced by
`config.prices[model]` (per MTok: `input`, `cacheWrite5m`, `cacheWrite1h`, `cacheRead`, `output`); a cache write
is priced at the TTL it was made with, from the response's `cache_creation` split, or at the dearer of the two
configured TTLs when a response gives none. A model priced by prompt length (Haiku) carries `longPrompt: {
overTokens, input, cacheWrite5m, cacheWrite1h, cacheRead, output }`: a request whose prompt (input, cache writes
and cache reads together) is over `overTokens` is priced at those rates, each hop on its own.

**Stub mode** (`MODEL_STUB=1`, or no `ANTHROPIC_API_KEY` set): no API call. The answer is deterministic so a live
check can assert on it:

```
The Crystal Ball is clouded (stub). I see <L> shared pages, <C> clues, <P> party members
and your character <Name> (<Class> <Level>). You asked: "<the message>".
```

(`<Name>` etc. from the gaze; "no character" when none.) Stub usage is `{ input: <estimate>, cacheWrite: 0,
cacheRead: 0, output: <estimate> }`, cost 0, model `"stub"`. The token estimate is `Math.ceil(chars / 4)`.

## Limits (config defaults)

`perUserHour: 10`, `perUserDay: 40`, `tableDayUsd: 5`, `tableMonthUsd: 25`, `messageChars: 4000`,
`sittingTurns: 24`, `gazeBudgetTokens: 120000` (past it: the oldest lore pages by entry sort are replaced by their
titles until under budget, and a warning is logged), `callTimeoutMs: 90000` (each hop of an answer),
`lookupRounds: 4`, `lookupCalls: 8`. `limitsByModel` names a model's own limits, merged over `limits` when it is
`config.model`; `null` for `perUserHour` or `perUserDay` is no such cap. The committed table lifts both for
`claude-haiku-5-5` (a question there costs a fraction of a cent) and leaves Sonnet and Opus at 10 and 40; the
dollar caps stand for every model. One message is one call against the caps, whatever its hops. Counters are per Foundry user id,
rolling hour and calendar day (local time of the box); the table's day and month are calendar, from the ledger.

## Storage

`DATA_DIR` (default `seer/data`), created `0700` where the platform allows: `sittings/<userId>/current.json`,
`sittings/<userId>/<startedAt>.json` (closed; older than `sittingRetentionDays: 90` deleted at start and daily),
`usage.jsonl` (one line per call: `{ at, userId, userName, model, usage, cost, gazeTokens, layers: { <hash per
layer> }, latencyMs, stub, outcome: "done" | "aborted" | "failed", estimated?: true, lookups?: n }`, usage and cost every hop's; a call is counted against
the caps and the ledger the moment the model is asked, whatever its end, from the stream's last usage or, failing
that, the gaze's estimate marked `estimated`). Writes are write-then-rename; the ledger is append plus fsync. The
probe is asked on every request; only a refusal is remembered, for 30 seconds, in memory.

## Environment (`seer/.env`, loaded by the Seer; `seer/.env.example` documents it)

| var | default | meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | (none → stub mode) | the key; never anywhere else |
| `MODEL_STUB` | `0` | `1` forces stub mode even with a key |
| `FOUNDRY_URL` | `http://localhost:30000` | the Foundry the Seer joins and probes |
| `BALL_USER` | `Crystal Ball` | the ball's user, by name or id |
| `BALL_PASSWORD` | (none) | its password |
| `PORT` | `30001` | the Seer's port |
| `BIND` | `127.0.0.1` | the Seer's bind address; `::` (every address) on a sandbox other devices reach over the network |
| `BASE_PATH` | `/crystalball` | the path prefix every endpoint sits under (`/crystalball/healthz`); `/` for none |
| `CORS_ORIGIN` | (none → CORS off) | the origins allowed: one (`http://localhost:30000`), several comma-separated, or `*` for any (a sandbox reached from other devices; every endpoint but `healthz` still wants the caller's own session id) |
| `DATA_DIR` | systemd's `STATE_DIRECTORY` when set, else `seer/data` under the repo root | storage; on a box an absolute path or a `StateDirectory=` line in the unit |
| `CONFIG` | `seer/config.json` | the config file (the committed defaults); another file's path, absolute on a box, relative to the repo root otherwise |
| `LOG_LEVEL` | `info` | `debug` prints the gaze's layer sizes and cache hits per call |

## Foundry contracts the Seer depends on (Foundry 14.369, read from `resources/app/dist`)

- **Join**: `POST {FOUNDRY_URL}/join` with JSON `{ "action": "join", "userId": "<id>", "password": "<pw>" }` (14.369;
  ≤ 14.365 named the field `userid`), the user id looked up from the users list the `/join` page's `getJoinData`
  socket event returns, or from a prior `world` payload; the reply sets the `session` cookie the socket presents.
- **Socket**: socket.io 4.x client to `{FOUNDRY_URL}` with `path: "/socket.io"`, `transports: ["websocket"]` and
  the header `Cookie: session=<id>`. The server emits `session` with `{ sessionId, userId }` (userId null when the
  session has not joined the running world; the whole thing null when unknown).
- **A world closed**: Foundry emits `shutdown` (`{ world, userId }`) to every socket and closes none, and its
  sessions outlive the close. A socket still open when the world is back is answered as before (`world` reads its
  session), but it is never counted present there (a user joins a world's activity only when a socket connects):
  `user.active`, the Players list and `/api/status` leave the ball out while `healthz` says connected. So the Seer
  disconnects the ball's socket on `shutdown` and, once the world is back, rejoins on a new socket on its cookie.
- **Presence**: `socket.emit("getUserActivity")` answers on the asking socket alone with a `userActivity` event
  (`id, { active, … }`) for each user Foundry counts present; `socket.emit("getWorldStatus", callback)`, asked after
  it, is acknowledged after them all (one connection keeps its order). The Seer asks at each join and every minute
  (`healthz`'s `counted`); a ball Foundry does not count leaves and rejoins on a new socket, which Foundry counts.
  Foundry also emits `userActivity` to every socket, `{ active: true }` when a user's first socket connects and
  `{ active: false }` when their last one goes (`components/activity.mjs`); a player's own activity carries no
  `active`. With the minute's list, these make the presence record (`presence.jsonl`, the Seer's README).
- **World**: `socket.emit("world", callback)` → the payload with `users`, `actors`, `items`, `journal`, `folders`,
  `settings`, `messages`, … (every document, unfiltered) plus `userId`.
- **A pack's documents**: `socket.emit("modifyDocument", { type: "<JournalEntry | Item>", action: "get", operation:
  { pack: "<id>", query: {} } }, callback)` → `{ result: [<source>…] }` (journal entries with their pages), or
  `{ error: { message } }`. Never broadcast; no permission check (see *The rulebooks*). The world payload's
  `packs` lists every active pack with its `ownership`, `index` and `folders`.
- **Probe**: the same socket handshake with a *player's* session id, read `session`, disconnect. Side-effect free
  for a connected player (a user is deactivated only when their last socket drops).

A fixture per Foundry build (`seer/tests/fixtures/<version>/`) holds a trimmed `session` event, a trimmed `world`
payload (synthetic, never the real world), the `shutdown` event and the join reply, so `npm test` fails before a live bridge hangs.
