/**
 * The Seer's entry point: configuration from the process environment only (the `seer:dev`
 * script passes `--env-file=seer/.env`; on a box systemd's `EnvironmentFile=` does), the config
 * file over the committed defaults, the Foundry link, the HTTP server, the daily sweep, and a
 * clean shutdown on SIGINT and SIGTERM. Relative paths (DATA_DIR, CONFIG) are taken from the
 * repository root, so the Seer finds its files whatever directory it is started from.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLink } from "./foundry.js";
import { createServer, normaliseBase } from "./http.js";
import { createLedger } from "./ledger.js";
import { createLimits } from "./limits.js";
import { enabled, log, setLevel } from "./log.js";
import { createModel } from "./model.js";
import { createSittings, ensureDir } from "./sittings.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SEER_DIR = path.resolve(here, "..");
export const REPO_DIR = path.resolve(SEER_DIR, "..");
export const DEFAULTS_FILE = path.join(SEER_DIR, "config.json");

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

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
  const defaults = JSON.parse(fs.readFileSync(defaultsPath, "utf8"));
  let config = defaults;
  if (configPath && path.resolve(configPath) !== path.resolve(defaultsPath)) {
    if (fs.existsSync(configPath))
      config = merge(defaults, JSON.parse(fs.readFileSync(configPath, "utf8")));
    else log.warn("config: the CONFIG file does not exist; using the defaults");
  }
  const problems = [];
  if (typeof config.model !== "string" || !config.model) problems.push("model");
  if (!EFFORTS.includes(config.effort)) problems.push("effort");
  if (!["5m", "1h"].includes(config.cacheTtl)) problems.push("cacheTtl");
  if (!(config.maxOutputTokens > 0)) problems.push("maxOutputTokens");
  for (const k of [
    "perUserHour",
    "perUserDay",
    "tableDayUsd",
    "tableMonthUsd",
    "messageChars",
    "sittingTurns",
    "gazeBudgetTokens"
  ]) {
    if (!(Number(config.limits?.[k]) >= 0)) problems.push(`limits.${k}`);
  }
  if (!config.prices?.[config.model])
    log.warn("config: no prices for the model; its calls are costed at 0", { model: config.model });
  if (problems.length) throw new Error(`config: bad or missing ${problems.join(", ")}`);
  return config;
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
    dataDir: fromRepo(env.DATA_DIR || "seer/data"),
    configFile: fromRepo(env.CONFIG || "seer/config.json"),
    logLevel: env.LOG_LEVEL || "info"
  };
}

/** The Seer's version: module.json's, one version for both halves. */
export function readVersion() {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(REPO_DIR, "module.json"), "utf8")).version ?? "0.0.0"
    );
  } catch {
    return "0.0.0";
  }
}

async function main() {
  const env = readEnv();
  setLevel(env.logLevel);
  const config = loadConfig(env.configFile);
  const version = readVersion();
  ensureDir(env.dataDir);

  const ledger = createLedger(env.dataDir);
  const limits = createLimits({ limits: config.limits });
  limits.seed(ledger.read());
  const sittings = createSittings({
    dir: env.dataDir,
    turnsWindow: config.limits.sittingTurns,
    retentionDays: config.sittingRetentionDays ?? 90
  });
  const sweep = () => {
    try {
      const removed = sittings.sweep();
      if (removed) log.info("sittings: closed sittings past retention deleted", { removed });
    } catch (err) {
      log.warn("sittings: the sweep failed", { error: err.message });
    }
  };
  sweep();
  const daily = setInterval(sweep, 24 * 3600 * 1000);
  daily.unref();

  const model = createModel({ apiKey: env.apiKey, stub: env.stub, config, log });
  if (!env.ballPassword) log.warn("BALL_PASSWORD is not set; the ball's user cannot join");
  const link = createLink({
    url: env.foundryUrl,
    user: env.ballUser,
    password: env.ballPassword,
    log
  });

  const server = createServer({
    basePath: env.basePath,
    corsOrigin: env.corsOrigin,
    link,
    model,
    limits,
    ledger,
    sittings,
    config,
    version,
    log,
    logEnabled: enabled
  });

  link.start();
  server.listen(env.port, env.bind, () => {
    log.info("seer: listening", {
      version,
      at: `http://${env.bind}:${env.port}${env.basePath || "/"}`,
      model: model.id,
      cors: env.corsOrigin || "off"
    });
  });
  server.on("error", err => {
    log.error("seer: the server failed", { error: err.message });
    process.exit(1);
  });

  let stopping = false;
  const stop = signal => {
    if (stopping) return;
    stopping = true;
    log.info("seer: stopping", { signal });
    clearInterval(daily);
    link.stop();
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    // An open answer stream holds its connection; it gets a moment, then it is cut.
    setTimeout(() => server.closeAllConnections(), 2000).unref();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(err => {
    log.error("seer: could not start", { error: err?.message ?? String(err) });
    process.exit(1);
  });
}
