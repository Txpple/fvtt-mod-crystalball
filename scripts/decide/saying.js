// @ts-check
/**
 * The ball's first words over an empty sitting: a saying put together fresh each time a sitting
 * starts, one sentence from each of lang/en.json's `saying` lists (the ball stirring, what it
 * sees, the bidding to ask). A fragment may name the asker as `{name}`. No model call: it is
 * drawn here, at once and for nothing.
 */

/** The lists, in the order the sentences are said. */
export const SAYING_PARTS = ["stir", "sight", "ask"];

/**
 * A saying from the lists, never the one said last when another can be drawn.
 * `random` is Math.random's shape, so a test can pin the draw.
 */
export function composeSaying(lists, { name = "", previous = "", random = Math.random } = {}) {
  const parts = SAYING_PARTS.map(key => (Array.isArray(lists?.[key]) ? lists[key].filter(Boolean) : []));
  if (parts.some(list => !list.length)) return "";
  const draw = () =>
    parts
      .map(list => list[Math.floor(random() * list.length)])
      .join(" ")
      .replaceAll("{name}", name);
  let saying = draw();
  for (let tries = 0; saying === previous && tries < 8; tries++) saying = draw();
  return saying;
}
