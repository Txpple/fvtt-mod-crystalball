# Open Roll 5e: Crystal Ball

A Foundry VTT module for the dnd5e system that puts a **crystal ball** on the sidebar, directly after Clue Board's
spy. A player opens it and talks to a Claude model about the game *as their character knows it*: the journal pages
they can read, their own sheet with everything they carry and can do, their party with its stash and its Clue
Board record. Nothing the DM keeps reaches it. The answers come from **the Seer**, a small Node service that runs
beside the Foundry server, holds the API key, and is logged into the world as a user of its own; no client ever
holds a key or talks to the model.

**0.1.0**, unreleased. The plan is `docs/plans/crystalball.md` in the suite repo; the contract between the window
and the Seer is [`docs/seer-contract.md`](docs/seer-contract.md); the Seer's own guide is
[`seer/README.md`](seer/README.md).

## How it works

- **The button.** A crystal ball (`fa-crystal-ball`) on the sidebar's strip after Clue Board's button (after
  Journal when Clue Board is not there). It is not a tab: the sidebar never changes. A click opens the Crystal Ball
  window in the middle of the screen, one per client.
- **A sitting.** The window is a transcript and an input. A player types a question and the ball answers, the
  words arriving as they are written. The conversation is the player's **sitting**; it is kept on the server
  between visits, and *New sitting* starts a fresh one. The status bar names the model and the player's count
  against their daily allowance. The DM can read sittings on the box, and the window says so.
- **What the ball knows.** For each player the Seer builds a **gaze** from the live world, under Foundry's own
  ownership rule: the journal pages every player can observe; the party (its members, its stash, and every clue
  and thread on its Clue Board when Clue Board is installed); then the pages only this player can observe and each
  character they own, as a curated sheet. The DM's *Table notes* setting is read to the ball first. A GM's gaze is
  a player's by default, so the DM sees what the players get. **Ownership decides the lore**: a journal entry or
  page players can observe is what the ball knows, so the DM chooses what it reads by setting ownership, as for
  the players themselves.
- **Who is asking.** The window sends the player's own Foundry session with every request, and the Seer asks
  Foundry whose it is. A stranger on the internet has no session; a player cannot pretend to be another.
- **What it costs.** The gaze is cached in layers shared across the party, so a sitting's later messages cost a
  fraction of its first. The Seer caps messages per player per hour and per day, and the table's spend per day
  and per month; past a cap the ball says so and goes quiet until the window turns.
- **When it is dark.** With the Seer unreachable, the world closed or the model refusing, the window says *the
  ball is dark* and why, and offers a retry. The module installs and enables alone; without a Seer it does nothing
  but that.

## Installation

Paste the manifest URL into Foundry's *Install Module* dialog:

```
https://github.com/Txpple/fvtt-mod-crystalball/releases/latest/download/module.json
```

Requires Foundry VTT v13 or v14 and the dnd5e system 5.x or 6.x. The module has no module dependencies; it needs
**the Seer** running beside the Foundry server (see [`seer/README.md`](seer/README.md): Node 24, a clone of this
repository, `npm ci --omit=dev`, a `.env` with the key and the ball's user, a systemd unit, and a reverse proxy or
tunnel rule that routes the `/crystalball` path to it). The ball's user is a Foundry user of role Player the DM
makes in User Management; the Seer logs in as it. Clue Board is read when present, never required.

## Settings

*Game Settings → Configure Settings → Open Roll 5e: Crystal Ball* (all world settings, the GM's).

| Setting | Default | What it does |
| --- | --- | --- |
| Enabled | on | Off hides the button and the Seer answers no one. |
| Service URL | `/crystalball` | Where the window calls the Seer: a path on Foundry's own origin (prod, behind a tunnel rule) or a full URL with the same path (a sandbox: `http://localhost:30001/crystalball`). |
| Table notes | empty | The DM's standing notes to the ball: its manner, what to decline, house facts. Read before anything else. |
| Who may ask | every player | Every user, or only the listed user ids. |
| Listed askers | empty | Comma-separated user ids, when *Who may ask* is *listed*. |
| The GM's gaze | a player's | What a GM's sitting knows: what every player sees plus the GM's own pages, or everything in the world. |

## Repository layout

```
module.json                    the Foundry manifest
scripts/
  crystalball.js               the entry point: settings, the button, the probe, the API
  window.js                    the Crystal Ball window
  common.js                    the id, the logger, the strings, the settings
  decide/                      pure rules, no Foundry: sse.js, markdown.js, session.js
  kit/                         the Open Roll 5e kit: elect.js, receipt.js, log.js, the same
                               bytes in every module that holds it (the suite keeps them)
styles/, templates/, lang/     the look, the window's template, every word a player reads
tests/                         the unit tests (Vitest); tests/kit/ is the kit's own
seer/                          the Seer: src/, tests/, config.json, deploy/, README.md
docs/seer-contract.md          the contract between the window and the Seer
tools/
  live-check.mjs               the sandbox walk (a GM page, a temporary player, a sitting)
  fake-seer.mjs                a stub-only stand-in for the Seer, for the walk alone; never deployed
  ball-user.mjs                makes or resets the ball's user on a sandbox
```

## Development

There is no build step: the module is plain ES modules loaded straight from `scripts/`, and the Seer is plain Node
run from `seer/src/main.js`. Run `npm install` once; `npm run verify` is the gate for both halves: Biome and the
unit tests. `npm run seer:dev` runs the Seer with `seer/.env`; without an `ANTHROPIC_API_KEY` it answers from a
stub model, which is what the tests and the live check use. `scripts/kit/` and `tests/kit/` are copies the suite's
`tools/kit-sync.mjs` writes: change the kit there, never here.

Releases: bump `version` and the `download` URL in `module.json` together and commit, then push an
annotated tag on `main` whose subject is the release title and whose body is the notes
(`git tag -a vX.Y.Z`). The release workflow checks the tag, runs the gate, builds the zip and
publishes it with a bare `module.json`; the Seer never ships in the zip and is deployed from the same tag.
Run the workflow by hand for a dry run.

<!-- openroll5e:family -->
<!-- /openroll5e:family -->

## License

MIT. See [LICENSE](LICENSE).
