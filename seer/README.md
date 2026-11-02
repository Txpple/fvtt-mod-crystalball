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
   receives Foundry's `session` event `{ sessionId, userId }`. No user, no answer (401). The answer is remembered
   ten minutes under a hash of the id; the id itself is never logged.
2. Checks the world's own settings for the module (*Enabled*, *Who may ask*, *The GM's gaze*) and that the module
   is active in the world (403 otherwise).
3. Checks the limits (413, 429).
4. Builds the **gaze** from the live world payload, filtered by Foundry's ownership rule at OBSERVER, in four
   layers: the standing instructions and the DM's *Table notes*; the journal pages every player can observe; the
   party (members, stash, Clue Board record); the pages only this user observes and each character they own as a
   curated sheet. Each layer is a cached system block, so a party shares the first three. The gaze is never
   written to disk.
5. Streams the model's answer as Server-Sent Events, then appends a line to the usage ledger and the turn to the
   user's sitting.

The ball's user socket emits nothing but `world`; the Seer writes nothing to Foundry.

## Running it on a sandbox

```sh
npm install
cp seer/.env.example seer/.env   # fill in BALL_PASSWORD; leave ANTHROPIC_API_KEY empty for the stub
npm run seer:dev
curl -s http://localhost:30001/crystalball/healthz
```

The sandbox's world setting *Service URL* is `http://localhost:30001/crystalball` and `CORS_ORIGIN` is Foundry's
own origin (`http://localhost:30000`), the one origin allowed to call across ports. `LOG_LEVEL=debug` prints each
call's layer sizes, the gaze's meta and the cache figures.

Without `ANTHROPIC_API_KEY` (or with `MODEL_STUB=1`) the Seer makes no API call: it answers the contract's stub
sentence, which names what the gaze holds, so a live check can assert on it for nothing.

## The model call

`claude-opus-5-5` by default (`claude-sonnet-5-5` the other choice in `config.json`), `output_config.effort` low,
2,048 output tokens, no `thinking` parameter, streamed. The four layers are the system prompt: an explicit
`cache_control` marker on the first three and the request's top-level automatic marker for the conversation, so a
sitting's next message reads the cached gaze and history. With `refusalFallback` on, the call goes through the
beta client with `fallbacks: "default"`, so a request the model declines on policy grounds is answered by the API's
fallback model in the same call. Prices per million tokens are in `config.json` and make the ledger's cost.

## Configuration

The environment only: `seer/.env` on a sandbox (passed by `npm run seer:dev`), the unit's `EnvironmentFile=` on a
box. The variables are the contract's *Environment* table. `config.json` holds the committed defaults (model,
effort, output cap, cache TTL, the refusal fallback, the limits, the prices, the sitting retention, the call
timeout); `CONFIG` may name another file whose keys override them. Relative `DATA_DIR` and `CONFIG` paths are taken
from the repository root.

## Limits

All enforced in the Seer, whatever the window says: 10 messages per user in a rolling hour and 40 per calendar day,
$5 a day and $25 a month for the whole table (from the ledger, the box's local calendar), 4,000 characters a
message, a 16 KB request body, 24 turns of the sitting sent with each message, a 120,000-token gaze (past it the
oldest lore pages are cut to their titles and a warning is logged), and a 60-second call, aborted when the player's
connection drops. Set a spend limit on the key in the Console as well.

## What it stores

Under `DATA_DIR` (`seer/data` by default, gitignored, mode 0700 where the platform has modes):

- `sittings/<userId>/current.json`: the open sitting (its turns and running usage, never the gaze);
- `sittings/<userId>/<startedAt>.json`: closed sittings, deleted after 90 days (at start and daily);
- `usage.jsonl`: one line per model call: when, who, the model, the four token counts, the cost, a hash per
  layer, the latency, whether it was the stub. Counts and hashes, never words.

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
