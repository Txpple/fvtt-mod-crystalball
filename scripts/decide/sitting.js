// @ts-check
/**
 * A sitting as a Markdown file, for the window's Export: the family's export (Clue Board's and
 * Card Catalogue's), a file the browser saves, named `crystalball-<asker>-<date>.md`. The player's
 * words and the ball's go in as they were written; the ball already writes Markdown, so its answer
 * is kept as it is. Nothing is written to the world or the Seer.
 */

/**
 * The file's name: the asker slugged as Card Catalogue's `exportName` slugs a heading, and the day.
 * @param {string} asker
 * @param {string} day  `YYYY-MM-DD`, the local day
 */
export function sittingFileName(asker, day) {
  const slug = String(asker ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `crystalball-${slug || "sitting"}-${String(day).slice(0, 10)}.md`;
}

/**
 * The questions a sitting holds: its player turns.
 * @param {Array<{ role: string }>} turns
 */
export const questionsIn = turns => turns.filter(turn => turn?.role === "user").length;

/**
 * The sitting as Markdown: a title, the world and when it was saved, then each turn under its
 * speaker's name. A turn still being written is left out; a cut or failed answer keeps what came
 * and the window's line about it, in italics.
 * @param {{ title: string, world?: string, saved: string, you: string, ball: string,
 *   turns: Array<{ role: string, text?: string, error?: string, note?: string, pending?: boolean }> }} sitting
 */
export function sittingMarkdown({ title, world = "", saved, you, ball, turns }) {
  const head = [`# ${title}`, "", [world, saved].filter(Boolean).join(" · ")];
  const body = turns
    .filter(turn => !turn.pending && (turn.role === "user" || turn.role === "ball"))
    .map(turn => {
      const lines = [`## ${turn.role === "user" ? you : ball}`, ""];
      const text = String(turn.text ?? "").trim();
      if (text) lines.push(text);
      for (const extra of [turn.note, turn.error]) if (extra) lines.push("", `*${extra}*`);
      return lines.join("\n");
    });
  return `${[head.join("\n"), ...body].join("\n\n")}\n`;
}
