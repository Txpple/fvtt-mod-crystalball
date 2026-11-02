/**
 * The module's world settings, read off the world payload's `settings` collection, never from a
 * config file on the box: the DM configures the ball from Foundry. A setting the world has never
 * saved is its default (the contract's table). Values are stored as JSON strings. Pure.
 */

export const MODULE_ID = "fvtt-mod-crystalball";

/**
 * The rulebooks a fresh table opens to the ball: the player-facing packs of the 2024 Player's
 * Handbook, Arcana Unleashed and Heroes of Faerûn (a pack the world does not have is skipped).
 * Journal and item packs only; never a bestiary, an adventure, a scene or a table.
 */
export const DEFAULT_RULEBOOKS = [
  "dnd-players-handbook.content",
  "dnd-players-handbook.classes",
  "dnd-players-handbook.origins",
  "dnd-players-handbook.feats",
  "dnd-players-handbook.spells",
  "dnd-players-handbook.equipment",
  "dnd-arcana-unleashed.book",
  "dnd-arcana-unleashed.subclasses",
  "dnd-arcana-unleashed.backgrounds",
  "dnd-arcana-unleashed.feats",
  "dnd-arcana-unleashed.spells",
  "dnd-arcana-unleashed.bastions",
  "dnd-arcana-unleashed.items",
  "dnd-heroes-faerun.book",
  "dnd-heroes-faerun.options",
  "dnd-heroes-faerun.items"
].join("\n");

/**
 * What the ball never reads in those books, by folder, entry or page name: the stat blocks and the
 * creatures, the adventure, the credits and the change logs.
 */
export const DEFAULT_LEAVE_OUT = [
  "Appendix B: Creature Stat Blocks",
  "Chapter 6: Magical Creatures",
  "Magical Creatures",
  "Tomb of the Shadow Serpents",
  "Credits",
  "Changelog",
  "Player's Handbook Changelog",
  "Heroes of Faerûn Change Log"
].join("\n");

export const SETTING_DEFAULTS = Object.freeze({
  enabled: true,
  serviceUrl: "/crystalball",
  tableNotes: "",
  askers: "players",
  askerIds: "",
  gmGaze: "player",
  modelLabel: "",
  rulebooks: DEFAULT_RULEBOOKS,
  rulebookLeaveOut: DEFAULT_LEAVE_OUT
});

/** A setting's list: one item a line (or comma-separated), trimmed, blanks and repeats dropped. */
export const listOf = value => [
  ...new Set(
    String(value ?? "")
      .split(/[\n,]/)
      .map(v => v.trim())
      .filter(Boolean)
  )
];

function parse(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * The module's settings with defaults filled and types coerced.
 * @returns {{ enabled: boolean, serviceUrl: string, tableNotes: string, askers: "players" | "listed",
 *   askerIds: string[], gmGaze: "player" | "all", modelLabel: string, rulebooks: string[],
 *   rulebookLeaveOut: string[] }}
 */
export function moduleSettings(world) {
  const raw = { ...SETTING_DEFAULTS };
  const trusted = trustedRow(world);
  const seen = new Set();
  for (const s of world?.settings ?? []) {
    // A user-scoped setting carries its user; only the world's own rows are the DM's.
    if (s?.user || typeof s?.key !== "string" || !s.key.startsWith(`${MODULE_ID}.`)) continue;
    if (!trusted(s)) continue;
    const name = s.key.slice(MODULE_ID.length + 1);
    // Should a key appear twice, the first trusted row decides.
    if (name in raw && !seen.has(name)) {
      seen.add(name);
      raw[name] = parse(s.value);
    }
  }
  return {
    enabled: raw.enabled !== false && raw.enabled !== "false",
    serviceUrl: String(raw.serviceUrl ?? SETTING_DEFAULTS.serviceUrl),
    tableNotes: typeof raw.tableNotes === "string" ? raw.tableNotes : "",
    askers: raw.askers === "listed" ? "listed" : "players",
    askerIds: String(raw.askerIds ?? "")
      .split(",")
      .map(id => id.trim())
      .filter(Boolean),
    gmGaze: raw.gmGaze === "all" ? "all" : "player",
    modelLabel: typeof raw.modelLabel === "string" ? raw.modelLabel : "",
    rulebooks: listOf(raw.rulebooks),
    rulebookLeaveOut: listOf(raw.rulebookLeaveOut)
  };
}

/**
 * Whether a world settings row is the DM's. Foundry 14.369 lets a player update their own
 * user-scoped row, `user: null` included, which would turn it into a world row of the player's
 * writing. The server stamps who last modified a row, so a world row counts only when that is
 * nobody recorded or a GM (role 3 or above).
 */
export function trustedRow(world) {
  const roles = new Map((world?.users ?? []).map(u => [u?._id, u?.role ?? 0]));
  return s => {
    const by = s?._stats?.lastModifiedBy;
    return by === undefined || by === null || (roles.get(by) ?? 0) >= 3;
  };
}

/** A trusted world setting's parsed value by its full key (`core.compendiumConfiguration`), or undefined. */
export function worldSetting(world, key) {
  const trusted = trustedRow(world);
  const row = (world?.settings ?? []).find(s => !s?.user && s?.key === key && trusted(s));
  return row ? parse(row.value) : undefined;
}

/** Whether the module is enabled in the world's module configuration. */
export const moduleActive = world =>
  (world?.modules ?? []).some(m => m?.id === MODULE_ID && m.active === true);

/**
 * Whether the user may ask under *Who may ask*. A banned user (role 0, Foundry's NONE) never may,
 * even on a session that is still live.
 */
export const mayAsk = (settings, user) =>
  (user?.role ?? 0) >= 1 && (settings.askers !== "listed" || settings.askerIds.includes(user?._id));
