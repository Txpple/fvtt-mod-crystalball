// @ts-check
/**
 * The window's side of the Seer's contract, the parts that need no Foundry: who the caller is
 * (the session cookie, read as Foundry reads it), where the Seer is, what its model is called,
 * and which line a failure shows. Pure; tested in tests/session.test.js.
 */

/** The contract's default `serviceUrl`: the same-origin path the tunnel routes to the Seer. */
export const DEFAULT_SERVICE_URL = "/crystalball";

/** The longest message the Seer takes (the contract's `messageChars`). */
export const MESSAGE_LIMIT = 4000;

/**
 * The companion port: where a Seer beside a Foundry with no proxy listens (the Seer's default
 * `PORT`). A `serviceUrl` that is a bare path names Foundry's own origin, which a sandbox serves
 * nothing at; the window then also tries the same path on this port of the page's own host, so a
 * sandbox needs no Service URL at all, and one reached from another device on the network finds
 * the Seer beside the Foundry it is talking to rather than on itself.
 */
export const COMPANION_PORT = 30001;

/**
 * The `session` cookie's decoded value, or null. Split exactly as Foundry's `Game.getCookies()`
 * splits `document.cookie` (on "; " and then "="; a later cookie of the same name wins), so the
 * Seer is handed the very id Foundry's own socket presented.
 * @param {unknown} cookieString
 * @returns {string | null}
 */
export function sessionIdFrom(cookieString) {
  if (typeof cookieString !== "string" || !cookieString) return null;
  /** @type {string | null} */
  let found = null;
  for (const cookie of cookieString.split("; ")) {
    const [name, value] = cookie.split("=");
    if (name !== "session") continue;
    try {
      found = value ? decodeURIComponent(value) : null;
    } catch {
      found = null;
    }
  }
  return found || null;
}

/**
 * The Seer's base URL, no trailing slash: a path (`/crystalball`) is resolved against the page's
 * origin, a full http(s) URL is used as it is. Blank means the default; anything that is not
 * http(s) once resolved (a `javascript:` URL, say) is no service at all.
 * @param {unknown} serviceUrl
 * @param {string} origin
 * @returns {string | null}
 */
export function serviceBase(serviceUrl, origin) {
  const raw = typeof serviceUrl === "string" && serviceUrl.trim() ? serviceUrl.trim() : DEFAULT_SERVICE_URL;
  let url;
  try {
    url = new URL(raw, origin);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/**
 * Where the window looks for the Seer, in order: the Service URL's base, then, when that setting
 * is a path on the page's own origin (the default, prod's), the same path on the companion port
 * of the page's host. A setting that names another origin outright is tried alone. Empty when the
 * setting names no http(s) service.
 * @param {unknown} serviceUrl  the Service URL setting
 * @param {{ origin: string, protocol: string, hostname: string, port: string }} location  the page's
 * @returns {string[]}
 */
export function serviceCandidates(serviceUrl, location) {
  const first = serviceBase(serviceUrl, location.origin);
  if (!first) return [];
  const bases = [first];
  if (first.startsWith(`${location.origin}/`) && String(location.port) !== String(COMPANION_PORT)) {
    const path = first.slice(location.origin.length);
    bases.push(`${location.protocol}//${location.hostname}:${COMPANION_PORT}${path}`);
  }
  return bases;
}

/**
 * The model's family name for the status bar, from the id `healthz` reports: "Opus", "Sonnet",
 * "stub"; an id of another family is shown as it is, none as null.
 * @param {unknown} model
 * @returns {string | null}
 */
export function modelLabel(model) {
  if (typeof model !== "string" || !model.trim()) return null;
  if (model === "stub") return "stub";
  const family = /(opus|sonnet|haiku)/i.exec(model)?.[1];
  return family ? family[0].toUpperCase() + family.slice(1).toLowerCase() : model;
}

/** The contract's 429 scopes, as their lang keys. */
const LIMIT_SCOPES = { hour: "hour", day: "day", "table-day": "tableDay", "table-month": "tableMonth" };

/** The contract's 503 reasons, as their lang keys. */
const DARK_REASONS = { "foundry-disconnected": "foundryDisconnected", "world-closed": "worldClosed", model: "model" };

/**
 * A code's lang key from one of the maps above; an unknown code (or `constructor`, say) is none.
 * @param {Record<string, string>} map
 * @param {unknown} code
 * @returns {string | null}
 */
const keyFor = (map, code) => (typeof code === "string" && Object.hasOwn(map, code) ? map[code] : null);

/**
 * @typedef {object} Failure
 * @property {string} key           the lang key under `errors.`
 * @property {number} [limit]       413: the most characters the Seer takes
 * @property {number} [retryAfter]  429: seconds until asking works again
 * @property {string} [message]     500: the Seer's short word
 * @property {number} [status]      any other status
 */

/**
 * The line a failure shows, from a non-2xx reply (its status and JSON body) or from a stream's
 * `error` event (status 0, the event's data). The body's `error` code decides when there is one;
 * the status when there is not.
 * @param {number} status
 * @param {any} body
 * @returns {Failure}
 */
export function failureOf(status, body) {
  const code = typeof body?.error === "string" ? body.error : null;
  const is = (/** @type {string} */ c, /** @type {number} */ s) => code === c || (!code && status === s);
  if (is("unknown-session", 401)) return { key: "unknownSession" };
  if (is("not-allowed", 403)) return { key: "notAllowed" };
  if (is("too-long", 413)) return { key: "tooLong", limit: Number(body?.limit) || MESSAGE_LIMIT };
  if (is("limit", 429)) {
    const scope = keyFor(LIMIT_SCOPES, body?.scope) ?? "hour";
    const retryAfter = Number(body?.retryAfter);
    return { key: `limit.${scope}`, retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0 };
  }
  if (is("dark", 503)) return { key: `dark.${keyFor(DARK_REASONS, body?.reason) ?? "model"}` };
  if (is("seer", 500)) {
    const message = typeof body?.message === "string" ? body.message.slice(0, 160) : "";
    return message ? { key: "seer", message } : { key: "seerQuiet" };
  }
  return status ? { key: "status", status } : { key: "seerQuiet" };
}

/**
 * A wait of so many seconds, as a count and its unit's lang key (singular for one): seconds under
 * a minute and a half, minutes under an hour and a half, hours past that, always rounded up.
 * @param {number} seconds
 * @returns {{ n: number, unit: "second" | "seconds" | "minute" | "minutes" | "hour" | "hours" }}
 */
export function waitOf(seconds) {
  const s = Math.max(1, Math.ceil(Number(seconds) || 0));
  if (s < 90) return { n: s, unit: s === 1 ? "second" : "seconds" };
  if (s < 90 * 60) {
    const m = Math.ceil(s / 60);
    return { n: m, unit: m === 1 ? "minute" : "minutes" };
  }
  const h = Math.ceil(s / 3600);
  return { n: h, unit: h === 1 ? "hour" : "hours" };
}

/**
 * Why the ball is dark, from `healthz`'s body (null: it answered and all is well). No body is an
 * unreachable Seer; then the Seer's link to Foundry, then the world.
 * @param {any} health
 * @returns {"unreachable" | "foundry" | "world" | null}
 */
export function darkReason(health) {
  if (!health || typeof health !== "object") return "unreachable";
  if (!health.foundry?.connected) return "foundry";
  if (!health.foundry?.worldOpen) return "world";
  return null;
}
