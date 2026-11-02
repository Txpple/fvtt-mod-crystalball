/**
 * The module's world settings, read off the world payload's `settings` collection, never from a
 * config file on the box: the DM configures the ball from Foundry. A setting the world has never
 * saved is its default (the contract's table). Values are stored as JSON strings. Pure.
 */

export const MODULE_ID = "fvtt-mod-crystalball";

export const SETTING_DEFAULTS = Object.freeze({
  enabled: true,
  serviceUrl: "/crystalball",
  tableNotes: "",
  askers: "players",
  askerIds: "",
  gmGaze: "player",
  modelLabel: ""
});

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
 *   askerIds: string[], gmGaze: "player" | "all", modelLabel: string }}
 */
export function moduleSettings(world) {
  const raw = { ...SETTING_DEFAULTS };
  for (const s of world?.settings ?? []) {
    // A user-scoped setting carries its user; only the world's own rows are the DM's.
    if (s?.user || typeof s?.key !== "string" || !s.key.startsWith(`${MODULE_ID}.`)) continue;
    const name = s.key.slice(MODULE_ID.length + 1);
    if (name in raw) raw[name] = parse(s.value);
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
    modelLabel: typeof raw.modelLabel === "string" ? raw.modelLabel : ""
  };
}

/** Whether the module is enabled in the world's module configuration. */
export const moduleActive = world =>
  (world?.modules ?? []).some(m => m?.id === MODULE_ID && m.active === true);

/** Whether the user may ask under *Who may ask*. */
export const mayAsk = (settings, user) =>
  settings.askers !== "listed" || settings.askerIds.includes(user?._id);
