# The Seer

The server half of Crystal Ball, part of Open Roll 5e: a small Node service that runs beside the Foundry server,
holds the Claude API key, stays logged into the world as a Player-role user of its own (*the ball's user*) on its
own socket, builds what one player may know from the live world, and answers the Crystal Ball window through a
small HTTP API with a streamed reply. No player's browser ever holds the key or talks to the model.

The contract between the window and the Seer, every endpoint, header, event, error body, setting and limit, is
[`../docs/seer-contract.md`](../docs/seer-contract.md). Putting the Seer on a Linux box is
[`deploy/README.md`](deploy/README.md).

## What it does for each request

1. Reads the `X-Foundry-Session` header and asks Foundry whose session it is: a socket opened on that session
   receives Foundry's `session` event `{ sessionId, userId }`. No user, no answer (401). Foundry keeps a
   browser's session id across a logout and binds it to whoever logs in next, so the Seer asks on every request;
   only a refusal is remembered (30 s, under a hash of the id). The id itself is never logged.
2. Checks the world's own settings for the module (*Enabled*, *Who may ask*, *The GM's gaze*) and that the module
   is active in the world (403 otherwise).
3. Checks the limits (413, 429).
4. Builds the **gaze** from the live world payload, filtered by Foundry's ownership rule at OBSERVER, in four
   layers: the standing instructions and the DM's *Table notes*; the journal pages every player can observe; the
   party (members, stash, Clue Board record); the pages only this user observes and each character they own as a
   curated sheet. Each layer is a cached system block, so a party shares the first three. The gaze is never
   written to disk.
5. Gives the model the table's **rulebooks** as two tools when the *Rulebooks* setting names packs the world has
   (`rulebooks.js`): `search_rulebooks` and `read_rulebook`. A pack is read off the ball's socket the first time
   a lookup needs it (a `modifyDocument` get, as Foundry's own client asks) and held six hours; each player
   reads only the packs Foundry would open to them, which the Seer works out itself, since Foundry checks no read
   permission on a get. Journal and item packs only, never a bestiary; an embedded stat block is dropped and an
   embedded glossary page is placed. Every lookup goes out as a `lookup` event.
6. Streams the model's answer as Server-Sent Events, then appends a line to the usage ledger and the turn to the
   user's sitting. A call that fails or is abandoned after the model was asked still gets its ledger line and
   counts against the caps, priced from the stream's last usage or, failing that, estimated; only a finished
   answer becomes a turn.

The ball's user socket emits `world` and, for the rulebooks, a pack's `modifyDocument` get; the Seer writes
nothing to Foundry.

## Running it on a sandbox

```sh
npm install
cp seer/.env.example seer/.env   # fill in BALL_PASSWORD and the sandbox's BIND and CORS_ORIGIN (below);
                                 # leave ANTHROPIC_API_KEY empty for the stub
npm run seer:dev
curl -s http://127.0.0.1:30001/crystalball/healthz
```

The world's *Service URL* stays at its default, `/crystalball`: a sandbox has no proxy at that path, and on a
plain-http page the window also tries the same path on the companion port, 30001, of the host the browser reached
Foundry by, which is where the Seer listens (an https page, behind a proxy, asks its own origin alone). Set `BIND=::` so the Seer answers on every address (a browser on another device on the network
reaches it by the sandbox's host) and `CORS_ORIGIN=*` so it answers whatever origin that browser names Foundry
by (`http://localhost:30000` alone covers a browser on the machine itself). `LOG_LEVEL=debug` prints each call's
layer sizes, the gaze's meta and the cache figures. The entry point is `seer/src/main.js` (it checks for Node 24
and loads `start.js`); `config.js` reads the environment and the config.


Without `ANTHROPIC_API_KEY` (or with `MODEL_STUB=1`) the Seer makes no API call: it answers the contract's stub
sentence, which names what the gaze holds, so a live check can assert on it for nothing.

## The model call

`claude-opus-5-5` by default (`claude-sonnet-5-5` the other choice in `config.json`), `output_config.effort` medium,
4,096 output tokens, no `thinking` parameter, streamed. The four layers are the system prompt: an explicit
`cache_control` marker on the first three and the request's top-level automatic marker for the conversation, so a
sitting's next message reads the cached gaze and history. With `refusalFallback` on, the call goes through the
beta client with `fallbacks: "default"`, so a request the model declines on policy grounds is answered by the API's
fallback model in the same call. With the rulebooks the tools ride ahead of the first system block (the same
bytes for the whole table, so they cache with the instructions); a round of tool calls is run and its results go
back, at most `lookupRounds` rounds and `lookupCalls` calls an answer, the last hop answering only. Each hop has
`callTimeoutMs` of its own, and the usage and cost are every hop's. Prices per million tokens are in
`config.json` and make the ledger's cost.

## Configuration

The environment only: `seer/.env` on a sandbox (passed by `npm run seer:dev`), the unit's `EnvironmentFile=` on a
box. The variables are the contract's *Environment* table. `config.json` holds the committed defaults (model,
effort, output cap, cache TTL, the refusal fallback, the limits, the prices, the sitting retention, the call
timeout); `CONFIG` may name another file whose keys override them. Relative `DATA_DIR` and `CONFIG` paths are taken
from the repository root; on a box give absolute ones. A config file written with a byte-order mark (Windows
PowerShell's) is read as well.

## Limits

All enforced in the Seer, whatever the window says: 10 messages per user in a rolling hour and 40 per calendar day,
$5 a day and $25 a month for the whole table (from the ledger, the calendar of the process's zone, `TZ`, which
`healthz` reports), 4,000 characters a
message, a 16 KB request body, 24 turns of the sitting sent with each message, a 120,000-token gaze (past it the
oldest lore pages are cut to their titles and a warning is logged), and a 60-second call, aborted when the player's
connection drops. Set a spend limit on the key in the Console as well.

## What it stores

Under `DATA_DIR`; unset, under systemd's `STATE_DIRECTORY` (the unit's `StateDirectory=`, `/var/lib/crystalball`),
else `seer/data` in the clone (gitignored). Mode 0700 where the platform has modes:

