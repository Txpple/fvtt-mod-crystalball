// The Seer on a Windows sandbox, with no terminal to keep open: a Task Scheduler task that runs the
// Seer from this clone in the user's logon session, hidden, starts it at logon and whenever it
// stops, and keeps its lines in seer/data/seer.log. Sandbox only: a box runs the systemd unit in
// seer/deploy/.
//
//   node tools/sandbox-seer.mjs install     register the task (again, after a Node or clone move) and start it
//   node tools/sandbox-seer.mjs uninstall   stop the Seer and remove the task
//   node tools/sandbox-seer.mjs start|stop|restart
//   node tools/sandbox-seer.mjs status      the task, the Seer's healthz, the log's last lines
//   node tools/sandbox-seer.mjs log [n]     the log's last n lines (20)
//   node tools/sandbox-seer.mjs url [--default | --set <url>]
//                                           the world's Service URL, through the GM bridge (FOUNDRY_PROFILE=local);
//                                           --default sets the contract's default, from which the window finds
//                                           this Seer on the companion port, whatever host the browser used
//   node tools/sandbox-seer.mjs run         what the task runs: the supervisor, which keeps a Seer running
//
// An account that is not elevated may register a task only for its own logon session (no boot
// trigger, no "whether the user is logged on or not"), and a console program in that session
// opens a window; so the task runs a hidden PowerShell, whose console the supervisor and the Seer
// inherit. The Seer therefore runs while the user is logged on, from logon to logoff, and starts
// again at the next logon. It reads seer/.env as `npm run seer:dev` does; on a sandbox reached from
// other devices set BIND=:: (every address) and CORS_ORIGIN=* there.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TASK = "Open Roll 5e Crystal Ball Seer";
const DATA_DIR = path.join(REPO_DIR, "seer", "data");
const LOG = path.join(DATA_DIR, "seer.log");
const PID_FILE = path.join(DATA_DIR, "seer.pid");
const LOG_KEEP = 5 * 1024 * 1024;
const ENV_FILE = path.join(REPO_DIR, "seer", ".env");

const command = process.argv[2] ?? "status";
const flag = n => process.argv.includes(`--${n}`);
const arg = n => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : null;
};

