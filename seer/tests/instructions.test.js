import { describe, expect, it } from "vitest";
import { buildGaze } from "../src/gaze.js";
import { GENERAL } from "../src/harness/general.js";
import { HAIKU } from "../src/harness/haiku.js";
import {
  HARNESSES,
  harnessFor,
  instructionsLayer,
  NOTES_HEADING,
  versionOf
} from "../src/instructions.js";
import { TOOL_READ, TOOL_SEARCH } from "../src/rulebooks.js";
import { moduleSettings } from "../src/settings.js";
import { world } from "./helpers.js";

const ADA = "playerAda0000001";

describe("the harness a model reads", () => {
  it("is Haiku's for a Haiku model and the general one for every other", () => {
    expect(harnessFor("claude-haiku-5-5")).toBe(HAIKU);
    expect(harnessFor("claude-haiku-4-5")).toBe(HAIKU);
    for (const model of ["claude-sonnet-5-5", "claude-opus-5-5", "stub", "", undefined, null])
      expect(harnessFor(model)).toBe(GENERAL);
  });

  it("carries its own version", () => {
    expect(versionOf(HAIKU)).toBe("haiku-4");
    expect(versionOf(GENERAL)).toBe("general-4");
    expect(HARNESSES.map(h => h.name)).toEqual(["haiku", "general"]);
  });

  it("names the gaze's version in its meta", () => {
    const w = world();
    const gaze = model => buildGaze(w, ADA, moduleSettings(w), { model });
    expect(gaze("claude-haiku-5-5").meta.instructionsVersion).toBe("haiku-4");
    expect(gaze("claude-sonnet-5-5").meta.instructionsVersion).toBe("general-4");
    expect(gaze("claude-haiku-5-5").layers[0].text.startsWith(HAIKU.standing)).toBe(true);
    expect(gaze(undefined).layers[0].text.startsWith(GENERAL.standing)).toBe(true);
  });
});

describe("the instructions layer", () => {
  for (const harness of HARNESSES) {
    const model = harness === HAIKU ? "claude-haiku-5-5" : "claude-opus-5-5";

    it(`${harness.name}: the standing text, then the rulebooks, then the DM's notes in the harness's words`, () => {
      expect(instructionsLayer("", { model })).toBe(harness.standing);
      expect(instructionsLayer("  ", { model, books: [] })).toBe(harness.standing);
      const t = instructionsLayer(" Speak like an old sage. ", {
        model,
        books: ["Book One", "Book Two"]
      });
      expect(t).toBe(
        `${harness.standing}\n\n${harness.rulebooks(["Book One", "Book Two"])}\n\n${NOTES_HEADING}\n\n${harness.notesPreamble}\n\nSpeak like an old sage.`
      );
    });

    it(`${harness.name}: the rulebooks section names the books and both tools`, () => {
      const section = harness.rulebooks(["Book One", "Book Two"]);
      expect(section.startsWith("## The table's rulebooks")).toBe(true);
      expect(section).toContain("this table plays from: Book One; Book Two.");
      expect(section).toContain(TOOL_SEARCH);
      expect(section).toContain(TOOL_READ);
    });

    it(`${harness.name}: the DM's notes win on manner, never on an invented fact`, () => {
      expect(harness.notesPreamble).toContain("the notes win");
      expect(harness.notesPreamble).toContain("They never let you state an invented fact as true.");
    });

    it(`${harness.name}: none of the lines that fought each other is left`, () => {
      const t = `${harness.standing}\n${harness.rulebooks(["B"])}`;
      for (const gone of [
        "never guess",
        "Be short",
        "when they would help or when the player asks",
        "is a guess, and you say so",
        "not an oracle of the plot"
      ])
        expect(t).not.toContain(gone);
    });

    it(`${harness.name}: the party's intuition is named by the labels the gaze gives it`, () => {
      const w = world();
      const party = buildGaze(w, ADA, moduleSettings(w)).layers.find(l => l.name === "party").text;
      for (const label of ["The party's note:", "Where the party stands:"]) {
        expect(party).toContain(label);
        expect(harness.standing).toContain(`"${label}"`);
      }
      expect(harness.standing).toContain('"(the party\'s intuition)"');
    });
  }

  it("Haiku's: glimpses in every story answer, shown in an example, and a recipe for a gap", () => {
    expect(HAIKU.standing).toContain("under a bold **Glimpses** line");
    expect(HAIKU.standing).toContain("Do this in every answer about the story");
    expect(HAIKU.standing).toMatch(/<example>\n[\s\S]*\*\*Glimpses\*\*[\s\S]*\n<\/example>/);
    expect(HAIKU.standing).toContain("Nothing the party has written down says who hired them.");
    expect(HAIKU.standing).toContain("## Questions about the rules and the character's options");
    expect(HAIKU.rulebooks(["B"])).toContain("even when you feel sure");
  });
});
