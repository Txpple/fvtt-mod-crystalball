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
password in `seer/.env`; the module is deployed `--local`, enabled and registered there (how its Seer runs
there and its Service URL: 1.0.4, below). The name is free (the setup screen's `getPackages`, 7,089
modules, has no "Crystal Ball" and no `crystalball`); on GitHub since 2026-11-02 (`Txpple/fvtt-mod-crystalball`,
`main` pushed, `sync` on in the suite's `repos.json`, every companion's family section carrying it). **1.0.0
released and on prod the same day**: the annotated `v1.0.0` built by the reusable workflow, `latest` serving it;
installed through the installer, enabled, bounced; the ball's user made on prod by `tools/ball-user.mjs` with the
sandbox's password; the Seer on the box as `crystalball.service`, the deploy guide followed to the letter (a
system user, the clone at `v1.0.0` under `/opt/crystalball`, the env file under `/etc/crystalball`,
`StateDirectory`, `TZ` the DM's zone, the distribution's Node 24), "foundry: connected" at once; the tunnel's
`^/crystalball` route above the bare hostname, added in the Cloudflare dashboard (a token-run tunnel); `healthz`
and the identity probe green through the public hostname, a forged id 401. No model call on prod yet: the first
player's sitting is the user's. **1.0.1 the same day**: a saying drawn fresh over each empty sitting (no word of
Claude or the DM) and a 4,096-token answer cap, a cut answer marked by `done`'s `stop`; released, installed on
prod (17/17 served files byte-identical), the box's Seer at `v1.0.1` by the guide's Updating (`sudo` for its
`git`), `healthz` 1.0.1 through the public hostname; the sandbox on 1.0.1, its Seer from a terminal, its Service URL set back to the local Seer after the
mirror reset it. Measured on this world: the DM's gaze ≈ 90k tokens (every own page and four sheets under `gmGaze`
`player`), a Warlock player's ≈ 69k, a Paladin's ≈ 46k, the lore 37k of each (the Bestiary's eleven pages and
the four backstories are player-observable); a 1,400-token answer takes about sixteen seconds at low effort.
**1.0.2 the same evening, the rulebooks**: the ball looks up the Player's Handbook, Arcana Unleashed and Heroes
of Faerûn through two tools (`rulebooks.js`, the contract's *The rulebooks*), instructions version 3; built
against copies of the three books' packs (and dnd5e's `content24`, which the Handbook's glossary embeds) while the
sandbox was busy, then `tools/live-check.mjs --walk --question "What does the Fireball spell do, and which
classes can cast it?" --expect-lookup` GREEN on the real model: the window showed the search and the read lines,
the answer in 15 seconds, two lookups, $0.38, nearly all of it the first write of a 66k-token gaze (the lookups'
extra hops about three cents). Released through the reusable workflow, installed on prod through the installer
(18/18 served files byte-identical), the box's Seer at `v1.0.2` by the guide's Updating, `healthz` 1.0.2 and a
forged id 401 through the public hostname; the user tested it on prod ("i tested looks good"). Measured on the copies: a search answers in
about 250 to 380 tokens, a read in 40 to 1,100 (a long Heroes of Faerûn region page about 3,800); the tool
definitions add about 350 tokens to the cached prefix. **1.0.3 the same evening**, on the user's word ("for arcana
unleashed, i want chapter 5, chapter 6, appendix, and bestiary excluded"), Arcana Unleashed's Chapter 5 (magic
items, and its magic-items pack dropped from the defaults), Chapter 6 (creatures) and Appendix (art and the
adventure) are left out by default, then Chapter 3 (creating magical worlds; "remove Chapter 3: Creating Magical
Worlds too"), each by a line scoped to that book (`dnd-arcana-unleashed: Chapter 5`), because the Handbook has
a Chapter 3, 5 and 6 of its own; its bestiary was never read (actor packs are refused).
Checked against the copied packs; released ("you can then release and put on prod"), installed on prod through the
installer (18/18 served files byte-identical), the box's Seer at `v1.0.3`, `healthz` 1.0.3 and a forged id 401
through the public hostname; prod's world has no saved rulebook settings, so a GM page reads the new defaults. **1.0.4 released and on prod: the sandbox's ball made reliable** (the user: "crystal ball is not
working on sandbox again", then "just fix this shit so we dont have issues like this all the time on sandbox. no
terminal dependencies on this?", "do a long diag and figure out a long term solution why this fails on the windows
sandbox"). The ball had gone dark there five ways in one day: the Seer died with the session's terminal that ran it;
a mirror reset the Service URL to prod's and the files to prod's release; a stale process held the port; a dark
window never asked again; and a browser on another device on the network (Foundry's log: a login from a LAN address
while the day's others came from the machine itself) read `localhost:30001` as itself, while the Seer bound
127.0.0.1 and allowed one origin. Now the window searches for the Seer (`serviceCandidates`): the Service URL's
base, then, when that is a path on the page's own origin, the same path on **the companion port**, 30001 of the host
the browser reached Foundry by; the first `healthz` that answers is the Seer for every later call, and a dark window
asks again every ten seconds. The Seer's `CORS_ORIGIN` takes one origin, a list, or `*`; its reconnect backoff
caps at fifteen seconds (it had reached a minute, and the ball stayed dark a minute after a Foundry restart). The sandbox: `seer/.env` with `BIND=::` and `CORS_ORIGIN=*`, the Service URL back at the default `/crystalball`,
and the Seer as a Windows scheduled task by a `tools/sandbox-seer.mjs` (replaced in 1.0.5, below);
`tools/sandbox-service-url.mjs` retired.
Checked: `healthz` on 127.0.0.1, ::1, the Wi-Fi and the Tailscale address; a preflight from a LAN origin answered
`*`; no window among the task's three processes; `stop` and `start` through the task; the Seer rejoining after
`local-foundry.mjs restart --force`; `verify` green (377 tests); 1.0.4 deployed `--local`, byte-identical, the
manifest 1.0.4 after that restart; `tools/live-check.mjs --walk --default-url` GREEN on the real model, the GM page's
window lit by the companion port and Kartor's answer in 5 s. Released on the user's word ("Release and
prod"): the annotated `v1.0.4` through the reusable workflow, `latest` serving it; prod with only the bridge and
the ball's user connected, the installer PASS, 18/18 served files byte-identical with the release zip; the box's
Seer at `v1.0.4` by the guide's Updating over SSH, "foundry: connected" at once, `healthz` 1.0.4 and a forged id
401 through the public hostname. Known: the
MCP's restart and mirror guards count the ball's user among connected users (prod's `/api/status` reads 1 with the
box's Seer up), so the local restart needed `--force`; the MCP's guards discount it since the same evening (its
`scripts/lib/seer.mjs`, unreleased on its `main`). **1.0.5 released and on prod the same night: the review's corrections** (an adversarial review of 1.0.3 to 1.0.4 at the
user's request; the user: "yes lets go", then "Yes, release"). The scheduled task had died with STATUS_CONTROL_C_EXIT, a console event
reaching the hidden PowerShell's console, and its detached-launch repair registered a command with no path
separator; the tool is deleted and the task removed. The sandbox's Seer is now started beside Foundry by the MCP's
`local-foundry.mjs start` (a detached, windowless process, its lines in `seer/data/seer.log`, its pid beside
`headless.pid`; `stop` ends it first, `restart` does both, `status` shows it; a crash or a reboot needs a `start`,
as the sandbox's Foundry does; `npm run seer:dev` stays the plain terminal way). The window: the companion
candidate only on a plain-http page with the default setting (an https page, prod's, gets one candidate: the
tunnel's hostname hangs on port 30001, so 1.0.4's prod window would have shown Gazing… 15 s before Dark with the
Seer or the route down); a 3-second healthz probe with no session header, a simple GET with no preflight; the
found base kept only by the search still current; a dark window re-asks only for reasons that can heal (never
after a 401 or 403, where 1.0.4 asked every ten seconds for ever) and stays dark on screen while it asks. `verify`
green (378 tests); 1.0.5 deployed `--local`; `tools/live-check.mjs --walk --default-url` GREEN against the
launcher's Seer on the real model, the GM page's window lit by the companion port, Kartor's answer in 4.5 s. Released
through the reusable workflow (the annotated `v1.0.5`, `latest` serving it), installed on prod through the installer with no
player connected (PASS, 18/18 served files byte-identical with the zip), the box's Seer at `v1.0.5` by the guide's Updating
over Tailscale SSH (its browser check passed by the user), "foundry: connected" at once, `healthz` 1.0.5 and a forged id 401
through the public hostname; the sandbox runs the same 1.0.5 files, deployed `--local` before the walk. **Unreleased
on `main`: the cache split** (the user, on the sandbox's daily cap tripped by a test day: "how can we optimze costs",
then "Yes, make it"). Measured first on the sandbox's ledger: 29 real calls, $5.27 on Opus, $4.02 of it ten cold
writes of the gaze after lulls past the five-minute cache (the same tokens $2.64 on Sonnet 5.5, $0.14 on Haiku 5.5);
a player's gaze 48k tokens, the lore 37k of it (the Session Diary 16.7k, the handouts 11.3k), the party layer
carrying every member's hit points. Now the markers carry two TTLs: `stableCacheTtl` (`1h`) on the instructions and
the lore, the bulk of the gaze and the DM's alone to change; `cacheTtl` (`5m`) on the party and the top-level
marker, which change with every blow and turn. A stable TTL shorter than the other is refused at start, as the API
would; a write without the response's `cache_creation` split is priced at the dearer TTL; Sonnet's cache-read price
corrected to $0.10. `verify` green (380 tests); a probe of the request shape on Haiku took the mixed markers and
split the write (73k at 1h, 66k at 5m), the second call reading all of it; the sandbox's Seer bounced alone (its pid
ended, the launcher's `start`) and up on the new config. No sitting on the real model through the Seer since (the
day's cap stood); not released, prod on 1.0.5. The sandbox's Seer then moved, on the user's word ("id like to
test at sonnet low"), to Sonnet 5.5 at low effort with a $10 day cap, through a gitignored override
(`seer/data/config.sandbox.json`, named by `CONFIG` in `seer/.env`); the ledger untouched, prod's config the committed
defaults. Then Haiku 5.5 at low effort ("let me try haiku"): its prices in the override (the committed config has
none, and an unpriced model costs 0 against the caps) and `refusalFallback` off (Haiku has no server-side fallback). The user then tried Haiku at max (cut off: the thinking
spent the 4,096-token cap before a word), xhigh and high ("haiku high isnt bad"), Sonnet low and Opus medium again on
the same questions ("sonnet low is clearly better tho", but "for a hobby, i think haiku is better since it comes
out of my pocket"), and settled: "lets settle on haiku". **The committed defaults now** (unreleased): Haiku 5.5 at
high, `refusalFallback` false, 16,000 output tokens, `callTimeoutMs` 90000, Haiku priced with its `longPrompt` rates
(a request past 100,000 prompt tokens at five times, as the API bills); Sonnet and Opus priced still. `verify` green
(381 tests); the sandbox override cut to its raised caps (a $10 day, 60 an hour, 200 a day per player), so the
sandbox runs the committed model; the Seer bounced alone, `healthz` naming Haiku. Measured on the sandbox: 18 Haiku
questions $0.055, 0.1 to 0.3 cents each, 3 to 16 s at high; the same tokens about $0.93 on Sonnet low. Then, on the
user's word ("if we are on sonnet, the current limits on questions per hour/per day stand. if we are on haiku, it
can be unlimited"), a limits table by model: `limitsByModel` merged over `limits` for the configured model, `null`
for a user's hour or day no cap; Haiku's entry lifts both, Sonnet and Opus keep 10 and 40, the dollar caps stand for
every model; `usage/me` and `done` carry `null` for no cap and the window shows *n today*. `verify` green (384
tests); deployed `--local`, byte-identical; the sandbox's override down to its $10 day.

## The rules this module keeps

- **The window talks only to the Seer, the Seer only to Foundry and the model.** No client holds a key or calls
  the model; on a box the Seer binds `127.0.0.1` and is reached through a reverse proxy or tunnel rule on
  Foundry's own origin (prod); on a sandbox it binds every address and, on a plain-http page with the default
  Service URL, the window also looks on **the companion port**, 30001 of whatever host the browser reached Foundry
  by (never on an https page, never for a full URL), with CORS for the sandbox's origins (`CORS_ORIGIN`: one, a
  list, or `*`), so a sandbox keeps the default Service URL and a mirror cannot darken it. A dark window asks
  again every ten seconds only while the reason can heal, staying dark on screen meanwhile, never after a
  refusal. `docs/seer-contract.md` is the
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
  Foundry: its socket emits `world` and, for the rulebooks, a pack's `modifyDocument` get, nothing else.
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
- **The rulebooks are looked up, never put in the gaze** (`seer/src/rulebooks.js`): the packs the *Rulebooks*
  setting names (journal and item packs only, never a bestiary; an embedded stat block dropped; what else stays
  out by name in *Left out of the rulebooks*, a line led by `<book id>: ` counting for that book alone, since
  books share chapter names), read off the ball's socket on first need and held,
  searched and read through two tools the model calls (`search_rulebooks`, `read_rulebook`), at most four rounds
  and eight calls an answer, the last hop answering only. Foundry checks no read permission on a compendium get,
  so the Seer applies the pack's ownership as `getUserLevel` does, per asker. The tool definitions are the same
  bytes for the whole table (they cache ahead of the instructions). The settings' defaults live in
  `scripts/decide/rulebooks.js` and `seer/src/settings.js`, held equal by a test. No book text in a fixture:
  the books are licensed, the tests' packs synthetic.
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
- `scripts/decide/`: `sse.js` (the stream parser), `markdown.js` (the safe subset), `saying.js` (the opening
  saying from lang/en.json's lists), `rulebooks.js` (the rulebook settings' defaults, the lookup line), `session.js` (the session id,
  the base URL, `modelLabel`, `failureOf`, `waitOf`, `darkReason`); pure, `// @ts-check`, tested in `tests/`.
- `scripts/common.js`, `scripts/kit/`.
- `seer/src/`: `main.js` (the entry: the Node 24 check, the process-level handlers, always runs), `config.js`
  (the environment and the config file, BOM-tolerant, `DATA_DIR` from systemd's `STATE_DIRECTORY` when set),
  `start.js`, `foundry.js` (join, the ball's socket, the probe, the world, a pack's documents), `settings.js`
  (the module's world settings off the payload, user-scoped rows ignored, the module's active check),
  `permission.js`, `gaze.js`, `rulebooks.js` (the packs, their permission, the search, the reads, the library), `markdown.js` (the enrichers and turndown), `labels.js` (dnd5e's key-to-label maps), `sheet.js`,
  `model.js`, `limits.js`, `ledger.js`, `sittings.js`, `http.js`, `instructions.js` (versioned), `log.js`;
  `seer/config.json` the defaults; `seer/tests/` with synthetic fixtures under `fixtures/<foundry version>/`;
  `seer/deploy/` the systemd unit and the Linux guide; `seer/README.md`.
- `tools/live-check.mjs`: the sandbox walk (`FOUNDRY_HOST=local`, `--walk`, `--seer <url>`, `--default-url` for
  the companion-port search, `--asker <member>`); `tools/fake-seer.mjs`: a stub-only stand-in Seer for the walk,
  never deployed; `tools/ball-user.mjs`: the ball's user on a sandbox. On this suite's sandbox the Seer is started
  beside Foundry by the MCP's `local-foundry.mjs start` (`stop`, `restart` and `status` cover it; the suite's
  CLAUDE.md), never from a session's terminal or background job; `npm run seer:dev` is the plain terminal way.
- **Identity in the window**: `game.socket.session.sessionId` first (Foundry 14's session cookie is HttpOnly), the
  cookie only for an older build; the walk asserts the two are equal.
