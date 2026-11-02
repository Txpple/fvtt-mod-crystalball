/**
 * The Seer started: the config, the data directory, the ledger and the limits seeded from it,
 * the sittings and their daily sweep, the model, the Foundry link, the HTTP server, and a clean
 * shutdown on SIGINT and SIGTERM. main.js loads this once it has checked the Node version.
 */

import process from "node:process";
import { loadConfig, readEnv, readVersion } from "./config.js";
import { createLink } from "./foundry.js";
import { createServer, timeZone } from "./http.js";
import { createLedger } from "./ledger.js";
import { createLimits } from "./limits.js";
import { enabled, log, setLevel } from "./log.js";
import { createModel } from "./model.js";
import { createLibrary } from "./rulebooks.js";
import { createSittings, ensureDir } from "./sittings.js";

export async function start() {
  const env = readEnv();
  setLevel(env.logLevel);
  const config = loadConfig(env.configFile);
  const version = readVersion();
  try {
    ensureDir(env.dataDir);
  } catch (err) {
    // The commonest box mistake: a data directory inside a clone that ProtectSystem=strict made
    // read-only. Said once, plainly, instead of a stack trace every restart.
    throw new Error(
      `the data directory cannot be created (${err.code ?? err.message}); on a box give the unit ` +
        "StateDirectory=crystalball or set DATA_DIR to an absolute path the service may write"
    );
  }

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
  const library = createLibrary({ link, log });

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
    library,
    logEnabled: enabled
  });

  link.start();
  server.listen(env.port, env.bind, () => {
    log.info("seer: listening", {
      version,
      at: `http://${env.bind}:${env.port}${env.basePath || "/"}`,
      model: model.id,
      cors: env.corsOrigin || "off",
      timeZone: timeZone(),
      node: process.versions.node
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
