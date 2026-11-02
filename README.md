<!--
  The Open Roll 5e module template (fvtt-suite-openroll5e, templates/module/). To start a module:
  copy this folder into a new repo named fvtt-mod-<name>; replace "example" and "Example" in
  module.json, package.json, scripts/crystalball.js (rename it), lang/en.json and this README; add the
  repo to the suite's repos.json with a blurb and "kit": true; then, from the suite, run
  node tools/kit-sync.mjs and node tools/suite-sections.mjs. Delete this comment.
-->
# Open Roll 5e: Crystal Ball

One paragraph: what the module does at the table, and the problem it saves the table from.

## How it works

- **The first thing it does.** In a sentence or two, as a player or a GM meets it.

## Installation

Paste the manifest URL into Foundry's *Install Module* dialog:

```
https://github.com/Txpple/fvtt-mod-crystalball/releases/latest/download/module.json
```

Requires Foundry VTT v13 or v14 and the dnd5e system 5.x or 6.x. No other dependencies.

## Settings

*Game Settings → Configure Settings → Open Roll 5e: Crystal Ball.*

| Setting | Default | What it does |
| --- | --- | --- |
| Enabled | on | Off leaves the world exactly as Foundry and the system have it. |

## Repository layout

```
module.json                    the Foundry manifest
scripts/
  example.js                   the module's entry point
  kit/                         the Open Roll 5e kit: elect.js, receipt.js, log.js, the same
                               bytes in every module that holds it (the suite keeps them)
lang/en.json                   every word a player reads
tests/                         the unit tests (Vitest); tests/kit/ is the kit's own
```

## Development

There is no build step: the module is plain ES modules loaded straight from `scripts/`. Run
`npm install` once; `npm run verify` is the gate: Biome and the unit tests. `scripts/kit/` and
`tests/kit/` are copies the suite's `tools/kit-sync.mjs` writes: change the kit there, never here.

Releases: bump `version` and the `download` URL in `module.json` together and commit, then push an
annotated tag on `main` whose subject is the release title and whose body is the notes
(`git tag -a vX.Y.Z`). The release workflow checks the tag, runs the gate, builds the zip and
publishes it with a bare `module.json`. Run the workflow by hand for a dry run.

<!-- openroll5e:family -->
<!-- /openroll5e:family -->

## License

MIT. See [LICENSE](LICENSE).
