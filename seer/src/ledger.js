/**
 * The usage ledger, `usage.jsonl` under DATA_DIR: one JSON line per model call (when, who, the
 * model, the four token counts, the cost, the layer hashes, the latency, whether it was the stub,
 * and its outcome: done, aborted or failed, with `estimated` when the spend had to be worked out).
 * Counts and hashes, never words. It is append-only, so a line is appended and fsynced, never
 * written through a temporary file and a rename (a rename would race a concurrent append and lose
 * a line). At start its lines seed the limits store, which does the counting and summing.
 */

import fs from "node:fs";
import path from "node:path";

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