const die = msg => {
  console.error(msg);
  process.exit(1);
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** seer/.env read as the Seer reads it, for the port and base path healthz lives at. */
function seerEnv() {
  const env = {};
  if (!fs.existsSync(ENV_FILE)) return env;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function healthUrl() {
  const env = seerEnv();
  const port = Number(env.PORT || 30001);
  const base = (env.BASE_PATH ?? "/crystalball").replace(/\/+$/, "");
  return `http://127.0.0.1:${port}${base}/healthz`;
}

async function health() {
  try {
    const res = await fetch(healthUrl(), { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.json() : { error: `healthz answered ${res.status}` };
  } catch (err) {
    return { error: err?.cause?.code ?? err?.name ?? String(err) };
  }
}

/** Wait for a state, polling; the value, or null at the deadline. */
async function until(test, ms, every = 500) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) {
    const v = await test();
    if (v) return v;
  }
  return null;
}

function schtasks(args, { quiet = false } = {}) {
  const r = spawnSync("schtasks.exe", args, { encoding: "utf8", windowsHide: true });
  if (r.status !== 0 && !quiet) die(`schtasks ${args[0]} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return r;
}

function taskQuery() {
  const r = schtasks(["/Query", "/TN", TASK, "/FO", "LIST", "/V"], { quiet: true });
  if (r.status !== 0) return null;
  const fields = {};
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^([^:]+):\s+(.*)$/.exec(line);
    if (m) fields[m[1].trim()] = m[2].trim();
  }
  return fields;
}

const xmlEscape = s =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The pids the supervisor recorded, or null. */
function pids() {
  try {
    return JSON.parse(fs.readFileSync(PID_FILE, "utf8"));
  } catch {
    return null;
  }
}

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * The task's definition: a hidden PowerShell (the one program this session may start without a
 * window) running the supervisor from this clone, as this user, at logon and on demand, started
 * again a minute after it stops.
 */
function taskXml(userId) {
  const supervisor = `& '${process.execPath.replace(/'/g, "''")}' 'tools\\sandbox-seer.mjs' run`;
  const args = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "${supervisor}"`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Open Roll 5e: Crystal Ball's Seer, run from the module clone on this sandbox (tools/sandbox-seer.mjs).</Description>
    <URI>\\${TASK}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${xmlEscape(userId)}</UserId></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
      <WorkingDirectory>${xmlEscape(REPO_DIR)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function rotateLog() {
  try {
    if (fs.statSync(LOG).size > LOG_KEEP) fs.renameSync(LOG, `${LOG}.1`);
  } catch {
    // no log yet
  }
}

function tailLog(n) {
  if (!fs.existsSync(LOG)) return "(no log yet)";
  const lines = fs.readFileSync(LOG, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.slice(-n).join("\n");
}

/**
 * The supervisor: a Seer from this clone, its lines appended to the log, started again when it
 * exits (two seconds after a run that lasted, backing off to a minute when it keeps failing).
 * Runs until killed; `stop` ends it and the Seer by the pids it records.
 */
async function run() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const stamp = () => new Date().toISOString();
  let delay = 2000;
  for (;;) {
    rotateLog();
    const fd = fs.openSync(LOG, "a");
    fs.writeSync(fd, `${stamp()} INFO supervisor: starting the Seer {"node":"${process.versions.node}","pid":${process.pid}}\n`);
    const child = spawn(process.execPath, ["--env-file=seer/.env", "seer/src/main.js"], {
      cwd: REPO_DIR,
      stdio: ["ignore", fd, fd],
      windowsHide: true
    });
    fs.writeFileSync(PID_FILE, JSON.stringify({ supervisor: process.pid, seer: child.pid }));
    const started = Date.now();
    const end = await new Promise(resolve => {
      child.on("exit", (code, signal) => resolve(signal ?? code));
      child.on("error", err => resolve(err.message));
    });
    if (Date.now() - started > 60000) delay = 2000;
    fs.writeSync(fd, `${stamp()} WARN supervisor: the Seer exited (${end}); starting it again in ${delay / 1000} s\n`);
    fs.closeSync(fd);
    await sleep(delay);
    delay = Math.min(delay * 2, 60000);
  }
}

async function start() {
  const before = await health();
  if (!before.error) {
    console.log(`already up: the Seer ${before.version} answers at ${healthUrl()}`);
    return;
  }
  if (!taskQuery()) die(`the task "${TASK}" is not installed: node tools/sandbox-seer.mjs install`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  schtasks(["/Run", "/TN", TASK]);
  const up = await until(async () => {
    const h = await health();
    return h.error ? null : h;
  }, 20000);
  if (!up) die(`the task ran but nothing answers at ${healthUrl()} after 20 s; the log's end:\n${tailLog(10)}`);
  console.log(`up: the Seer ${up.version} at ${healthUrl()} (foundry: ${up.foundry?.connected ? "connected" : "not yet"})`);
}

async function stop() {
  if (taskQuery()) schtasks(["/End", "/TN", TASK], { quiet: true });
  // Ending the task ends its PowerShell; the supervisor and the Seer are ended by the pids recorded.
  const p = pids();
  for (const pid of [p?.seer, p?.supervisor]) {
    if (pid && alive(pid)) spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  }
  const gone = await until(async () => ((await health()).error ? true : null), 10000);
  if (!gone) die(`something still answers at ${healthUrl()} after the task ended; is a Seer running from a terminal?`);
  fs.rmSync(PID_FILE, { force: true });
  console.log("stopped");
}

async function restart() {
  await stop();
  await start();
}

async function install() {
  if (process.platform !== "win32") die("this tool is for a Windows sandbox; a box runs seer/deploy/");
  if (!fs.existsSync(ENV_FILE)) die(`no ${ENV_FILE}: copy seer/.env.example and fill it in first`);
  const userId = `${process.env.USERDOMAIN ?? os.hostname()}\\${os.userInfo().username}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crystalball-task-"));
  const file = path.join(dir, "task.xml");
  try {
    // schtasks reads the XML in UTF-16, as its own export writes it.
    fs.writeFileSync(file, Buffer.from(`﻿${taskXml(userId)}`, "utf16le"));
    const r = schtasks(["/Create", "/TN", TASK, "/XML", file, "/F"], { quiet: true });
    if (r.status !== 0) die(`schtasks /Create failed: ${(r.stderr || r.stdout || "").trim()}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`installed "${TASK}": the Seer from ${REPO_DIR} with ${process.execPath}, hidden, at each logon of ${userId} and whenever it stops`);
  await start();
}

