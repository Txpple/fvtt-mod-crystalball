import { afterEach, describe, expect, it } from "vitest";
import { format, setJournal } from "../src/log.js";

afterEach(() => setJournal(false));

describe("a log line", () => {
  const at = new Date("2026-11-02T10:00:00.000Z");

  it("is the time, the level, the message and the fields as JSON", () => {
    setJournal(false);
    expect(format("info", "seer: listening", { port: 1 }, at)).toBe(
      '2026-11-02T10:00:00.000Z INFO seer: listening {"port":1}'
    );
    expect(format("warn", "no fields", undefined, at)).toBe(
      "2026-11-02T10:00:00.000Z WARN no fields"
    );
  });

  it("opens with its syslog priority when stderr is the journal", () => {
    setJournal(true);
    expect(["error", "warn", "info", "debug"].map(l => format(l, "m", {}, at).slice(0, 3))).toEqual(
      ["<3>", "<4>", "<6>", "<7>"]
    );
  });
});