- `sittings/<userId>/current.json`: the open sitting (its turns and running usage, never the gaze);
- `sittings/<userId>/<startedAt>.json`: closed sittings, deleted after 90 days (at start and daily);
- `usage.jsonl`: one line per model call: when, who, the model, the four token counts, the cost, a hash per
  layer, the latency, whether it was the stub, the outcome (`done`, `aborted` or `failed`) and `estimated` when
  the spend was worked out rather than reported. Counts and hashes, never words.

**The DM can read every sitting on the box**, and the window tells players so. What a player asks and the gaze it
was answered from go to the Claude API under its terms.

## The Foundry contracts it depends on

Read from Foundry 14.369's own server code; the contract's last section has the detail:

- `GET /join` without a cookie returns a fresh `session` cookie; a socket on it answers `getJoinData` with the
  world and its users (the `/join` page itself lists nobody on 14.369). That finds the ball's user's id.
- `POST /join` with `{ "action": "join", "userId", "password" }`, Foundry's own origin named in `Origin` (Foundry
  refuses a cross-origin POST).
- A socket.io 4 client with `Cookie: session=<id>` receives `session`; `world` returns the whole payload.
- The probe is that handshake with a player's session id: read `session`, disconnect.

**The fixture rule**: each Foundry build the Seer is verified on has `tests/fixtures/<version>/` with a trimmed
`session` event, a trimmed, synthetic `world` payload (never a real world's) and the join replies, so `npm test`
fails on a reshaped contract before a live link hangs. A new build means a new fixture folder and a line in the
suite's upgrade review.

## Tests

`npm run verify` at the repository root runs Biome and every unit test of both halves; the Seer's are under
`seer/tests/`, with Foundry and the model mocked.
