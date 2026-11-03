/**
 * The ball's standing instructions: the first layer of every gaze, the same bytes for every
 * player at a table, so it caches across the whole party. Each model reads its own harness
 * (`seer/src/harness/`): a Haiku model Haiku's, tuned for how it reads; every other model the
 * general one. The table's rulebooks section and the DM's *Table notes* follow, each in the
 * harness's words. A change to a harness's wording is a new version of that harness
 * (`<name>-<version>`, the gaze's meta; the layer's hash in the usage log shows when it changed).
 */

import { GENERAL } from "./harness/general.js";
import { HAIKU } from "./harness/haiku.js";

/** Every harness, the tuned first. */
export const HARNESSES = Object.freeze([HAIKU, GENERAL]);

/** The harness a model reads: Haiku's for a Haiku model, the general one for any other (and the stub). */
export function harnessFor(model) {
  return /haiku/i.test(String(model ?? "")) ? HAIKU : GENERAL;
}

/** A harness's version as the gaze's meta names it: `haiku-4`. */
export const versionOf = harness => `${harness.name}-${harness.version}`;

/** The heading the DM's notes go under. */
export const NOTES_HEADING = "## The Dungeon Master's notes for this table";

/** The ball's answer when the model declined and said nothing before it did. */
export const REFUSAL_TEXT = "The ball stays clouded on that: the model declined to answer.";

/**
 * The ball's answer when the model returned no words at all (its output spent on thinking, a
 * paused turn): an empty turn would be refused by the API on every later call of the sitting.
 */
export const EMPTY_TEXT = "The ball clouds over and shows nothing.";

/**
 * The instructions layer: the model's harness, its rulebooks section when the table opens any
 * books, then the DM's notes for this table when there are any. The notes are the DM's own words
 * and do carry instructions: the ball's manner, what to decline, house facts. They win over the
 * harness on manner, never on stating an invented fact as true.
 * @param {string} [tableNotes]
 * @param {{ books?: string[], model?: string }} [options]  `model`: the configured model id
 */
export function instructionsLayer(tableNotes = "", { books = [], model } = {}) {
  const harness = harnessFor(model);
  const notes = String(tableNotes ?? "").trim();
  const base = books.length
    ? `${harness.standing}\n\n${harness.rulebooks(books)}`
    : harness.standing;
  if (!notes) return base;
  return `${base}\n\n${NOTES_HEADING}\n\n${harness.notesPreamble}\n\n${notes}`;
}
