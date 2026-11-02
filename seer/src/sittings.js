/**
 * Sittings: one conversation between one Foundry user and the ball, one open at a time, kept on
 * disk under DATA_DIR as `sittings/<userId>/current.json` and, once closed by *New sitting*,
 * `sittings/<userId>/<startedAt>.json`. A sitting holds its turns and its running usage, never
 * the gaze. Every write goes to a temporary file first and is renamed over the old one, so a
 * crash leaves the previous sitting whole. Closed sittings older than the retention are swept at
 * start and daily. The DM can read every sitting on the box, and the window tells players so.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { log } from "./log.js";

/** A Foundry document id is alphanumeric; anything else never becomes a path. */
const SAFE_ID = /^[A-Za-z0-9]{1,64}$/;

/** A closed sitting's file name: its start, with the colons Windows refuses in a name replaced. */
export const archiveName = startedAt => `${String(startedAt).replace(/:/g, "-")}.json`;

const warned = new Set();

/**
 * Create a directory and narrow it to its owner. Windows has no POSIX modes (the directory's ACL
 * governs), so a refusal there is expected; anywhere else it means the sittings may be readable
 * by others, and it is said once per directory.
 */
export function ensureDir(dir, { platform = process.platform, warn = log.warn } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    if (platform === "win32" || warned.has(dir)) return;
    warned.add(dir);
    warn("storage: the data directory could not be narrowed to mode 0700", {
      dir,
      error: err.code ?? err.message
    });
  }
}

/** A short synchronous pause, for a retry inside a synchronous write. */
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Write a file whole through a temporary file and a rename. */
export function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Windows can refuse a rename for a moment while another process (an indexer, an antivirus)
  // holds the target open; four retries 20, 40, 80 and 160 ms apart ride that out.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(err?.code)) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      pause(20 * 2 ** attempt);
    }
  }
}

/**
 * The last turns that fit the window, starting on a player's turn (a conversation opens with one).
 * An empty turn is dropped: the API refuses an empty message, and one stored by an older build
 * would otherwise reject every later call of the sitting.
 */
export function windowOf(turns, size) {
  const said = turns.filter(t => typeof t?.text === "string" && t.text.trim());
  // slice(-0) is the whole list, so an empty window is said outright.
  const recent = size > 0 ? said.slice(-size) : [];
  while (recent.length && recent[0].role !== "user") recent.shift();
  return recent;
}

/**
 * The sitting store.
 * @param {{ dir: string, turnsWindow?: number, retentionDays?: number, now?: () => Date,
 *   newId?: () => string }} options
 */
export function createSittings({
  dir,
  turnsWindow = 24,
  retentionDays = 90,
  now = () => new Date(),
  newId = () => randomBytes(8).toString("hex")
}) {
  const root = path.join(dir, "sittings");

  const userDir = userId => {
    if (!SAFE_ID.test(String(userId ?? ""))) throw new Error("not a user id");
    return path.join(root, userId);
  };
  const currentFile = userId => path.join(userDir(userId), "current.json");

  const fresh = (userId, model) => ({
    id: newId(),
    userId,
    startedAt: now().toISOString(),
    model,
    turns: [],
    usage: { messages: 0, cost: 0 }
  });

  const save = sitting => {
    ensureDir(userDir(sitting.userId));
    writeAtomic(currentFile(sitting.userId), `${JSON.stringify(sitting, null, 2)}\n`);
    return sitting;
  };

  const load = userId => {
    try {
      return JSON.parse(fs.readFileSync(currentFile(userId), "utf8"));
    } catch (err) {
      if (err?.code === "ENOENT" || err instanceof SyntaxError) return null;
      throw err;
    }
  };

  return {
    root,

    /** The user's open sitting, created (empty) when there is none. */
    current(userId, { model } = {}) {
      return load(userId) ?? save(fresh(userId, model));
    },

    /** The turns the model is given before the new message: the window less one, for it. */
    history(sitting) {
      return windowOf(sitting.turns ?? [], turnsWindow - 1);
    },

    /** A finished exchange: the player's turn, the ball's, and what it cost. */
    append(userId, turns, { cost = 0, model } = {}) {
      const sitting = load(userId) ?? fresh(userId, model);
      sitting.turns.push(...turns);
      sitting.usage = {
        messages: (sitting.usage?.messages ?? 0) + 1,
        cost: (sitting.usage?.cost ?? 0) + (Number(cost) || 0)
      };
      if (model) sitting.model = model;
      return save(sitting);
    },

    /** Close the open sitting into the archive and open a fresh one. */
    startNew(userId, { model } = {}) {
      const open = load(userId);
      if (open) {
        let target = path.join(userDir(userId), archiveName(open.startedAt));
        if (fs.existsSync(target)) target = target.replace(/\.json$/, `-${open.id}.json`);
        writeAtomic(
          target,
          `${JSON.stringify({ ...open, closedAt: now().toISOString() }, null, 2)}\n`
        );
        fs.rmSync(currentFile(userId), { force: true });
      }
      return save(fresh(userId, model));
    },

    /** Delete closed sittings older than the retention; the open ones are never swept. */
    sweep() {
      const cutoff = now().getTime() - retentionDays * 24 * 3600 * 1000;
      let removed = 0;
      let users = [];
      try {
        users = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory());
      } catch (err) {
        if (err?.code === "ENOENT") return 0;
        throw err;
      }
      for (const u of users) {
        const base = path.join(root, u.name);
        for (const f of fs.readdirSync(base)) {
          if (f === "current.json" || !f.endsWith(".json")) continue;
          const file = path.join(base, f);
          if (fs.statSync(file).mtimeMs < cutoff) {
            fs.rmSync(file, { force: true });
            removed++;
          }
        }
      }
      return removed;
    }
  };
}
