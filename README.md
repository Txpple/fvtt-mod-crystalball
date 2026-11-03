# Open Roll 5e: Crystal Ball

A Foundry VTT module for the dnd5e system that puts a **crystal ball** on the sidebar, directly after Clue Board's
spy. A player opens it and talks to a Claude model about the game *as their character knows it*: the journal pages
they can read, their own sheet with everything they carry and can do, their party with its stash and its Clue
Board record. Nothing the DM keeps reaches it. The answers come from **the Seer**, a small Node service that runs
beside the Foundry server, holds the API key, and is logged into the world as a user of its own; no client ever
holds a key or talks to the model.

**1.0.0.** The plan is `docs/plans/crystalball.md` in the suite repo; the contract between the window
and the Seer is [`docs/seer-contract.md`](docs/seer-contract.md); the Seer's own guide is
[`seer/README.md`](seer/README.md).

## How it works

- **The button.** A crystal ball (`fa-crystal-ball`) on the sidebar's strip after Clue Board's button (after
  Journal when Clue Board is not there). It is not a tab: the sidebar never changes. A click opens the Crystal Ball
  window in the middle of the screen, one per client.
- **A sitting.** The window is a transcript and an input. A player types a question and the ball answers, the
  words arriving as they are written. The conversation is the player's **sitting**; it is kept on the server
  between visits, and *New sitting* starts a fresh one. The status bar names the model, and the player's count
  against their daily allowance when the model has one (Haiku, the default, has none, so it shows no count). The
  DM can read sittings on the box, and the window says so.
- **Keeping what it said.** The words can be selected and copied, and each answer has a copy button. *Export*
  (the file icon in the bar, as in Clue Board and Card Catalogue) saves the sitting to the browser's downloads as
  a Markdown file, `crystalball-<character>-<date>.md`.
- **What the ball knows.** For each player the Seer builds a **gaze** from the live world, under Foundry's own
  ownership rule: the journal pages every player can observe; the party (its members, its stash, and every clue
  and thread on its Clue Board when Clue Board is installed); then the pages only this player can observe and each
  character they own, as a curated sheet. The DM's *Table notes* setting is read with the ball's instructions. A GM's gaze is
  a player's by default, so the DM sees what the players get. **Ownership decides the lore**: a journal entry or
  page players can observe is what the ball knows, so the DM chooses what it reads by setting ownership, as for
  the players themselves.
