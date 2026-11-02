import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLedger, readLedger, sums } from "../src/ledger.js";
import { tempDir } from "./helpers.js";

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const fresh = () => {
  const d = tempDir("ledger");
  dirs.push(d);
  return d;
};

const line = (iso, cost, userId = "a") => ({
  at: iso,
  userId,
  userName: "A",
  model: "stub",
  usage: { input: 1, cacheWrite: 0, cacheRead: 0, output: 1 },
  cost,
  gazeTokens: 1,
  layers: { instructions: "h1", lore: "h2", party: "h3", own: "h4" },
  latencyMs: 5,
  stub: true
});

describe("the ledger", () => {
  it("appends one JSON line a call and reads them back", () => {
    const ledger = createLedger(fresh());
    ledger.append(line("2026-11-02T10:00:00.000Z", 0.1));
    ledger.append(line("2026-11-02T11:00:00.000Z", 0.2));
    const text = fs.readFileSync(ledger.file, "utf8");
    expect(text.split("\n")).toHaveLength(3);
    expect(text.endsWith("\n")).toBe(true);
    expect(ledger.read().map(l => l.cost)).toEqual([0.1, 0.2]);
    expect(path.basename(ledger.file)).toBe("usage.jsonl");
  });

  it("reads a missing file as empty and skips a torn line", () => {
    const dir = fresh();
    expect(readLedger(path.join(dir, "usage.jsonl"))).toEqual([]);
    fs.writeFileSync(
      path.join(dir, "usage.jsonl"),
      `${JSON.stringify(line("2026-11-02T10:00:00.000Z", 1))}\n{"at":"2026-11-02T1`
    );
    expect(readLedger(path.join(dir, "usage.jsonl"))).toHaveLength(1);
  });
});

describe("sums", () => {
  it("adds the table's calendar day and month, local time", () => {
    const now = new Date(2026, 10, 15, 12, 0);
    const lines = [
      line(new Date(2026, 10, 15, 1, 0).toISOString(), 0.5),
      line(new Date(2026, 10, 15, 11, 0).toISOString(), 0.25),
      line(new Date(2026, 10, 3, 9, 0).toISOString(), 2),
      line(new Date(2026, 9, 31, 23, 0).toISOString(), 9),
      line(new Date(2026, 10, 15, 13, 0).toISOString(), 100)
    ];
    expect(sums(lines, now)).toEqual({
      day: { messages: 2, cost: 0.75 },
      month: { messages: 3, cost: 2.75 }
    });
  });

  it("starts a new month at local midnight on the first", () => {
    const lines = [line(new Date(2026, 10, 30, 23, 59).toISOString(), 3)];
    expect(sums(lines, new Date(2026, 11, 1, 0, 0, 1)).month).toEqual({ messages: 0, cost: 0 });
    expect(sums(lines, new Date(2026, 10, 30, 23, 59, 30)).month).toEqual({ messages: 1, cost: 3 });
  });
});
