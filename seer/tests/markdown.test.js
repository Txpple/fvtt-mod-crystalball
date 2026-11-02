import { describe, expect, it } from "vitest";
import { enrichToText, htmlToMarkdown, uuidNamer } from "../src/markdown.js";
import { world } from "./helpers.js";

describe("@UUID links", () => {
  const nameOf = uuidNamer(world());

  it("turns a labelled link into its label", () => {
    expect(enrichToText("see @UUID[Actor.npcSmith0000001]{the smith}", nameOf)).toBe(
      "see the smith"
    );
    expect(enrichToText("@UUID[Compendium.dnd5e.rules.JournalEntry.abc]{rules}", nameOf)).toBe(
      "rules"
    );
  });

  it("names an unlabelled link to a document the payload holds", () => {
    expect(enrichToText("@UUID[Actor.npcSmith0000001]", nameOf)).toBe("Oren the Smith");
    expect(
      enrichToText("@UUID[JournalEntry.jrnDiary00000001.JournalEntryPage.pgSession1000001]", nameOf)
    ).toBe("Session 1");
    expect(enrichToText("@UUID[Actor.charAda000000001.Item.wpnSword00000001]", nameOf)).toBe(
      "Longsword"
    );
    expect(enrichToText("@UUID[Actor.npcSmith0000001#anchor]", nameOf)).toBe("Oren the Smith");
  });

  it("drops an unlabelled link it cannot resolve", () => {
    expect(enrichToText("a @UUID[Compendium.dnd5e.rules.JournalEntry.abc] b", nameOf)).toBe("a  b");
    expect(enrichToText("a @UUID[Actor.nobody000000000] b", nameOf)).toBe("a  b");
    expect(enrichToText("a @UUID[Actor.npcSmith0000001.Nope.x] b", nameOf)).toBe("a  b");
  });

  it("handles the older link forms", () => {
    expect(enrichToText("@Actor[npcSmith0000001]", nameOf)).toBe("Oren the Smith");
    expect(enrichToText("@Compendium[dnd5e.items.abc]{Rope}", nameOf)).toBe("Rope");
    expect(enrichToText("@Compendium[dnd5e.items.abc]", nameOf)).toBe("");
  });
});

describe("the other enrichers", () => {
  it("writes roll commands as the words a page shows", () => {
    expect(enrichToText("[[/check ability=cha skill=itm]]")).toBe("Charisma (Intimidation) check");
    expect(enrichToText("[[/save dex dc=14]]")).toBe("DC 14 Dexterity saving throw");
    expect(enrichToText("[[/skill ste]]")).toBe("Stealth check");
    expect(enrichToText("[[/damage 2d6 fire average]]")).toBe("2d6 fire");
    expect(enrichToText("[[/damage formula=1d8 type=radiant]]")).toBe("1d8 radiant");
    expect(enrichToText("[[/r 1d20 + 3 #to hit]]")).toBe("1d20 + 3");
    expect(enrichToText("[[/check dex]]{a Dexterity check}")).toBe("a Dexterity check");
  });

  it("writes inline rolls as their formula and drops lookups", () => {
    expect(enrichToText("[[2d4 + 2]]")).toBe("2d4 + 2");
    expect(enrichToText("Max: [[lookup @scale.warlock.invocations-known]]")).toBe("Max: ");
  });

  it("names references, encoded or not, and drops embeds", () => {
    expect(enrichToText("&amp;Reference[Charmed apply=false] or &Reference[frightened]")).toBe(
      "Charmed or Frightened"
    );
    expect(enrichToText("&Reference[condition=prone]{Prone}")).toBe("Prone");
    expect(enrichToText("x @Embed[JournalEntry.abc inline] y")).toBe("x  y");
  });

  it("names a reference of several words whole", () => {
    expect(
      enrichToText(
        "behind &amp;Reference[Total Cover] and &Reference[Heavily Obscured apply=false]"
      )
    ).toBe("behind Total Cover and Heavily Obscured");
  });

  it("places an embed's own HTML when a resolver gives it, two levels deep, and drops the rest", () => {
    const pages = {
      "Compendium.a.b.JournalEntry.e.JournalEntryPage.p1":
        "<p>One @Embed[Compendium.a.b.JournalEntry.e.JournalEntryPage.p2 inline]</p>",
      "Compendium.a.b.JournalEntry.e.JournalEntryPage.p2":
        "two &Reference[Prone] @Embed[Compendium.a.b.JournalEntry.e.JournalEntryPage.p3]",
      "Compendium.a.b.JournalEntry.e.JournalEntryPage.p3": "three"
    };
    const embed = uuid => pages[uuid] ?? null;
    expect(
      htmlToMarkdown("<p>@Embed[Compendium.a.b.JournalEntry.e.JournalEntryPage.p1 inline]</p>", {
        embed
      })
    ).toBe("One two Prone");
    expect(htmlToMarkdown("<p>a @Embed[Compendium.x.y.Actor.z statblock] b</p>", { embed })).toBe(
      "a b"
    );
  });
});