- **How it answers.** The ball thinks with the player, from what the table has written. A story answer gives the
  facts with where they come from, then a short **Glimpses** list: the ball's own reading of what they might mean,
  worded as possibilities, with someone to ask or somewhere to look. What the players wrote on the Clue Board (a
  clue's note, where the party stands on a thread) is weighed like a fact and marked as the party's intuition. A
  rules question is answered exactly, from the books when it can look them up, then with how the rule plays for
  this character; a build question gets the best options compared and one recommended. It never states as true a
  name, place, event, motive, number or secret the table has not written. A player can ask for just the facts.
  Its instructions are written for the model it runs on (`seer/src/harness/`: Haiku's own; a general one, not yet
  tuned, for any other).
- **The rulebooks.** The ball can look up classes, subclasses and their features, species, backgrounds, feats,
  spells and the class spell lists, equipment and the rules chapters in the compendium packs the DM names in the
  *Rulebooks* setting (by default the 2024 Player's Handbook, Arcana Unleashed and Heroes of Faerûn, when the world
  has them). It searches and reads them only when a question needs it, says which book an answer comes from, and
  the window shows *the ball leafs through the rulebooks* while it looks. Only journal and item packs are read,
  never a bestiary: no monster and no stat block reaches it, and *Left out of the rulebooks* removes anything else
  by folder, entry or page name, in every book or in one (by default Arcana Unleashed's worldbuilding, magic items,
  creatures and adventure: Chapters 3, 5 and 6 and the Appendix). Each player reads only the packs
  Foundry opens to them.
- **Who is asking.** The window sends the player's own Foundry session with every request, and the Seer asks
  Foundry whose it is. A stranger on the internet has no session; a player cannot pretend to be another.
- **What it costs.** The gaze is cached in layers shared across the party, so a sitting's later messages cost a
  fraction of its first. The rulebooks are never part of the gaze: a question that looks something up pays for
  the lookup (a few hundred tokens an entry) and one more round with the model, a question that does not pays
  nothing more. The Seer caps messages per player per hour and per day, and the table's spend per day
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
| Service URL | `/crystalball` | Where the window calls the Seer. The default is a path on Foundry's own origin, which a hosted world's tunnel or proxy rule routes to the Seer. On a plain-http page with that default (a sandbox, with no proxy) the window also tries the same path on port 30001 of the host it reached Foundry by, the Seer's own port, so a sandbox needs no setting, from the machine itself or from another device on the network; an https page asks its own origin alone. A full URL, on Foundry's origin or elsewhere, is asked alone. |
| Table notes | empty | The DM's standing notes to the ball: its manner, what to decline, house facts. Read after its own instructions, and they win over them on manner (glimpses, length, voice), never on stating an invented fact as true. |
| Who may ask | every player | Every user, or only the listed user ids. |
| Listed askers | empty | Comma-separated user ids, when *Who may ask* is *listed*. |
| The GM's gaze | a player's | What a GM's sitting knows: what every player sees plus the GM's own pages, or everything in the world. |
| Rulebooks | the 2024 Player's Handbook, Arcana Unleashed and Heroes of Faerûn packs | The compendium packs the ball may look rules up in, one pack id a line. Journal and item packs only; empty, it looks nothing up. |
| Left out of the rulebooks | the Handbook's creature stat blocks; Arcana Unleashed's Chapter 3 (creating magical worlds), Chapter 5 (magic items), Chapter 6 (creatures) and Appendix (its adventure); credits, change logs | Folders, journal entries and pages it never reads in those packs, one name a line; `<book id>: <name>` leaves a name out of that book alone (`dnd-arcana-unleashed: Chapter 5`). |

## Repository layout

```
module.json                    the Foundry manifest
scripts/
  crystalball.js               the entry point: settings, the button, the probe, the API
  window.js                    the Crystal Ball window
  common.js                    the id, the logger, the strings, the settings
  decide/                      pure rules, no Foundry: sse.js, markdown.js, session.js,
                               saying.js, rulebooks.js (the settings' defaults, the lookup line)
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
## Part of Open Roll 5e

Crystal Ball is one of the Open Roll 5e modules for Foundry VTT, a suite built for one D&D 5e table and
shared. Each module installs and works on its own and none needs another; together they cover the
table from the fog of war to the loot. The other modules:

- [Open Roll 5e: Autoexplore](https://github.com/Txpple/fvtt-mod-autoexplore): lets a scene start fully explored, so the whole map shows through the fog of war while tokens still need line of sight.
- [Open Roll 5e: By the Books](https://github.com/Txpple/fvtt-mod-bythebooks): the 2024 rules played from the sheet: a hit rolls and applies its own damage, saves resolve themselves, reactions hold, concentration is tracked, and rests, senses, sizes and lights follow the book. Every rule that rides a use or an effect in the 2024 core books, Heroes of Faerûn, Arcana Unleashed and Ravenloft: The Horrors Within, each step with a receipt and a revert; offered, never enforced.
- [Open Roll 5e: Combat Plus](https://github.com/Txpple/fvtt-mod-combatplus): automates the chores of running a fight: combat music, an initiative gate, an out-of-turn movement block, defeated marking at 0 HP and turn alerts.
- [Open Roll 5e: Errata](https://github.com/Txpple/fvtt-mod-errata5e): corrects, in memory, bugs in the premium D&D 2024 books, the dnd5e system and Foundry itself, each fix held until the vendor ships its own.
- [Open Roll 5e: FX Studio](https://github.com/Txpple/fvtt-mod-fxstudio): visual and sound effects for dnd5e, played from what actually happened at the table, with about a thousand stock FX and a window for authoring your own.
- [Open Roll 5e: Loot Shelf](https://github.com/Txpple/fvtt-mod-lootshelf): loot chests and merchant shelves that players can take from, buy from and sell to without owning them, with a receipt for every trade.
- [Open Roll 5e: Open Server](https://github.com/Txpple/fvtt-mod-openserver): for hosted worlds: clears the startup pause so players can play before the GM arrives, and gives every user a one-click jump to their character's token, and their familiar's, from the Players list.
- [Open Roll 5e: Party Stash](https://github.com/Txpple/fvtt-mod-partystash): makes a dnd5e Group actor's inventory a working party stash: drags move instead of copying, coin moves through a dialog, and every transfer posts a receipt.
- [Open Roll 5e: Area Sounds](https://github.com/Txpple/fvtt-mod-areasounds): background sound for scenes: random one-shots with silence between them, seamless crossfaded loops, day and night gating, and quiet during combat.
- [Open Roll 5e: Token Art](https://github.com/Txpple/fvtt-mod-tokenart): gives every token the look of its state, ready, in combat or dead, each a file named beside the base art, with nothing to configure.
- [Open Roll 5e: Clue Board](https://github.com/Txpple/fvtt-mod-clueboard): keeps the party's Mysteries: every clue the GM hands them, stamped with where it was found and who has read it, sorted into the questions the party names.
- [Open Roll 5e: Card Catalogue](https://github.com/Txpple/fvtt-mod-cardcatalogue): turns every directory the table uses into a case of cards: the journal, the scenes, the actors and the items, each found by any word with its main action a click away, and a sidebar that shows only the tabs the table uses.

Three MCP servers for [Claude Code](https://claude.com/claude-code) complete the suite:

- [fvtt-mcp-dnd5e](https://github.com/Txpple/fvtt-mcp-dnd5e): builds D&D 5e content in a live Foundry world from Claude Code: a stat block becomes a complete NPC, a map image a walled and lit scene, an adventure its journals, tables and handouts.
- [fvtt-mcp-imagegen](https://github.com/Txpple/fvtt-mcp-imagegen): makes the art with Google's Gemini image models: icons, tokens, props, portraits and illustrations, token redresses and restyles, battlemap and overland-map repaints, and the illustrated session records, all grounded in what the world already shows.
- [fvtt-mcp-sessionscribe](https://github.com/Txpple/fvtt-mcp-sessionscribe): turns a session's Discord recording and Foundry chat log into its record. Its end-to-end `session-scribe` skill drives the server from the Craig link to a speaker-labelled transcript, a fully illustrated player recap, combat statistics, GM notes and a party snapshot.

Issues are welcome on every repo in the family; pull requests are not accepted, since each is one
author's design for one table, shared because it might suit yours. How they fit together is mapped in [fvtt-suite-openroll5e](https://github.com/Txpple/fvtt-suite-openroll5e).
<!-- /openroll5e:family -->

## License

MIT. See [LICENSE](LICENSE).
