import { describe, expect, it } from "vitest";
import { questionsIn, sittingFileName, sittingMarkdown } from "../scripts/decide/sitting.js";

describe("the sitting's export", () => {
  it("names the file for the asker and the day, as the family's exports are named", () => {
    expect(sittingFileName("Kartor Ironfist", "2026-11-03")).toBe(
      "crystalball-kartor-ironfist-2026-11-03.md"
    );
    expect(sittingFileName("Élodie d'Arc", "2026-11-03T10:00:00")).toBe(
      "crystalball-elodie-d-arc-2026-11-03.md"
    );
    expect(sittingFileName("", "2026-11-03")).toBe("crystalball-sitting-2026-11-03.md");
  });

  it("counts the player's questions", () => {
    expect(questionsIn([{ role: "user" }, { role: "ball" }, { role: "user" }])).toBe(2);
    expect(questionsIn([])).toBe(0);
  });

  it("writes each turn under its speaker, the ball's Markdown as it came", () => {
    const md = sittingMarkdown({
      title: "The Crystal Ball: Kartor",
      world: "Echoes",
      saved: "3 Nov 2026",
      you: "Kartor",
      ball: "The Crystal Ball",
      turns: [
        { role: "user", text: "Who hired us?\nAnd why?" },
        { role: "ball", text: "Nothing says so.\n\n**Hunches**\n- My hunch: the guild." }
      ]
    });
    expect(md).toBe(
      "# The Crystal Ball: Kartor\n\nEchoes · 3 Nov 2026\n\n" +
        "## Kartor\n\nWho hired us?\nAnd why?\n\n" +
        "## The Crystal Ball\n\nNothing says so.\n\n**Hunches**\n- My hunch: the guild.\n"
    );
  });

  it("leaves out an answer still being written and keeps a cut one's line", () => {
    const md = sittingMarkdown({
      title: "T",
      saved: "now",
      you: "Ada",
      ball: "Ball",
      turns: [
        { role: "user", text: "One" },
        { role: "ball", text: "Half an", error: "The answer was cut off before it finished." },
        { role: "user", text: "Two" },
        { role: "ball", text: "", pending: true }
      ]
    });
    expect(md).toContain("## Ball\n\nHalf an\n\n*The answer was cut off before it finished.*");
    expect(md.trimEnd().endsWith("## Ada\n\nTwo")).toBe(true);
    expect(md.startsWith("# T\n\nnow\n\n")).toBe(true);
  });
});
