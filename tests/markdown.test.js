import { describe, expect, it } from "vitest";
import { escapeHtml, renderMarkdown } from "../scripts/decide/markdown.js";

/** Every tag name in a piece of HTML, opening and closing alike. */
const tagsOf = html => [...html.matchAll(/<\/?([a-z0-9]+)/gi)].map(m => m[1].toLowerCase());
const ALLOWED = new Set(["p", "strong", "em", "code", "h3", "h4", "h5", "ul", "ol", "li", "br"]);

/** True when every tag opened is closed in order (br stands alone). */
function balanced(html) {
  const stack = [];
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)>/g)) {
    if (m[2] === "br") continue;
    if (!m[1]) stack.push(m[2]);
    else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0;
}

describe("escaping", () => {
  it("escapes the five characters HTML cares about", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;"
    );
  });
});

describe("the ball's Markdown", () => {
  it("draws paragraphs, keeping a single newline as a break", () => {
    expect(renderMarkdown("One line\nthe next\n\nA second paragraph.")).toBe(
      "<p>One line<br>the next</p><p>A second paragraph.</p>"
    );
  });

  it("draws bold, italic, both, and inline code", () => {
    expect(renderMarkdown("**bold** and *italic* and ***both*** and `code`")).toBe(
      "<p><strong>bold</strong> and <em>italic</em> and <strong><em>both</em></strong> and <code>code</code></p>"
    );
    expect(renderMarkdown("__bold__ and _italic_")).toBe(
      "<p><strong>bold</strong> and <em>italic</em></p>"
    );
  });

  it("nests emphasis either way, always balanced", () => {
    expect(renderMarkdown("**a *b* c**")).toBe("<p><strong>a <em>b</em> c</strong></p>");
    expect(renderMarkdown("*a **b** c*")).toBe("<p><em>a <strong>b</strong> c</em></p>");
    for (const s of [
      "***a* b**",
      "**a *b** c*",
      "*a **b* c**",
      "**",
      "* a *",
      "a * b * c",
      "**x**y**z**",
      "*a*b*c*",
      "**a _b** c_",
      "_**_**",
      "__a *b__ c*",
      "_a **b_ c**",
      "*a __b* c__",
      "__**x**__ and _*y*_"
    ]) {
      const html = renderMarkdown(s);
      expect(balanced(html), `${s} → ${html}`).toBe(true);
    }
  });

  it("never lets an underscore span cross a star one", () => {
    expect(renderMarkdown("**a _b** c_")).toBe("<p><strong>a _b</strong> c_</p>");
    expect(renderMarkdown("_**_**")).toBe("<p>_<strong>_</strong></p>");
    expect(renderMarkdown("_plain_ and __plain__")).toBe(
      "<p><em>plain</em> and <strong>plain</strong></p>"
    );
  });

  it("leaves underscores inside words and lone asterisks alone", () => {
    expect(renderMarkdown("snake_case_name and 2 * 3 * 4")).toBe(
      "<p>snake_case_name and 2 * 3 * 4</p>"
    );
  });

  it("keeps marks inside code as text", () => {
    expect(renderMarkdown("`**not bold**` and `<b>`")).toBe(
      "<p><code>**not bold**</code> and <code>&lt;b&gt;</code></p>"
    );
  });

  it("draws #, ## and ### as h3, h4 and h5, deeper ones as h5, closing hashes dropped", () => {
    expect(renderMarkdown("# One\n## Two\n### Three\n#### Four ##")).toBe(
      "<h3>One</h3><h4>Two</h4><h5>Three</h5><h5>Four</h5>"
    );
    expect(renderMarkdown("# C#")).toBe("<h3>C#</h3>");
    expect(renderMarkdown("#hashtag")).toBe("<p>#hashtag</p>");
  });

  it("draws bullet and numbered lists, right after a paragraph too", () => {
    expect(renderMarkdown("We know:\n- the lamp\n* the year 1391\n\n1. first\n2. second")).toBe(
      "<p>We know:</p><ul><li>the lamp</li><li>the year 1391</li></ul><ol><li>first</li><li>second</li></ol>"
    );
  });

  it("keeps one list across blank lines between its items, and an indented line on its item", () => {
    expect(renderMarkdown("1. one\n\n2. two\n   more of two\n\nAfter.")).toBe(
      "<ol><li>one</li><li>two<br>more of two</li></ol><p>After.</p>"
    );
  });

  it("draws emphasis inside headings and list items", () => {
    expect(renderMarkdown("## The **Lamp**\n- *found* in the attic")).toBe(
      "<h4>The <strong>Lamp</strong></h4><ul><li><em>found</em> in the attic</li></ul>"
    );
  });

  it("draws a link as its text and an image as its alt text", () => {
    expect(
      renderMarkdown('See [the map](https://example.com/x "t") and ![a lamp](lamp.png).')
    ).toBe("<p>See the map and a lamp.</p>");
    expect(renderMarkdown("[javascript](javascript:alert(1))")).not.toMatch(/javascript:/);
  });

  it("never passes raw HTML, attributes or handlers", () => {
    const evil = [
      "<script>alert(1)</script>",
      '<img src=x onerror="alert(1)">',
      "**<b onmouseover=alert(1)>x</b>**",
      "[<svg onload=alert(1)>](http://x)",
      "![<iframe src=//x>](y)",
      "# <h1>big</h1>",
      "- <a href='javascript:x'>a</a>",
      "`</code><script>`",
      "```\n<style>body{}</style>\n```"
    ];
    for (const s of evil) {
      const html = renderMarkdown(s);
      expect(
        tagsOf(html).every(t => ALLOWED.has(t)),
        `${s} → ${html}`
      ).toBe(true);
      expect(html).not.toMatch(/<[a-z0-9]+\s/i);
      expect(balanced(html), `${s} → ${html}`).toBe(true);
    }
  });

  it("draws a fenced block as code lines and a rule as nothing", () => {
    expect(renderMarkdown("```js\nlet a = 1;\nlet b = 2;\n```\n---\nAfter")).toBe(
      "<p><code>let a = 1;<br>let b = 2;</code></p><p>After</p>"
    );
  });

  it("drops a quote's marker", () => {
    expect(renderMarkdown("> a remembered line")).toBe("<p>a remembered line</p>");
  });

  it("takes CRLF text and draws nothing for nothing", () => {
    expect(renderMarkdown("a\r\nb\r\n\r\nc")).toBe("<p>a<br>b</p><p>c</p>");
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown(null)).toBe("");
  });

  it("draws the stub's answer as one paragraph with its quote intact", () => {
    const stub =
      'The Crystal Ball is clouded (stub). I see 12 shared pages, 31 clues, 4 party members\nand your character Kartor Bloodaxe (Fighter 5). You asked: "What do we know about the Lamp of 1391?".';
    expect(renderMarkdown(stub)).toBe(
      "<p>The Crystal Ball is clouded (stub). I see 12 shared pages, 31 clues, 4 party members<br>and your character Kartor Bloodaxe (Fighter 5). You asked: &quot;What do we know about the Lamp of 1391?&quot;.</p>"
    );
  });
});
