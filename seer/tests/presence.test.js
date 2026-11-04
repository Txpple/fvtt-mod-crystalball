import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createPresence, presenceFile } from "../src/presence.js";
import { quietLog, tempDir } from "./helpers.js";

const t = minute => new Date(Date.UTC(2026, 10, 4, 19, minute));
const USERS = [
  { _id: "playerAda0000001", name: "Ada" },
  { _id: "playerBen0000001", name: "Ben" }
];

function recorder() {
  const lines = [];
  const log = quietLog();
  const p = createPresence({ append: l => lines.push(l), log, now: () => t(0) });
  p.names(USERS);
  return { p, lines, log };
}

describe("the presence record", () => {
  it("opens with who is already on, then follows Foundry's joins and leaves", () => {
    const { p, lines } = recorder();
    p.seen(["playerAda0000001"], t(0));
    p.live("playerBen0000001", { active: true }, t(5));
    p.live("playerAda0000001", { active: false }, t(30));
    expect(lines).toEqual([
      { at: t(0).toISOString(), event: "watching" },
      {
        at: t(0).toISOString(),
        event: "join",
        userId: "playerAda0000001",
        userName: "Ada",
        how: "already"
      },
      {
        at: t(5).toISOString(),
        event: "join",
        userId: "playerBen0000001",
        userName: "Ben",
        how: "live"
      },
      {
        at: t(30).toISOString(),
        event: "leave",
        userId: "playerAda0000001",
        userName: "Ada",
        how: "live",
        since: t(0).toISOString(),
        minutes: 30
      }
    ]);
  });

  it("ignores a player's own activity and anything before the first presence ask", () => {
    const { p, lines } = recorder();
    p.live("playerAda0000001", { active: true }, t(1));
    expect(lines).toEqual([]);
    p.seen(["playerAda0000001"], t(2));
    p.live("playerAda0000001", { cursor: { x: 1, y: 2 } }, t(3));
    p.live("playerAda0000001", { active: true, idle: true }, t(4));
    expect(lines.map(l => l.event)).toEqual(["watching", "join"]);
  });

  it("catches what the broadcast missed at the next presence ask", () => {
    const { p, lines } = recorder();
    p.seen(["playerAda0000001"], t(0));
    p.seen(["playerBen0000001"], t(1));
    expect(lines.slice(1).map(l => [l.event, l.userName, l.how])).toEqual([
      ["join", "Ada", "already"],
      ["leave", "Ada", "probe"],
      ["join", "Ben", "probe"]
    ]);
  });

  it("closes every stint when the Seer loses sight, and reopens them as already on", () => {
    const { p, lines } = recorder();
    p.seen(["playerAda0000001", "playerBen0000001"], t(0));
    p.lost("world shutdown", t(10));
    p.lost("disconnected: transport close", t(11));
    p.seen(["playerBen0000001"], t(12));
    p.lost("disconnected: transport close", t(20));
    expect(lines.map(l => [l.event, l.userName ?? l.reason ?? null, l.how ?? null])).toEqual([
      ["watching", null, null],
      ["join", "Ada", "already"],
      ["join", "Ben", "already"],
      ["leave", "Ada", "world-shutdown"],
      ["leave", "Ben", "world-shutdown"],
      ["lost", "world shutdown", null],
      ["watching", null, null],
      ["join", "Ben", "already"],
      ["leave", "Ben", "seer-lost"],
      ["lost", "disconnected: transport close", null]
    ]);
  });

  it("names an unknown user null and says which ids it lacks names for", () => {
    const { p, lines } = recorder();
    expect(p.unknown(["playerAda0000001", "newcomer00000001"])).toEqual(["newcomer00000001"]);
    p.seen(["newcomer00000001"], t(0));
    expect(lines[1]).toMatchObject({ userId: "newcomer00000001", userName: null });
  });

  it("logs a line it cannot write and carries on", () => {
    const log = quietLog();
    const p = createPresence({
      append: () => {
        throw new Error("disk full");
      },
      log
    });
    expect(() => p.seen(["playerAda0000001"])).not.toThrow();
    expect(log.lines.some(l => /could not be written/.test(l.message))).toBe(true);
  });
});

describe("the presence file", () => {
  const dirs = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("appends one JSON line per event", () => {
    const dir = tempDir("presence");
    dirs.push(dir);
    const file = presenceFile(dir);
    file.append({ a: 1 });
    file.append({ b: 2 });
    expect(fs.readFileSync(file.file, "utf8")).toBe('{"a":1}\n{"b":2}\n');
  });
});
