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
- sandbox: `serviceUrl` is `http://localhost:30001/crystalball` (the Seer's origin plus its `BASE_PATH`, the same
  path on both so the two differ only by origin); the Seer answers CORS for the one `CORS_ORIGIN` (preflight
  `OPTIONS`, `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Headers: Content-Type,
  X-Foundry-Session`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`).

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
"world": "<id or null>", "ballUser": "<name or null>" }, "model": "<model id or 'stub'>", "uptimeSeconds": n,
"timeZone": "<the zone the limits' calendar follows>" }`. Always 200. No secrets, no paths.

### `GET sittings/current`

The caller's open sitting: `{ "id": "<id>", "startedAt": "<iso>", "model": "<id>", "turns": [ { "role": "user" |
"ball", "text": "<text>", "at": "<iso>" } ], "usage": { "messages": n, "cost": <usd> } }`. A user with no sitting
yet gets one created (empty) on this call.

### `POST sittings/new`

Closes the open sitting (archived on disk) and opens a fresh one: `{ "id": "<id>", "startedAt": "<iso>" }`.

### `GET usage/me`

`{ "user": { "hour": n, "day": n }, "table": { "day": { "messages": n, "cost": <usd> }, "month": { "messages": n,
"cost": <usd> } }, "limits": { "perUserHour": n, "perUserDay": n, "tableDayUsd": x, "tableMonthUsd": x } }`.

### `POST chat`

Body `{ "message": "<text>" }`. The reply is a Server-Sent Events stream (`Content-Type: text/event-stream`,
`Cache-Control: no-cache`, `X-Accel-Buffering: no`); each event is `event: <name>\ndata: <json>\n\n`:

| event | data | notes |
| --- | --- | --- |
| `meta` | `{ "sittingId", "model", "gazeTokens": n, "layers": { "instructions": n, "lore": n, "party": n, "own": n } }` | first; token counts are the Seer's estimate (or `count_tokens` when a key is present) |
| `delta` | `{ "text": "<piece>" }` | zero or more; the answer in order |
| `done` | `{ "text": "<the whole answer>", "usage": { "input": n, "cacheWrite": n, "cacheRead": n, "output": n }, "cost": <usd>, "remaining": { "hour": n, "day": n } }` | last on success |
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
| `gmGaze` | `"player"` \| `"all"` | `"player"` | a GM's gaze: what every player sees plus the GM's own pages, or everything |
| `modelLabel` | string | (unset) | reserved; the window shows what `healthz` reports |

## The gaze

Built per user from the live `world` payload, in this order, deterministically (stable sorts by folder path,
`sort`, then id; no timestamps, no counters, no ids in the text):

1. **instructions**: the Seer's standing text (versioned in `seer/src/instructions.js`) + the DM's `tableNotes`.
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

Permission rule, mirrored from Foundry's `testUserPermission` at OBSERVER: a user with role ≥ 3 (Assistant GM)
sees everything (subject to `gmGaze`); otherwise the level is `ownership[userId] ?? ownership.default`, and `≥ 2`
passes. A user with no character gets layers 1 and 2 and whatever of 3 and 4 applies (none, usually).

Layers 1–4 are the system prompt, four text blocks, each with `cache_control: { type: "ephemeral" }` on the
first three and top-level automatic caching for the rest (`config.cacheTtl` chooses `5m` or `1h`). The gaze is
never written to disk.

## The model call

`@anthropic-ai/sdk`, `client.messages.stream(...)`: `model` from config (`claude-opus-5-5` default,
`claude-sonnet-5-5` the other), no `thinking` parameter (adaptive is the model's default), `output_config:
{ effort: config.effort }` (`medium` default), `max_tokens: config.maxOutputTokens` (2048), `betas:
["server-side-fallback-2026-07-01"]` with `fallbacks: "default"` through the beta client when
`config.refusalFallback` is true (default true). The response `usage` fields `input_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` make the ledger line, priced by
`config.prices[model]` (per MTok: `input`, `cacheWrite5m`, `cacheWrite1h`, `cacheRead`, `output`).

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
titles until under budget, and a warning is logged), `callTimeoutMs: 60000`. Counters are per Foundry user id,
rolling hour and calendar day (local time of the box); the table's day and month are calendar, from the ledger.

## Storage

`DATA_DIR` (default `seer/data`), created `0700` where the platform allows: `sittings/<userId>/current.json`,
`sittings/<userId>/<startedAt>.json` (closed; older than `sittingRetentionDays: 90` deleted at start and daily),
`usage.jsonl` (one line per call: `{ at, userId, userName, model, usage, cost, gazeTokens, layers: { <hash per
layer> }, latencyMs, stub, outcome: "done" | "aborted" | "failed", estimated?: true }`; a call is counted against
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
| `BIND` | `127.0.0.1` | the Seer's bind address |
| `BASE_PATH` | `/crystalball` | the path prefix every endpoint sits under (`/crystalball/healthz`); `/` for none |
| `CORS_ORIGIN` | (none → CORS off) | the one origin allowed (the sandbox: `http://localhost:30000`) |
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
- **World**: `socket.emit("world", callback)` → the payload with `users`, `actors`, `items`, `journal`, `folders`,
  `settings`, `messages`, … (every document, unfiltered) plus `userId`.
- **Probe**: the same socket handshake with a *player's* session id, read `session`, disconnect. Side-effect free
  for a connected player (a user is deactivated only when their last socket drops).

A fixture per Foundry build (`seer/tests/fixtures/<version>/`) holds a trimmed `session` event, a trimmed `world`
payload (synthetic, never the real world) and the join reply, so `npm test` fails before a live bridge hangs.
