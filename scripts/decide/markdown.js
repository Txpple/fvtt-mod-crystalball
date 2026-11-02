// @ts-check
/**
 * What the ball says, drawn safely. The model's text is never trusted as HTML and never enriched:
 * the whole text is HTML-escaped first, then a small Markdown subset is drawn over the escaped
 * text. The only tags that can come out are the ones this file writes (p, strong, em, code, h3,
 * h4, h5, ul, ol, li, br), always without attributes, so no raw HTML, link, image or handler ever
 * reaches the window. Pure: no Foundry, no DOM.
 *
 * Blocks: paragraphs (blank-line separated, single newlines kept as <br>), headings `#` to `###`
 * (drawn h3 to h5, deeper ones h5), bullet lists (`- ` or `* `), numbered lists (`1. `), a fenced
 * block as code lines. Inline: `code`, **bold**, *italic* (and the underscore forms at word
 * edges); a link draws its text only, an image its alt text.
 */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/**
 * @param {string} text
 * @returns {string}
 */
export const escapeHtml = text => text.replace(/[&<>"']/g, c => ESCAPES[/** @type {keyof ESCAPES} */ (c)]);

// Placeholders for code spans: a character the escaped text can never hold (it is stripped first).
const MARK = "\u0000";

/**
 * Emphasis over escaped text, the `*` forms first. A `*` pattern wraps a span holding no `*`, and
 * every earlier tag was written with its delimiters outside it, so a span holds whole elements or
 * none. The `_` forms come last and refuse a span holding any tag, so they never cross a `*` one
 * (`**a _b** c_` stays partly literal). Together: every tag written closes in order. Italic runs
 * again after bold so `*a **b** c*` nests.
 */
const EMPHASIS = [
  [/\*\*\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*\*\*/g, "<strong><em>$1</em></strong>"],
  [/(?<!\*)\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*(?!\*)/g, "<em>$1</em>"],
  [/\*\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*\*/g, "<strong>$1</strong>"],
  [/(?<!\*)\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*(?!\*)/g, "<em>$1</em>"],
  [/(?<![\w_])__(?=[^\s_<])([^_<]+?)(?<=[^\s_])__(?![\w_])/g, "<strong>$1</strong>"],
  [/(?<![\w_])_(?=[^\s_<])([^_<]+?)(?<=[^\s_])_(?![\w_])/g, "<em>$1</em>"]
];

/**
 * One line (or a heading's text) of escaped text, its inline marks drawn.
 * @param {string} escaped
 * @returns {string}
 */
function inline(escaped) {
  /** @type {string[]} */
  const codes = [];
  let s = escaped.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(`<code>${code}</code>`);
    return `${MARK}${codes.length - 1}${MARK}`;
  });
  // An image keeps its alt text, a link its text; the address is dropped either way.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  for (const [pattern, replacement] of EMPHASIS) s = s.replace(/** @type {RegExp} */ (pattern), /** @type {string} */ (replacement));
  return s.replace(new RegExp(`${MARK}(\\d+)${MARK}`, "g"), (_m, i) => codes[Number(i)] ?? "");
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,9}[.)]\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const QUOTE = /^\s{0,3}&gt;\s?/;

/**
 * The model's text as safe HTML.
 * @param {string} text
 * @returns {string}
 */
export function renderMarkdown(text) {
  if (typeof text !== "string" || !text) return "";
  const lines = escapeHtml(text.replaceAll(MARK, "")).replace(/\r\n?/g, "\n").split("\n");

  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  let para = [];
  /** @type {{ tag: "ul" | "ol", items: string[] } | null} */
  let list = null;
  /** A blank line inside a list: the list goes on only if an item of its kind comes next. */
  let gap = false;
  /** @type {string[] | null} */
  let fence = null;

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map(i => `<li>${i}</li>`).join("")}</${list.tag}>`);
    list = null;
    gap = false;
  };
  const flush = () => {
    flushPara();
    flushList();
  };

  for (const line of lines) {
    if (fence) {
      if (FENCE.test(line)) {
        if (fence.length) out.push(`<p><code>${fence.join("<br>")}</code></p>`);
        fence = null;
      } else fence.push(line);
      continue;
    }
    if (FENCE.test(line)) {
      flush();
      fence = [];
      continue;
    }
    if (!line.trim()) {
      flushPara();
      if (list) gap = true;
      continue;
    }
    if (RULE.test(line)) {
      flush();
      continue;
    }
    const bullet = BULLET.exec(line);
    const item = bullet ?? NUMBERED.exec(line);
    if (item) {
      const tag = bullet ? "ul" : "ol";
      flushPara();
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push(inline(item[1]));
      gap = false;
      continue;
    }
    if (list && !gap && /^\s/.test(line)) {
      // An indented line under an item carries on that item.
      list.items[list.items.length - 1] += `<br>${inline(line.trim())}`;
      continue;
    }
    flushList();
    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      const level = Math.min(heading[1].length, 3) + 2;
      if (heading[2]) out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    para.push(line.replace(QUOTE, "").trim());
  }
  if (fence?.length) out.push(`<p><code>${fence.join("<br>")}</code></p>`);
  flush();
  return out.join("");
}
