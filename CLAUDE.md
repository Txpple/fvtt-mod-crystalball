# fvtt-mod-crystalball — working notes for sessions in this repo

**What this is.** Open Roll 5e: Crystal Ball, a Foundry VTT module in two halves: the window (a crystal ball
button on the sidebar's strip after Clue Board's, opening a chat with a Claude model about the game as the
player's character knows it) and **the Seer** (`seer/`, a Node service beside the Foundry server that holds the key,
is logged into the world as a Player-role user on its own socket, builds each player's **gaze** from the live
world under Foundry's ownership rule, and streams the model's answer). Part of Open Roll 5e (the suite repo is
`..`, its CLAUDE.md has the family's conventions; the plan this is built from is `../docs/plans/crystalball.md`).
Plain ES modules, no build step, no libWrapper, no socketlib, MIT.

**State (2026-11-02).** 0.1.0 built overnight on the sandbox and reviewed (the two halves to
`docs/seer-contract.md`, three reviews applied, `npm run verify` green, 314 tests, `tools/live-check.mjs --walk`
GREEN in stub mode), then run on the real model the same morning: the user's key in the gitignored `seer/.env` (a
Console workspace of its own with a $25 monthly limit; the Console has no day cap, the Seer's own is the one),
fifteen real calls on Opus over four sittings (the DM's login and two players', $1.38 by the Seer's tally), every
answer from the live world and
the cache as designed (the DM's first call wrote 90k tokens, each later one read it for about three cents; the
player's first call read the DM's lore and party layers and wrote only his own 8k). Then, on the user's word,
effort medium and instructions version 2 (the ball may make suggestions, grounded in the sections and marked
as its own), and the connect error's reason named (a refused `localhost` is an AggregateError with an empty
message). The ball's user *Crystal Ball* (role Player) exists on the sandbox, made by `tools/ball-user.mjs`, its
password in `seer/.env`; the module is deployed `--local`, enabled and registered there; the sandbox's Service
URL setting is `http://localhost:30001/crystalball`; the Seer runs from a terminal there (`npm run seer:dev`;
PowerShell wants `npm.cmd`), never as a service. The name is free (the setup screen's `getPackages`, 7,089
modules, has no "Crystal Ball" and no `crystalball`); on GitHub since 2026-11-02 (`Txpple/fvtt-mod-crystalball`,
`main` pushed, `sync` on in the suite's `repos.json`, every companion's family section carrying it); not
released, not on prod. Owed before a release: the Linux deploy on prod (never tested on Linux: the deploy guide
and the unit are reviewed, not run). Measured on this world: the DM's gaze ≈ 90k tokens (every own page and four sheets under `gmGaze`
`player`), a Warlock player's ≈ 69k, a Paladin's ≈ 46k, the lore 37k of each (the Bestiary's eleven pages and
the four backstories are player-observable); a 1,400-token answer takes about sixteen seconds at low effort.

## The rules this module keeps

- **The window talks only to the Seer, the Seer only to Foundry and the model.** No client holds a key or calls
  the model; the Seer binds `127.0.0.1` and is reached through a reverse proxy or tunnel rule on Foundry's own
  origin (prod) or on a second local port with CORS for one origin (the sandbox). `docs/seer-contract.md` is the
  contract: endpoints, the `X-Foundry-Session` header, the SSE events, the error bodies, the settings the Seer
  reads, the gaze's layers, the stub model's sentence. A change to it is made there first.
- **Identity is Foundry's.** Every request carries the player's own session id; the Seer opens a socket to Foundry
  with it and reads the `session` event (`{ sessionId, userId }`); no user, no answer. The probe is side-effect
  free for a connected player and is asked on every request (Foundry rebinds a session id to whoever logs in next
  on that browser, so a remembered answer would hand one player another's gaze); only a refusal is remembered, for
  30 s. The id is never logged (a hash keys that memo).
- **The ball's user is a Player, never a GM.** Foundry sends every document to every connected user whatever its
  role, so the role buys no reading; a GM-level socket that runs no modules would be elected the table's active GM
  while the DM is away and By the Books' consequences would land on it and die. The Seer writes nothing to
  Foundry: its socket emits `world` and nothing else.
- **The join, as 14.369 has it** (read from the build): the ball's user id comes from `getJoinData` on a socket
  holding the fresh cookie a plain GET of `/join` hands out (the page lists no users; a GET of `/join` with a
  session cookie logs that session out, so the Seer never sends one); `POST /join` names Foundry's own `Origin`
  (and `Sec-Fetch-Site: same-origin`) or Foundry answers 400; sessions last 24 hours, the Seer resumes on its
  cookie after a drop and rejoins when Foundry has forgotten it. A build that reshapes any of this fails the
  fixtures under `seer/tests/fixtures/<version>/` before a live socket hangs.
- **What the lore holds is the DM's ownership, nothing else.** A journal entry or page at `default ≥ 2` is every
  player's lore (on this world the Bestiary and the four backstories are, as measured); a secret block shows in the
  shared lore only when every player owns the page, and in a player's own layer when they do. Sheet numbers (hit
  point max, AC, skills, slots, initiative) are worked out from the source data with numeric effect changes applied
  and marked so; unidentified items show their unidentified face; unprepared spells are named, not described.
- **The gaze is the Seer's, from the live world, never the client's.** Four layers in a fixed, deterministic order
  (instructions and the DM's table notes; the lore every player can observe; the party with its stash and Clue
  Board record; the player's own pages and curated sheets), the permission rule mirroring `testUserPermission` at
  OBSERVER, each layer a cached system block so a party shares the first three. The gaze is never written to disk.
- **Clue Board is read, never required** (`flags["fvtt-mod-clueboard"]` on the Group actor, schema 2, joined to
  the world Clue items); Card Catalogue's body class paints the button; nothing else is detected. No hook emitted,
  none listened to.
- **Limits live in the Seer** (per user per hour and day, the table's day and month in dollars, the message length,
  the sitting window, the gaze budget) and the window only reports them; a cap answers 429 with its scope. A call
  counts the moment the model is asked, whatever its end (`outcome` in the ledger line; an abandoned stream is
  still billed, so it is still counted). The calendar follows the box's zone, which `healthz` reports and the
  unit sets with `TZ`.
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
- `seer/src/`: `main.js` (the entry: the Node 24 check, the process-level handlers, always runs), `config.js`
  (the environment and the config file, BOM-tolerant, `DATA_DIR` from systemd's `STATE_DIRECTORY` when set),
  `start.js`, `foundry.js` (join, the ball's socket, the probe, the world), `settings.js` (the module's
  world settings off the payload, user-scoped rows ignored, the module's active check), `permission.js`,
  `gaze.js`, `markdown.js` (the enrichers and turndown), `labels.js` (dnd5e's key-to-label maps), `sheet.js`,
  `model.js`, `limits.js`, `ledger.js`, `sittings.js`, `http.js`, `instructions.js` (versioned), `log.js`;
  `seer/config.json` the defaults; `seer/tests/` with synthetic fixtures under `fixtures/<foundry version>/`;
  `seer/deploy/` the systemd unit and the Linux guide; `seer/README.md`.
- `tools/live-check.mjs`: the sandbox walk (`FOUNDRY_HOST=local`, `--walk`, `--seer <url>`, `--asker <member>`);
  `tools/fake-seer.mjs`: a stub-only stand-in Seer for the walk, never deployed; `tools/ball-user.mjs`: the ball's
  user on a sandbox.
- **Identity in the window**: `game.socket.session.sessionId` first (Foundry 14's session cookie is HttpOnly), the
  cookie only for an older build; the walk asserts the two are equal.
