/**
 * Open Roll 5e: Example — the entry point (module.json's `esmodules`).
 *
 * The kit (scripts/kit/, byte-identical across the family) gives the module its logger and its
 * elect, and its receipts when it records moves a GM may want to revert. Words a player reads
 * come from lang/en.json through `game.i18n`, keyed under the module id; a setting's name and
 * hint are keys Foundry localizes itself.
 */

import { createElect } from "./kit/elect.js";
import { createLogger } from "./kit/log.js";

export const MODULE_ID = "fvtt-mod-example";

/** Every line opens with the module's title; debug lines need CONFIG.debug["fvtt-mod-example"]. */
export const log = createLogger(MODULE_ID);

/** The one client that makes a world change every client would otherwise repeat. */
export const elect = createElect(MODULE_ID, { log });

/** A string from lang/en.json, under this module's key. */
export const t = key => game.i18n.localize(`${MODULE_ID}.${key}`);

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "enabled", {
    name: `${MODULE_ID}.settings.enabled.name`,
    hint: `${MODULE_ID}.settings.enabled.hint`,
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
});

// The elect resumes here whatever the last elect left undone: once at ready, and each time the
// elect moves to this client.
elect.onElected(() => {
  if (!game.settings.get(MODULE_ID, "enabled")) return;
  log.info(t("elected"));
});
