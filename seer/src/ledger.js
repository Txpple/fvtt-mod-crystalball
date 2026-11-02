/**
 * The usage ledger, `usage.jsonl` under DATA_DIR: one JSON line per model call (when, who, the
 * model, the four token counts, the cost, the layer hashes, the latency, whether it was the stub).
 * Counts and hashes, never words. It is append-only, so a line is appended and fsynced, never
 * written through a temporary file and a rename (a rename would race a concurrent append and lose
 * a line). The table's day and month are summed from it at start.
 */

import fs from "node:fs";
import path from "node:path";
import { startOfDay, startOfMonth } from "./limits.js";

/** Every readable line of a ledger file; a torn or foreign line is skipped. */
export function readLedger(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const lines = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const line = JSON.parse(raw);
      if (line && typeof line === "object" && typeof line.at === "string") lines.push(line);
    } catch {
      // A line cut short by a crash mid-write: nothing to count.
    }
  }
  return lines;
}

/** The table's calendar day and month from ledger lines: messages and dollars. */
export function sums(lines, now = new Date()) {
  const day = startOfDay(now).getTime();
  const month = startOfMonth(now).getTime();
  const t = now.getTime();
  const out = { day: { messages: 0, cost: 0 }, month: { messages: 0, cost: 0 } };
  for (const l of lines) {
    const at = Date.parse(l.at);
    if (!Number.isFinite(at) || at > t) continue;
    const cost = Number(l.cost) || 0;
    if (at >= month) {
      out.month.messages++;
      out.month.cost += cost;
    }
    if (at >= day) {
      out.day.messages++;
      out.day.cost += cost;
    }
  }
  return out;
}

/** The ledger on disk. */
export function createLedger(dir) {
  const file = path.join(dir, "usage.jsonl");
  return {
    file,
    read: () => readLedger(file),
    /** Append one line and make it durable before the answer is reported done. */
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
