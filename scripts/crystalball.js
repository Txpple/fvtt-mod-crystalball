/**
 * Open Roll 5e: Crystal Ball — the entry point (module.json's `esmodules`).
 *
 * The client half of the module: the world settings the Seer reads, a crystal ball button on the
 * sidebar's strip directly after Clue Board's (a button, never a sidebar tab), and the window it
 * opens (window.js). The other half, the Seer (seer/), holds the key and answers; this half never
 * talks to the model and never reads the world for anyone. Alone, without a Seer, the ball is
 * dark and says so. The plan is the suite's docs/plans/crystalball.md; the contract between the
 * halves is docs/seer-contract.md.
 *
 * The kit (scripts/kit/, byte-identical across the family) gives the module its logger
 * (common.js); no elect, no receipts, no class patches, no hooks of its own.
 */

import { log, MODULE_ID, setting, t } from "./common.js";
import { DEFAULT_LEAVE_OUT, DEFAULT_RULEBOOKS } from "./decide/rulebooks.js";
import { DEFAULT_SERVICE_URL } from "./decide/session.js";
import { CrystalBallWindow } from "./window.js";

const BUTTON_ID = "crystalball-button";

/** Clue Board's spy button: the ball sits right after it when it is there. */
const CLUEBOARD_BUTTON_ID = "clueboard-mysteries-button";

/* -------------------------------------------------- */
/*  init: the world settings the Seer reads            */
/* -------------------------------------------------- */

/**
 * The settings table of docs/seer-contract.md, name for name: the Seer reads them off the world's
 * settings collection, so the DM configures the ball from Foundry and never on the box. World
 * scope, so only a GM changes them.
 */
Hooks.once("init", () => {
  const key = name => ({ name: `${MODULE_ID}.settings.${name}.name`, hint: `${MODULE_ID}.settings.${name}.hint` });
  const fields = foundry.data.fields;
  const textarea = foundry.applications.fields?.createTextareaInput;

  game.settings.register(MODULE_ID, "enabled", {
    ...key("enabled"),
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: true
  });

  game.settings.register(MODULE_ID, "serviceUrl", {
    ...key("serviceUrl"),
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_SERVICE_URL,
    onChange: () => CrystalBallWindow.refresh()
  });

  // A long text: the settings form draws it as a textarea.
  game.settings.register(MODULE_ID, "tableNotes", {
    ...key("tableNotes"),
    scope: "world",
    config: true,
    type: new fields.StringField({ required: true, blank: true, initial: "" }),
    default: "",
    ...(textarea ? { input: (_field, config) => textarea({ ...config, rows: 6 }) } : {})
  });

  game.settings.register(MODULE_ID, "askers", {
    ...key("askers"),
    scope: "world",
    config: true,
    type: String,
    choices: {
      players: `${MODULE_ID}.settings.askers.players`,
      listed: `${MODULE_ID}.settings.askers.listed`
    },
    default: "players"
  });

  game.settings.register(MODULE_ID, "askerIds", {
    ...key("askerIds"),
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, "gmGaze", {
    ...key("gmGaze"),
    scope: "world",
    config: true,
    type: String,
    choices: {
      player: `${MODULE_ID}.settings.gmGaze.player`,
      all: `${MODULE_ID}.settings.gmGaze.all`
    },
    default: "player"
  });

  // The packs the ball may look rules up in, one id a line, and what it never reads in them.
  for (const [name, initial] of [
    ["rulebooks", DEFAULT_RULEBOOKS],
    ["rulebookLeaveOut", DEFAULT_LEAVE_OUT]
  ]) {
    game.settings.register(MODULE_ID, name, {
      ...key(name),
      scope: "world",
      config: true,
      type: new fields.StringField({ required: true, blank: true, initial }),
      default: initial,
      ...(textarea ? { input: (_field, config) => textarea({ ...config, rows: 6 }) } : {})
    });
  }
});

/* -------------------------------------------------- */
/*  The crystal ball button on the sidebar's strip     */
/* -------------------------------------------------- */

/**
 * One button on the sidebar's strip that opens the window in the middle of the screen: right
 * after Clue Board's spy button, else right after Journal (Clue Board inserts after Journal, so
 * either hook order ends Journal, Clue Board, Crystal Ball), else last of the tabs. It is not a
 * tab: no `data-tab`, no `data-action`, so the sidebar never switches, expands or draws anything
 * for it. Its painted picture (styles/icons/) shows only while Card Catalogue paints the others
 * (its class on the body); alone, the glyph.
 */
Hooks.on("renderSidebar", app => {
  try {
    if (!setting("enabled")) return;
    const menu = app.element?.querySelector("#sidebar-tabs menu, nav.tabs menu");
    if (!menu || menu.querySelector(`#${BUTTON_ID}`)) return;
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.id = BUTTON_ID;
    button.className = "ui-control plain icon fa-solid fa-crystal-ball crystalball-tab-icon";
    button.style.setProperty("--crystalball-tab-icon", `url("${foundry.utils.getRoute(`modules/${MODULE_ID}/styles/icons/crystal-ball.svg`)}")`);
    button.dataset.tooltip = t("tab");
    button.setAttribute("aria-label", t("tab"));
    button.addEventListener("click", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      CrystalBallWindow.open();
    });
    li.append(button);
    const anchor =
      menu.querySelector(`#${CLUEBOARD_BUTTON_ID}`)?.closest("li") ?? menu.querySelector('[data-tab="journal"]')?.closest("li");
    if (anchor) anchor.after(li);
    else {
      // The strip's last item is the collapse toggle, never a tab: the ball goes before it.
      const toggle = menu.querySelector("button.collapse")?.closest("li");
      if (toggle) toggle.before(li);
      else menu.append(li);
    }
  } catch (err) {
    log.error("adding the Crystal Ball button failed", err);
  }
});

/* -------------------------------------------------- */
/*  ready: the stylesheet probe and the API           */
/* -------------------------------------------------- */

/**
 * Party Stash's probe: Foundry v14 bundles module CSS, so the honest question is whether a rule
 * of ours reaches an element. The probe class gives `flex-direction: column`, which no bare div
 * has; when it does not, the stylesheet is loaded directly.
 */
Hooks.once("ready", () => {
  try {
    const probe = document.createElement("div");
    probe.className = "crystalball-css-probe";
    document.body.append(probe);
    const applied = getComputedStyle(probe).flexDirection === "column";
    probe.remove();
    if (!applied && !document.querySelector(`link[data-${MODULE_ID}-fallback]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `modules/${MODULE_ID}/styles/crystalball.css`;
      link.setAttribute(`data-${MODULE_ID}-fallback`, "true");
      document.head.append(link);
      log.warn("the manifest stylesheet is not in the cascade; loading it directly.");
    }
  } catch (err) {
    log.error("the stylesheet probe failed", err);
  }

  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = {
      open: () => CrystalBallWindow.open(),
      newSitting: () => CrystalBallWindow.newSitting()
    };
  }
});
