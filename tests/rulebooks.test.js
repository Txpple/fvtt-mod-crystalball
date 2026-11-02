import { describe, expect, it } from "vitest";
import { DEFAULT_LEAVE_OUT, DEFAULT_RULEBOOKS, lookupLine } from "../scripts/decide/rulebooks.js";

describe("the lookup line", () => {
  it("words a search and a read, with or without its book", () => {
    expect(lookupLine({ action: "search", query: "fireball" })).toEqual({
      key: "lookup.search",
      data: {}
    });
    expect(lookupLine({ action: "read", name: "Fireball", book: "Player's Handbook" })).toEqual({
      key: "lookup.read",
      data: { name: "Fireball", book: "Player's Handbook" }
    });
    expect(lookupLine({ action: "read", name: "Fireball" })).toEqual({
      key: "lookup.readAny",
      data: { name: "Fireball" }
    });
  });

  it("is nothing for an event it cannot word", () => {
    expect(lookupLine(null)).toBeNull();
    expect(lookupLine({ action: "read" })).toBeNull();
    expect(lookupLine({ action: "roll" })).toBeNull();
  });
});

describe("the rulebooks settings' defaults", () => {
  it("are one pack id or name a line", () => {
    expect(DEFAULT_RULEBOOKS.split("\n").every(id => /^[a-z0-9-]+\.[a-z0-9-]+$/.test(id))).toBe(
      true
    );
    expect(DEFAULT_LEAVE_OUT.split("\n")).toContain("Appendix B: Creature Stat Blocks");
  });
});
