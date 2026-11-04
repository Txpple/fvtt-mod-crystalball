/**
 * The presence record, `presence.jsonl` under DATA_DIR: who was in the world when, for the DM's
 * own audit. One JSON line per event, appended and fsynced as the usage ledger is:
 *
 * - `{ at, event: "join", userId, userName, how }`
 * - `{ at, event: "leave", userId, userName, how, since, minutes }` (`since` is the join's `at`)
 * - `{ at, event: "watching" }` when the Seer starts seeing the world, `{ at, event: "lost", reason }`
 *   when it stops (its socket dropped, the world shut down, the Seer stopped)
 *
 * `how` says how the Seer knows: `live` (Foundry's own broadcast, to the second), `probe` (the
 * minute's presence ask found the change), `already` (present when the Seer started watching, so
 * the join is no earlier than that), `world-shutdown` or `seer-lost` (a stint closed because the
 * world closed or the Seer stopped seeing it; a user still on when it sees again joins `already`).
 * Every join has its leave, so a stint's length is always on the leave line. Ids and names only.
 */

import fs from "node:fs";
import path from "node:path";

/** The append-only file, as the ledger writes it. */
export function presenceFile(dir) {
  const file = path.join(dir, "presence.jsonl");
  return {
    file,
    append(line) {
      const fd = fs.openSync(file, "a", 0o600);
      try {
        fs.writeSync(fd, `${JSON.stringify(line)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  };
}

/** No record kept: what the link uses when it is given none. */
export const noPresence = {
  names() {},
  unknown: () => [],
  seen() {},
  live() {},
  lost() {}
};

/**
 * The recorder. It keeps who is present and turns what the link tells it into lines.
 * @param {{ append: (line: object) => void, log: object, now?: () => Date }} options
 */
export function createPresence({ append, log, now = () => new Date() }) {
  const names = new Map();
  /** userId → the join's ISO time */
  const present = new Map();
  let watching = false;

  const write = line => {
    try {
      append(line);
    } catch (err) {
      log.warn("presence: a line could not be written", { error: err?.message ?? String(err) });
    }
  };
  const nameOf = id => names.get(id) ?? null;

  const join = (id, how, at) => {
    if (present.has(id)) return;
    present.set(id, at.toISOString());
    write({ at: at.toISOString(), event: "join", userId: id, userName: nameOf(id), how });
  };

  const leave = (id, how, at) => {
    const since = present.get(id);
    if (since === undefined) return;
    present.delete(id);
    const minutes = Math.round(((at.getTime() - Date.parse(since)) / 60000) * 10) / 10;
    write({
      at: at.toISOString(),
      event: "leave",
      userId: id,
      userName: nameOf(id),
      how,
      since,
      minutes: Math.max(0, minutes)
    });
  };

  return {
    /** Learn names from a users list (the join data, the world payload). */
    names(users) {
      for (const u of Array.isArray(users) ? users : [])
        if (u?._id && typeof u.name === "string") names.set(u._id, u.name);
    },

    /** The ids among these the recorder has no name for. */
    unknown: ids => ids.filter(id => !names.has(id)),

    /**
     * Everyone Foundry counts present, from a presence ask. The first since the Seer started
     * seeing the world opens the record with `watching` and joins them `already`; after that a
     * difference is a join or a leave the live broadcast missed.
     */
    seen(ids, at = now()) {
      const set = new Set(ids);
      if (!watching) {
        watching = true;
        write({ at: at.toISOString(), event: "watching" });
        for (const id of set) join(id, "already", at);
        return;
      }
      for (const id of [...present.keys()]) if (!set.has(id)) leave(id, "probe", at);
      for (const id of set) join(id, "probe", at);
    },

    /**
     * Foundry's broadcast: `active: true` when a user's first socket connects, `active: false`
     * when their last one goes. A player's own activity (cursor, targets, rulers) carries no
     * `active` and changes nothing. Ignored until the first presence ask has opened the record.
     */
    live(id, data, at = now()) {
      if (!watching || typeof id !== "string") return;
      if (data?.active === false) leave(id, "live", at);
      else if (data?.active === true) join(id, "live", at);
    },

    /** The Seer stopped seeing the world: every open stint is closed and the record says why. */
    lost(reason, at = now()) {
      if (!watching) return;
      watching = false;
      const how = reason === "world shutdown" ? "world-shutdown" : "seer-lost";
      for (const id of [...present.keys()]) leave(id, how, at);
      write({ at: at.toISOString(), event: "lost", reason: String(reason) });
    }
  };
}
