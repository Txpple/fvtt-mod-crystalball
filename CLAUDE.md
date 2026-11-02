# fvtt-mod-crystalball — working notes for sessions in this repo

**What this is.** Open Roll 5e: Crystal Ball, a Foundry VTT module in two halves: the window (a crystal ball
button on the sidebar's strip after Clue Board's, opening a chat with a Claude model about the game as the
player's character knows it) and **the Seer** (`seer/`, a Node service beside the Foundry server that holds the key,
is logged into the world as a Player-role user on its own socket, builds each player's **gaze** from the live
world under Foundry's ownership rule, and streams the model's answer). Part of Open Roll 5e (the suite repo is
`..`, its CLAUDE.md has the family's conventions; the plan this is built from is `../docs/plans/crystalball.md`).
Plain ES modules, no build step, no libWrapper, no socketlib, MIT.

**State (2026-11-01).** Being built on the sandbox, the night of the plan: the repo scaffolded from the template,
the contract written (`docs/seer-contract.md`), the two halves built by two agents in parallel, the ball's user
*Crystal Ball* (role Player) made on the sandbox with `tools/ball-user.mjs`, the module deployed `--local`, enabled
and registered there by a restart. Not released, not on GitHub, not on prod; `sync` is off in `repos.json` until the
GitHub repo exists. No API key yet: the Seer runs its stub model, and the first real-model sitting waits for the key
in `seer/.env`.

## The rules this module keeps

- **The window talks only to the Seer, the Seer only to Foundry and the model.** No client holds a key or calls
  the model; the Seer binds `127.0.0.1` and is reached through a reverse proxy or tunnel rule on Foundry's own
  origin (prod) or on a second local port with CORS for one origin (the sandbox). `docs/seer-contract.md` is the
  contract: endpoints, the `X-Foundry-Session` header, the SSE events, the error bodies, the settings the Seer
  reads, the gaze's layers, the stub model's sentence. A change to it is made there first.
- **Identity is Foundry's.** Every request carries the player's own session id; the Seer opens a socket to Foundry
  with it and reads the `session` event (`{ sessionId, userId }`); no user, no answer. The probe is side-effect
  free for a connected player. The id is never logged (a hash keys the ten-minute cache).
- **The ball's user is a Player, never a GM.** Foundry sends every document to every connected user whatever its
  role, so the role buys no reading; a GM-level socket that runs no modules would be elected the table's active GM
  while the DM is away and By the Books' consequences would land on it and die. The Seer writes nothing to
  Foundry: its socket emits `world` and nothing else.
- **The gaze is the Seer's, from the live world, never the client's.** Four layers in a fixed, deterministic order
  (instructions and the DM's table notes; the lore every player can observe; the party with its stash and Clue
  Board record; the player's own pages and curated sheets), the permission rule mirroring `testUserPermission` at
  OBSERVER, each layer a cached system block so a party shares the first three. The gaze is never written to disk.
- **Clue Board is read, never required** (`flags["fvtt-mod-clueboard"]` on the Group actor, schema 2, joined to
  the world Clue items); Card Catalogue's body class paints the button; nothing else is detected. No hook emitted,
  none listened to.
- **Limits live in the Seer** (per user per hour and day, the table's day and month in dollars, the message length,
  the sitting window, the gaze budget) and the window only reports them; a cap answers 429 with its scope.
- **Card Catalogue's look, a copy kept by hand** (the `--cb-*` palette under `crystalball-` classes): a change to
  either module's look is made in both. No `host.js`: the window opens nothing of its own, and the copied helper,
  which notes its host on every keystroke, pulled unrelated sheets into a detached ball (found in review).
- **What the ball says is a Markdown subset over escaped text** (`scripts/decide/markdown.js`): never raw HTML,
  never `enrichHTML`.
- **The sidebar never changes**: a button on the strip, no `data-tab`, nothing on `Sidebar.TABS` (Clue Board's
  rule, learned when a panel stuck the sidebar).
- **No machine, drive path or box name in anything committed**; the Seer's deploy files are placeholders.

## How the code is laid out

- `scripts/crystalball.js`: the entry; settings at `init`, the strip button on `renderSidebar`, the stylesheet
  probe at `ready`, `module.api = { open, newSitting }`.
- `scripts/window.js`: `CrystalBallWindow` (ApplicationV2 + Handlebars, one per client): the status bar, the
  transcript, the input, the stream.
- `scripts/decide/`: `sse.js` (the stream parser), `markdown.js` (the safe subset), `session.js` (the session id,
  the base URL, `modelLabel`, `failureOf`, `waitOf`, `darkReason`); pure, `// @ts-check`, tested in `tests/`.
- `scripts/common.js`, `scripts/kit/`.
- `seer/src/`: `main.js`, `foundry.js` (join, the ball's socket, the probe, the world), `permission.js`, `gaze.js`,
  `sheet.js`, `model.js`, `limits.js`, `ledger.js`, `sittings.js`, `http.js`, `instructions.js`, `log.js`;
  `seer/config.json` the defaults; `seer/tests/` with synthetic fixtures under `fixtures/<foundry version>/`;
  `seer/deploy/` the systemd unit and the Linux guide; `seer/README.md`.
- `tools/live-check.mjs`: the sandbox walk (`FOUNDRY_HOST=local`, `--walk`, `--seer <url>`, `--asker <member>`);
  `tools/fake-seer.mjs`: a stub-only stand-in Seer for the walk, never deployed; `tools/ball-user.mjs`: the ball's
  user on a sandbox.
- **Identity in the window**: `game.socket.session.sessionId` first (Foundry 14's session cookie is HttpOnly), the
  cookie only for an older build; the walk asserts the two are equal.
