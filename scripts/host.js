/**
 * Where what the Clue Board window opens appears: Card Catalogue's shell/host.js, copied by hand so
 * each module installs alone (a change to either is made in both). A dialog, a sheet or the Reader
 * opened from the window once the DM has detached it (Foundry's Detach Window, its own browser
 * window) is moved into that window and centred there (the user: "clue board has the modal issues");
 * Foundry renders every new window in the main one. The first window to open within a moment of an
 * interaction inside the Clue Board window is the one followed; the window itself is never moved.
 */

import { log } from "./common.js";

/** The interaction waited on: the case window it was in, until when, and whether to centre. */
let pending = null;

const FOR_MS = 2500;

/** Note an interaction inside a case window; `centre` asks for the window it opens to be centred. */
export function noteHost(app, { centre = false } = {}) {
  pending = { host: app ?? pending?.host ?? null, until: Date.now() + FOR_MS, centre: centre || !!pending?.centre };
}

/** A card menu's entry was clicked: centre what it opens, in whichever window its case is in. */
export const centreNext = () => noteHost(null, { centre: true });

/** Watch a case window: every pointer press and key in it notes it as the host. */
export function watchHost(app) {
  const note = () => noteHost(app);
  app.element?.addEventListener("pointerdown", note, true);
  app.element?.addEventListener("keydown", note, true);
}

const isCase = app => app?.id === "clueboard-mysteries";

function centre(app) {
  const el = app.element instanceof HTMLElement ? app.element : app.element?.[0];
  const r = el?.getBoundingClientRect();
  if (!r?.width) return;
  const view = el.ownerDocument.defaultView ?? window;
  app.setPosition({ left: Math.max(0, (view.innerWidth - r.width) / 2), top: Math.max(0, (view.innerHeight - r.height) / 2) });
}

function follow(app) {
  const p = pending;
  if (!p || Date.now() > p.until || isCase(app)) return;
  const windowId = p.host?.window?.windowId;
  if (!windowId && !p.centre) return;
  pending = null;
  // Foundry places a window once its render hooks have run: move and centre it after that.
  requestAnimationFrame(() =>
    requestAnimationFrame(async () => {
      try {
        const appV2 = app instanceof foundry.applications.api.ApplicationV2;
        if (windowId && appV2 && app.window?.windowId !== windowId) await app.render({ window: { windowId } });
        centre(app);
      } catch (err) {
        log.debug("placing a window opened from a case window failed", err);
      }
    })
  );
}

Hooks.on("renderApplicationV2", (app, _el, _context, options) => {
  if (options?.isFirstRender) follow(app);
});
Hooks.on("renderApplication", app => follow(app));
