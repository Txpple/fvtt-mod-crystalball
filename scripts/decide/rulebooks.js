// @ts-check
/**
 * The rulebooks settings' defaults and the window's line while the ball looks something up. The
 * Seer keeps the same defaults in seer/src/settings.js (it reads a setting the world never saved
 * as its default); a Seer test holds the two equal. Pure.
 */

/**
 * The player-facing packs of the 2024 Player's Handbook, Arcana Unleashed and Heroes of Faerûn:
 * journal and item packs only, never a bestiary, an adventure, a scene or a table. A pack the
 * world does not have is skipped.
 */
export const DEFAULT_RULEBOOKS = [
  "dnd-players-handbook.content",
  "dnd-players-handbook.classes",
  "dnd-players-handbook.origins",
  "dnd-players-handbook.feats",
  "dnd-players-handbook.spells",
  "dnd-players-handbook.equipment",
  "dnd-arcana-unleashed.book",
  "dnd-arcana-unleashed.subclasses",
  "dnd-arcana-unleashed.backgrounds",
  "dnd-arcana-unleashed.feats",
  "dnd-arcana-unleashed.spells",
  "dnd-arcana-unleashed.bastions",
  "dnd-heroes-faerun.book",
  "dnd-heroes-faerun.options",
  "dnd-heroes-faerun.items"
].join("\n");

/**
 * What the ball never reads in those books: the Handbook's stat blocks; Arcana Unleashed's
 * worldbuilding (Chapter 3), magic items (Chapter 5), creatures (Chapter 6) and adventure (the
 * Appendix), each scoped to that book because the Handbook has a Chapter 3, 5 and 6 of its own; the
 * credits and change logs.
 */
export const DEFAULT_LEAVE_OUT = [
  "Appendix B: Creature Stat Blocks",
  "dnd-arcana-unleashed: Chapter 3",
  "dnd-arcana-unleashed: Chapter 3: Creating Magical Worlds",
  "dnd-arcana-unleashed: Chapter 5",
  "dnd-arcana-unleashed: Chapter 5: Magic Items",
  "dnd-arcana-unleashed: Chapter 6",
  "dnd-arcana-unleashed: Chapter 6: Magical Creatures",
  "dnd-arcana-unleashed: Appendix",
  "Credits",
  "Foundry Conversion Credits",
  "Changelog",
  "Player's Handbook Changelog",
  "Heroes of Faerûn Change Log"
].join("\n");

/**
 * The window's line for a `lookup` event: the lang key and its data, or null for one it cannot word.
 * @param {unknown} data  the event's data, `{ action: "search" }` or `{ action: "read", name, book }`
 * @returns {{ key: string, data: Record<string, string> } | null}
 */
export function lookupLine(data) {
  const d = /** @type {{ action?: unknown, name?: unknown, book?: unknown }} */ (data ?? {});
  if (d.action === "search") return { key: "lookup.search", data: {} };
  if (d.action === "read" && typeof d.name === "string" && d.name) {
    const book = typeof d.book === "string" && d.book ? d.book : "";
    return book
      ? { key: "lookup.read", data: { name: d.name, book } }
      : { key: "lookup.readAny", data: { name: d.name } };
  }
  return null;
}