describe("htmlToMarkdown", () => {
  it("writes ATX headings, dash bullets and numbered lists", () => {
    const md = htmlToMarkdown(
      "<h2>Title</h2><ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>"
    );
    expect(md).toBe("## Title\n\n- one\n- two\n\n1. first\n2. second");
  });

  it("pushes a page's headings below the gaze's", () => {
    expect(htmlToMarkdown("<h1>Top</h1>", { headingOffset: 3 })).toBe("#### Top");
    expect(htmlToMarkdown("<h5>Deep</h5>", { headingOffset: 3 })).toBe("###### Deep");
  });

  it("writes an image as its alt text and a link as its words", () => {
    expect(htmlToMarkdown('<p><img src="x.webp" alt="A  broken well"></p>')).toBe(
      "(picture: A broken well)"
    );
    expect(htmlToMarkdown('<p><img src="x.webp"></p>')).toBe("");
    expect(htmlToMarkdown('<p>Go <a href="https://example.test/x">there</a>.</p>')).toBe(
      "Go there."
    );
  });

  it("drops scripts and styles", () => {
    expect(htmlToMarkdown("<p>a</p><script>alert(1)</script><style>p{}</style><p>b</p>")).toBe(
      "a\n\nb"
    );
  });

  it("drops secret blocks unless the reader owns the page", () => {
    const html = '<p>open</p><section class="secret" id="s1"><p>hidden</p></section>';
    expect(htmlToMarkdown(html)).toBe("open");
    expect(htmlToMarkdown(html, { secrets: true })).toBe("open\n\nhidden");
  });

  it("writes a table as pipe rows", () => {
    const md = htmlToMarkdown(
      "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2 | 3</td></tr></table>"
    );
    expect(md).toBe("| A | B |\n| 1 | 2 / 3 |");
  });

  it("leaves no Markdown escapes and no runs of blank lines", () => {
    const md = htmlToMarkdown("<p>1. Not a list * nor _this_</p><p></p><p></p><p>end</p>");
    expect(md).toBe("1. Not a list * nor _this_\n\nend");
  });

  it("is empty for empty input", () => {
    expect(htmlToMarkdown("")).toBe("");
    expect(htmlToMarkdown(null)).toBe("");
  });

  it("resolves links before converting", () => {
    const nameOf = uuidNamer(world());
    expect(htmlToMarkdown("<p>Find @UUID[Actor.npcSmith0000001].</p>", { nameOf })).toBe(
      "Find Oren the Smith."
    );
  });

  it("runs in linear time on unclosed brackets", () => {
    for (const flood of [
      "[[".repeat(50000),
      "@UUID[".repeat(20000),
      "&amp;Reference[".repeat(8000),
      `${"[[/r 1d6 ".repeat(10000)}`,
      `@UUID[x]{${"{".repeat(50000)}`
    ]) {
      const t0 = performance.now();
      htmlToMarkdown(`<p>${flood}</p>`);
      enrichToText(flood);
      expect(performance.now() - t0).toBeLessThan(1000);
    }
  });

  it("still reads an enricher beside the flood", () => {
    expect(enrichToText(`${"[[".repeat(100)} [[/check dex]] @UUID[Actor.x]{the smith}`)).toContain(
      "Dexterity check the smith"
    );
  });
});
