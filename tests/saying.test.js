import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { composeSaying, SAYING_PARTS } from "../scripts/decide/saying.js";

const lists = { stir: ["A stirs.", "B stirs."], sight: ["It sees {name}."], ask: ["Ask."] };

/** A draw that walks the given numbers, then repeats the last. */
const pinned =
  (...n) =>
  () =>
    n.length > 1 ? n.shift() : n[0];

describe("the ball's saying", () => {
  it("says one sentence from each list, in order, naming the asker", () => {
    expect(composeSaying(lists, { name: "Cecil", random: pinned(0.9) })).toBe(
      "B stirs. It sees Cecil. Ask."
    );
  });

  it("never repeats the saying just shown when another can be drawn", () => {
    expect(
      composeSaying(lists, {
        name: "Cecil",
        previous: "A stirs. It sees Cecil. Ask.",
        random: pinned(0, 0, 0, 0.9)
      })
    ).toBe("B stirs. It sees Cecil. Ask.");
  });

  it("gives up rerolling when every draw is the one just shown", () => {
    const one = { stir: ["A."], sight: ["B."], ask: ["C."] };
    expect(composeSaying(one, { previous: "A. B. C." })).toBe("A. B. C.");
  });

  it("is empty when a list is missing or empty", () => {
    expect(composeSaying(undefined)).toBe("");
    expect(composeSaying({ ...lists, ask: [] })).toBe("");
  });

  it("finds every list in lang/en.json, none mentioning the model or the DM", () => {
    const lang = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
    const saying = lang["fvtt-mod-crystalball"]?.saying ?? lang.saying;
    for (const key of SAYING_PARTS) {
      expect(saying[key].length).toBeGreaterThan(3);
      for (const line of saying[key]) expect(line).not.toMatch(/claude|anthropic|\bDM\b|\bGM\b/i);
    }
  });
});
