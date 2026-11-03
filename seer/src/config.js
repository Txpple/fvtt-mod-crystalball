/**
 * The Seer's configuration: the process environment (the `seer:dev` script passes
 * `--env-file=seer/.env`; on a box systemd's `EnvironmentFile=` does) and the config file over the
 * committed defaults. Relative paths are taken from the repository root, so the Seer finds its
 * files whatever directory it is started from. Imported by the start-up and by the tests; it starts
 * nothing itself.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normaliseBase } from "./http.js";
import { log } from "./log.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SEER_DIR = path.resolve(here, "..");
export const REPO_DIR = path.resolve(SEER_DIR, "..");
export const DEFAULTS_FILE = path.join(SEER_DIR, "config.json");

/** The oldest Node the Seer runs on: Foundry 14's own. main.js checks it before anything loads. */
export const NODE_MAJOR = 24;

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** JSON text without the byte-order mark Windows PowerShell writes at the head of a file. */
export const stripBom = text => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

const readJson = file => JSON.parse(stripBom(fs.readFileSync(file, "utf8")));

/** Objects merged key by key, anything else replaced: an override names only what it changes. */
function merge(base, over) {
  if (!over || typeof over !== "object" || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] =
      v && typeof v === "object" && !Array.isArray(v) && base?.[k] && typeof base[k] === "object"
        ? merge(base[k], v)
        : v;
  }
  return out;
}

/** The config: the committed defaults, then the CONFIG file over them when it is another file. */
export function loadConfig(configPath, defaultsPath = DEFAULTS_FILE) {
  const defaults = readJson(defaultsPath);
  let config = defaults;
  if (configPath && path.resolve(configPath) !== path.resolve(defaultsPath)) {
    if (fs.existsSync(configPath)) config = merge(defaults, readJson(configPath));
    else log.warn("config: the CONFIG file does not exist; using the defaults");
  }
  // The model's own limits over the table's: `config.limits` is what this model runs under.
  const byModel = config.limitsByModel?.[config.model];
  if (byModel && typeof byModel === "object")
    config = { ...config, limits: { ...config.limits, ...byModel } };
  const problems = [];
  if (typeof config.model !== "string" || !config.model) problems.push("model");
  if (!EFFORTS.includes(config.effort)) problems.push("effort");
  if (!["5m", "1h"].includes(config.cacheTtl)) problems.push("cacheTtl");
  if (!["5m", "1h"].includes(config.stableCacheTtl)) problems.push("stableCacheTtl");
  // The API takes the longer TTL first, and the stable layers come first in the prompt.
  else if (config.stableCacheTtl === "5m" && config.cacheTtl === "1h")
    problems.push("stableCacheTtl (shorter than cacheTtl)");
  if (!(config.maxOutputTokens > 0)) problems.push("maxOutputTokens");
  // Lookups per answer: 0 rounds lets the model answer without them although the tools are given.
  for (const k of ["lookupRounds", "lookupCalls"]) {
    if (config[k] !== undefined && !(Number.isInteger(config[k]) && config[k] >= 0))
      problems.push(k);
  }
  // A count of 0 would refuse every message with no wait to name, so counts start at 1; a
  // dollar ceiling of 0 is a deliberate off switch and is allowed. A user's hour and day may be
  // null, no cap at all.
  for (const k of [
    "perUserHour",
    "perUserDay",
    "messageChars",
    "sittingTurns",
    "gazeBudgetTokens"
  ]) {
    const v = config.limits?.[k];
    if (v === null && (k === "perUserHour" || k === "perUserDay")) continue;
    if (!(Number.isInteger(v) && v >= 1)) problems.push(`limits.${k}`);
  }
  for (const k of ["tableDayUsd", "tableMonthUsd"]) {
    if (!(Number(config.limits?.[k]) >= 0)) problems.push(`limits.${k}`);
  }
  if (!config.prices?.[config.model])
    log.warn("config: no prices for the model; its calls are costed at 0", { model: config.model });
  if (problems.length) throw new Error(`config: bad or missing ${problems.join(", ")}`);
  return config;
}

/**
 * Where the Seer keeps its files: DATA_DIR when set; else the directory systemd made for the unit
 * (`StateDirectory=` sets STATE_DIRECTORY, writable even under `ProtectSystem=strict`, where the
 * clone is read-only); else `seer/data` in the clone, the sandbox's.
 */
export function dataDirOf(env, fromRepo) {
  if (env.DATA_DIR) return fromRepo(env.DATA_DIR);
  // systemd joins several state directories with the path delimiter (a colon on Linux); the Seer
  // asks for one. path.delimiter, not ":", so a Windows path's drive letter is never split off.
  const state = env.STATE_DIRECTORY?.split(path.delimiter)[0];
  if (state) return path.resolve(state);
  return fromRepo("seer/data");
}

/** The environment, with the contract's defaults. */
export function readEnv(env = process.env) {
  const fromRepo = p => (path.isAbsolute(p) ? p : path.resolve(REPO_DIR, p));
  return {
    apiKey: env.ANTHROPIC_API_KEY?.trim() || "",
    stub: env.MODEL_STUB === "1",
    foundryUrl: env.FOUNDRY_URL || "http://localhost:30000",
    ballUser: env.BALL_USER || "Crystal Ball",
    ballPassword: env.BALL_PASSWORD ?? "",
    port: Number(env.PORT || 30001),
    bind: env.BIND || "127.0.0.1",
    basePath: normaliseBase(env.BASE_PATH ?? "/crystalball"),
    corsOrigin: env.CORS_ORIGIN?.trim() || "",
    dataDir: dataDirOf(env, fromRepo),
    configFile: fromRepo(env.CONFIG || "seer/config.json"),
    logLevel: env.LOG_LEVEL || "info"
  };
}

/** The Seer's version: module.json's, one version for both halves. */
export function readVersion() {
  try {
    return readJson(path.join(REPO_DIR, "module.json")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
