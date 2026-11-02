import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveName, createSittings, ensureDir, windowOf, writeAtomic } from "../src/sittings.js";
import { tempDir } from "./helpers.js";

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const fresh = () => {
  const d = tempDir("sittings");
  dirs.push(d);
  return d;
};

const turn = (role, n) => ({
  role,
  text: `${role} ${n}`,
  at: `2026-11-02T10:${String(n).padStart(2, "0")}:00.000Z`
});

describe("a sitting", () => {
  it("is created empty on first sight, under the user's directory", () => {
    const dir = fresh();
    let n = 0;
    const store = createSittings({
      dir,
      now: () => new Date("2026-11-02T10:00:00.000Z"),
      newId: () => `id${++n}`
    });
    const s = store.current("userA0000000001", { model: "stub" });
    expect(s).toEqual({
      id: "id1",
      userId: "userA0000000001",
      startedAt: "2026-11-02T10:00:00.000Z",
      model: "stub",
      turns: [],
      usage: { messages: 0, cost: 0 }
    });
    expect(fs.existsSync(path.join(dir, "sittings", "userA0000000001", "current.json"))).toBe(true);
    expect(store.current("userA0000000001").id).toBe("id1");
  });

  it("keeps each exchange and its cost", () => {
    const store = createSittings({ dir: fresh() });
    store.current("userA0000000001", { model: "stub" });
    store.append("userA0000000001", [turn("user", 1), turn("ball", 2)], {
      cost: 0.02,
      model: "stub"
    });
    const s = store.append("userA0000000001", [turn("user", 3), turn("ball", 4)], { cost: 0.01 });
    expect(s.turns.map(t => t.text)).toEqual(["user 1", "ball 2", "user 3", "ball 4"]);
    expect(s.usage.messages).toBe(2);
    expect(s.usage.cost).toBeCloseTo(0.03);
  });

  it("refuses an id that could be a path", () => {
    const store = createSittings({ dir: fresh() });
    for (const bad of ["../x", "a/b", "", "a b", "..", "a\\b"])
      expect(() => store.current(bad)).toThrow();
  });
});

describe("the window", () => {
  it("is the last turns, opening on a player's turn", () => {
    const turns = Array.from({ length: 30 }, (_, i) => turn(i % 2 ? "ball" : "user", i));
    expect(windowOf(turns, 24)).toHaveLength(24);
    expect(windowOf(turns, 24)[0].text).toBe("user 6");
    expect(windowOf(turns, 23)).toHaveLength(22);
    expect(windowOf(turns, 23)[0].role).toBe("user");
    expect(windowOf(turns, 0)).toEqual([]);
  });

  it("drops an empty turn, which the API would refuse", () => {
    const turns = [
      turn("user", 1),
      { role: "ball", text: "  ", at: "x" },
      turn("user", 2),
      { role: "ball", text: "", at: "y" },
      turn("ball", 3)
    ];
    expect(windowOf(turns, 24).map(t => t.text)).toEqual(["user 1", "user 2", "ball 3"]);
  });

  it("leaves room for the new message", () => {
    const store = createSittings({ dir: fresh(), turnsWindow: 24 });
    const s = { turns: Array.from({ length: 40 }, (_, i) => turn(i % 2 ? "ball" : "user", i)) };
    const h = store.history(s);
    expect(h.length).toBeLessThanOrEqual(23);
    expect(h[0].role).toBe("user");
    expect(h.at(-1).text).toBe("ball 39");
  });
});

describe("a new sitting", () => {
  it("archives the open one by its start and opens a fresh one", () => {
    const dir = fresh();
    let clock = new Date("2026-11-02T10:00:00.000Z");
    let n = 0;
    const store = createSittings({ dir, now: () => clock, newId: () => `id${++n}` });
    store.current("userA0000000001");
    store.append("userA0000000001", [turn("user", 1), turn("ball", 2)]);
    clock = new Date("2026-11-02T11:00:00.000Z");
    const next = store.startNew("userA0000000001", { model: "stub" });
    expect(next).toMatchObject({ id: "id2", startedAt: "2026-11-02T11:00:00.000Z", turns: [] });
    const archived = path.join(
      dir,
      "sittings",
      "userA0000000001",
      archiveName("2026-11-02T10:00:00.000Z")
    );
    expect(path.basename(archived)).toBe("2026-11-02T10-00-00.000Z.json");
    const old = JSON.parse(fs.readFileSync(archived, "utf8"));
    expect(old.turns).toHaveLength(2);
    expect(old.closedAt).toBe("2026-11-02T11:00:00.000Z");
  });

  it("opens one even when there was none", () => {
    const store = createSittings({ dir: fresh() });
    expect(store.startNew("userA0000000001").turns).toEqual([]);
  });
});

describe("retention", () => {
  it("deletes closed sittings past the retention and never the open one", () => {
    const dir = fresh();
    const now = new Date("2026-11-02T10:00:00.000Z");
    const store = createSittings({ dir, retentionDays: 90, now: () => now });
    store.current("userA0000000001");
    const base = path.join(dir, "sittings", "userA0000000001");
    const old = path.join(base, "2026-07-01T10-00-00.000Z.json");
    const recent = path.join(base, "2026-10-01T10-00-00.000Z.json");
    fs.writeFileSync(old, "{}");
    fs.writeFileSync(recent, "{}");
    const days = d => new Date(now.getTime() - d * 24 * 3600 * 1000);
    fs.utimesSync(old, days(100), days(100));
    fs.utimesSync(recent, days(30), days(30));
    fs.utimesSync(path.join(base, "current.json"), days(200), days(200));
    expect(store.sweep()).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(path.join(base, "current.json"))).toBe(true);
  });

  it("sweeps nothing before the first sitting", () => {
    expect(createSittings({ dir: fresh() }).sweep()).toBe(0);
  });
});

describe("ensureDir", () => {
  it("says once when it cannot narrow a directory's mode, except on Windows", () => {
    const dir = fresh();
    const spy = vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    try {
      const said = [];
      const warn = (m, f) => said.push({ m, f });
      ensureDir(path.join(dir, "a"), { platform: "win32", warn });
      expect(said).toEqual([]);
      ensureDir(path.join(dir, "b"), { platform: "linux", warn });
      ensureDir(path.join(dir, "b"), { platform: "linux", warn });
      expect(said).toHaveLength(1);
      expect(said[0].f.error).toBe("EPERM");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("writeAtomic", () => {
  it("replaces a file whole and leaves no temporary file", () => {
    const dir = fresh();
    const file = path.join(dir, "x.json");
    writeAtomic(file, "one");
    writeAtomic(file, "two");
    expect(fs.readFileSync(file, "utf8")).toBe("two");
    expect(fs.readdirSync(dir)).toEqual(["x.json"]);
  });
});
