/**
 * The Seer's logger: one line per event on stderr, a level from LOG_LEVEL. Everything goes
 * through console.error and console.warn so stdout stays free and Biome's noConsole rule holds.
 * Under systemd (JOURNAL_STREAM is set when stderr is the journal) each line opens with its
 * syslog priority, `<3>` to `<7>`, so `journalctl -p warning` shows the Seer's warnings.
 * Nothing that reaches a logger may carry a session id, a password or the API key: callers pass
 * hashes and counts, never secrets.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** sd-daemon's priority prefixes: err, warning, info, debug. */
const PRIORITIES = { error: "<3>", warn: "<4>", info: "<6>", debug: "<7>" };

let threshold = LEVELS.info;

let journal = Boolean(process.env.JOURNAL_STREAM);

/** Set the level by name (debug, info, warn, error, silent); an unknown name keeps info. */
export function setLevel(name) {
  threshold = LEVELS[String(name ?? "").toLowerCase()] ?? LEVELS.info;
}

/** Whether lines carry journal priorities (read from JOURNAL_STREAM at load; tests set it). */
export function setJournal(on) {
  journal = Boolean(on);
}

/** Whether a level would print (so a caller can skip building an expensive debug line). */
export const enabled = level => (LEVELS[level] ?? LEVELS.info) >= threshold;

/** One line as it is written. */
export function format(level, message, fields, at = new Date()) {
  const extra = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
  return `${journal ? PRIORITIES[level] : ""}${at.toISOString()} ${level.toUpperCase()} ${message}${extra}`;
}

function line(level, message, fields) {
  if (!enabled(level)) return;
  const text = format(level, message, fields);
  if (level === "warn") console.warn(text);
  else console.error(text);
}

export const log = {
  debug: (message, fields) => line("debug", message, fields),
  info: (message, fields) => line("info", message, fields),
  warn: (message, fields) => line("warn", message, fields),
  error: (message, fields) => line("error", message, fields)
};