async function uninstall() {
  if (!taskQuery()) {
    console.log("not installed");
    return;
  }
  await stop();
  schtasks(["/Delete", "/TN", TASK, "/F"]);
  console.log(`removed "${TASK}"`);
}

async function status() {
  const task = taskQuery();
  console.log(
    task
      ? `task "${TASK}": ${task.Status ?? "?"}; last run ${task["Last Run Time"] ?? "?"}, result ${task["Last Result"] ?? "?"}; as ${task["Run As User"] ?? "?"}`
      : `task "${TASK}": not installed`
  );
  const p = pids();
  if (p) console.log(`supervisor pid ${p.supervisor} ${alive(p.supervisor) ? "running" : "gone"}, seer pid ${p.seer} ${alive(p.seer) ? "running" : "gone"}`);
  const h = await health();
  console.log(
    h.error
      ? `seer: nothing at ${healthUrl()} (${h.error})`
      : `seer: ${h.version} at ${healthUrl()}, model ${h.model}, foundry ${h.foundry?.connected ? `connected to ${h.foundry.world}${h.foundry.worldOpen ? "" : " (no open world)"}` : "not connected"}, up ${h.uptimeSeconds}s`
  );
  const env = seerEnv();
  console.log(`env: BIND=${env.BIND || "127.0.0.1"} CORS_ORIGIN=${env.CORS_ORIGIN || "(off)"} FOUNDRY_URL=${env.FOUNDRY_URL || "http://localhost:30000"}${env.ANTHROPIC_API_KEY ? "" : " (stub: no key)"}`);
  console.log(`log: ${LOG}\n${tailLog(5).replace(/^/gm, "  ")}`);
}

/** The world's Service URL, through the GM bridge (the MCP's client, the local profile). */
async function url() {
  process.env.FOUNDRY_PROFILE ??= "local";
  const { Foundry, foundryConfig, loadEnv } = await import("fvtt-mcp-dnd5e/client");
  const want = flag("default") ? "/crystalball" : arg("set");
  const f = new Foundry(foundryConfig(loadEnv()));
  await f.connect();
  try {
    const r = await f.evaluate(
      async ({ want }) => {
        const id = "fvtt-mod-crystalball";
        const before = game.settings.get(id, "serviceUrl");
        if (want && before !== want) await game.settings.set(id, "serviceUrl", want);
        return { world: game.world.id, before, after: game.settings.get(id, "serviceUrl") };
      },
      { want }
    );
    const note =
      r.after === "/crystalball"
        ? "the default: the window finds a Seer on the companion port of whatever host it reached Foundry by"
        : "an explicit address: the window asks it alone";
    console.log(`${r.world}: Service URL ${r.before === r.after ? r.after : `${r.before} → ${r.after}`} (${note})`);
  } finally {
    await f.disconnect?.().catch(() => {});
  }
}

const commands = {
  install,
  uninstall,
  start,
  stop,
  restart,
  status,
  run,
  log: async () => console.log(tailLog(Number(process.argv[3]) || 20)),
  url
};
if (!commands[command]) die(`unknown command "${command}"; one of ${Object.keys(commands).join(", ")}`);
await commands[command]();
if (command !== "run") process.exit(0);
