/**
 * Who may observe a document, mirrored from Foundry's `testUserPermission` at OBSERVER. The
 * world payload reaches the ball's user unfiltered (Foundry enforces ownership on operations and
 * in the client's UI, never on the dump), so the Seer must apply the rule itself before a word of
 * the world goes into a gaze. Pure: plain documents and a plain user in, a boolean out.
 *
 * Foundry's rule: a user's level on a document is `ownership[userId] ?? ownership.default`; an
 * embedded document's INHERIT (-1) takes its parent's level for that user; OBSERVER is 2. Foundry
 * passes a GM (role 3 Assistant or 4 Gamemaster) everything; the ball does not. It is the players'
 * tool, so a GM reads what every player reads plus what is granted to them by name, and the DM
 * tests what the players get. The DM's own knowledge (the plot, the session plans) is not in the
 * world anyway, and the DM's assistant is the MCP, which reads it all.
 */

export const ROLES = Object.freeze({ NONE: 0, PLAYER: 1, TRUSTED: 2, ASSISTANT: 3, GAMEMASTER: 4 });

export const LEVELS = Object.freeze({ INHERIT: -1, NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 });

/** An ownership value stored on the document for one key (a user id or "default"), or undefined. */
function stored(doc, key) {
  const value = doc?.ownership?.[key];
  return Number.isInteger(value) ? value : undefined;
}

/** A user's own level on a document, with the parent's when the document inherits. */
export function levelOf(doc, userId, parent = null) {
  let level = stored(doc, userId) ?? stored(doc, "default") ?? LEVELS.NONE;
  if (level === LEVELS.INHERIT) level = parent ? levelOf(parent, userId) : LEVELS.NONE;
  return level;
}

/** The level every user without an explicit grant has: what every player can see. */
export function defaultLevelOf(doc, parent = null) {
  let level = stored(doc, "default") ?? LEVELS.NONE;
  if (level === LEVELS.INHERIT) level = parent ? defaultLevelOf(parent) : LEVELS.NONE;
  return level;
}

/**
 * The level granted to this user by name on the document (or on the parent, when the document
 * inherits), or null when nothing names them. A GM's explicit grants are what a GM reads beyond
 * the players' view.
 */
export function explicitLevelOf(doc, userId, parent = null) {
  const mine = stored(doc, userId);
  if (mine !== undefined && mine !== LEVELS.INHERIT) return mine;
  const inherits =
    mine === LEVELS.INHERIT || (mine === undefined && stored(doc, "default") === LEVELS.INHERIT);
  if (inherits && parent) return explicitLevelOf(parent, userId);
  return null;
}

/** Whether a user is a GM by role (Assistant GM or Gamemaster). */
export const isGM = user => (user?.role ?? 0) >= ROLES.ASSISTANT;

/**
 * Whether a user may observe a document (a journal page passes its entry as `parent`).
 * @param {object} doc
 * @param {{ _id: string, role: number }} user
 * @param {{ parent?: object | null }} [options]
 */
export function canObserve(doc, user, { parent = null } = {}) {
  // A banned user (role 0) observes nothing, whatever the document grants.
  if (!doc || !user?._id || !((user.role ?? 0) >= ROLES.PLAYER)) return false;
  if (isGM(user)) {
    return (
      defaultLevelOf(doc, parent) >= LEVELS.OBSERVER ||
      (explicitLevelOf(doc, user._id, parent) ?? LEVELS.NONE) >= LEVELS.OBSERVER
    );
  }
  return levelOf(doc, user._id, parent) >= LEVELS.OBSERVER;
}

/** Whether every player (anyone without an explicit grant) may observe the document. */
export const everyoneObserves = (doc, parent = null) =>
  defaultLevelOf(doc, parent) >= LEVELS.OBSERVER;

/** Whether the user owns the document by an explicit grant (level 3 under their own id). */
export const ownsExplicitly = (doc, userId) => stored(doc, userId) === LEVELS.OWNER;

/**
 * Whether the user would see a page's or an item's secret blocks (`<section class="secret">`):
 * Foundry enriches them for owners only (a GM's own grant counts; Foundry's GM pass does not).
 */
export function seesSecrets(doc, user, { parent = null } = {}) {
  return levelOf(doc, user?._id, parent) >= LEVELS.OWNER;
}
