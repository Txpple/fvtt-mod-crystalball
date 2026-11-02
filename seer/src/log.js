/**
 * The Seer's logger: one line per event on stderr, a level from LOG_LEVEL. Everything goes
 * through console.error and console.warn so stdout stays free and Biome's noConsole rule holds.
 * Nothing that reaches a logger may carry a session id, a password or the API key: callers pass
 * hashes and counts, never secrets.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let threshold = LEVELS.info;

/** Set the level by name (debug, info, warn, error, silent); an unknown name keeps info. */
export function setLevel(name) {
  threshold = LEVELS[String(name ?? "").toLowerCase()] ?? LEVELS.info;
}

/** Whether a level would print (so a caller can skip building an expensive debug line). */
export const enabled = level => (LEVELS[level] ?? LEVELS.info) >= threshold;

function line(level, message, fields) {
  if (!enabled(level)) return;
  const extra = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
  const text = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${extra}`;
  if (level === "warn") console.warn(text);
  else console.error(text);
}

export const log = {
  debug: (message, fields) => line("debug", message, fields),
  info: (message, fields) => line("info", message, fields),
  warn: (message, fields) => line("warn", message, fields),
  error: (message, fields) => line("error", message, fields)
};
