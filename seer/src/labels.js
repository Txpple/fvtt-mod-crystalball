/**
 * dnd5e's keys as the words a sheet prints. The world payload is raw source data, so the Seer has
 * no localization at hand: these are the English labels dnd5e 6.x shows for its own keys. A key
 * not listed is shown humanised (`humanise`), never dropped.
 */

export const ABILITY_NAMES = Object.freeze({
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma"
});

export const ABILITY_ORDER = Object.freeze(["str", "dex", "con", "int", "wis", "cha"]);

/** Each skill's label and its default ability, in dnd5e's order. */
export const SKILLS = Object.freeze({
  acr: ["Acrobatics", "dex"],
  ani: ["Animal Handling", "wis"],
  arc: ["Arcana", "int"],
  ath: ["Athletics", "str"],
  dec: ["Deception", "cha"],
  his: ["History", "int"],
  ins: ["Insight", "wis"],
  itm: ["Intimidation", "cha"],
  inv: ["Investigation", "int"],
  med: ["Medicine", "wis"],
  nat: ["Nature", "int"],
  prc: ["Perception", "wis"],
  prf: ["Performance", "cha"],
  per: ["Persuasion", "cha"],
  rel: ["Religion", "int"],
  slt: ["Sleight of Hand", "dex"],
  ste: ["Stealth", "dex"],
  sur: ["Survival", "wis"]
});

export const SKILL_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(SKILLS).map(([k, [label]]) => [k, label]))
);

export const SCHOOLS = Object.freeze({
  abj: "Abjuration",
  con: "Conjuration",
  div: "Divination",
  enc: "Enchantment",
  evo: "Evocation",
  ill: "Illusion",
  nec: "Necromancy",
  trs: "Transmutation"
});

export const ARMOR_PROFS = Object.freeze({
  lgt: "light armor",
  med: "medium armor",
  hvy: "heavy armor",
  shl: "shields"
});

export const WEAPON_PROFS = Object.freeze({ sim: "simple weapons", mar: "martial weapons" });

export const WEAPON_PROPERTIES = Object.freeze({
  ada: "adamantine",
  amm: "ammunition",
  fin: "finesse",
  fir: "firearm",
  foc: "focus",
  hvy: "heavy",
  lgt: "light",
  lod: "loading",
  mgc: "magical",
  rch: "reach",
  rel: "reload",
  ret: "returning",
  sil: "silvered",
  spc: "special",
  thr: "thrown",
  two: "two-handed",
  ver: "versatile"
});

export const TOOL_NAMES = Object.freeze({
  alchemist: "Alchemist's Supplies",
  brewer: "Brewer's Supplies",
  calligrapher: "Calligrapher's Supplies",
  card: "Playing Cards",
  carpenter: "Carpenter's Tools",
  cartographer: "Cartographer's Tools",
  chess: "Dragonchess Set",
  cobbler: "Cobbler's Tools",
  cook: "Cook's Utensils",
  dice: "Dice Set",
  disg: "Disguise Kit",
  forg: "Forgery Kit",
  glassblower: "Glassblower's Tools",
  herb: "Herbalism Kit",
  jeweler: "Jeweler's Tools",
  leatherworker: "Leatherworker's Tools",
  mason: "Mason's Tools",
  navg: "Navigator's Tools",
  painter: "Painter's Supplies",
  pois: "Poisoner's Kit",
  potter: "Potter's Tools",
  smith: "Smith's Tools",
  thief: "Thieves' Tools",
  tinker: "Tinker's Tools",
  weaver: "Weaver's Tools",
  woodcarver: "Woodcarver's Tools"
});

export const LANGUAGES = Object.freeze({ cant: "Thieves' Cant", deep: "Deep Speech" });

export const SIZES = Object.freeze({
  tiny: "Tiny",
  sm: "Small",
  med: "Medium",
  lg: "Large",
  huge: "Huge",
  grg: "Gargantuan"
});

export const CURRENCIES = Object.freeze(["pp", "gp", "ep", "sp", "cp"]);

/** "darkvision" → "Darkvision", "animal-handling" → "Animal handling", "ab_cd" → "Ab cd". */
export function humanise(key) {
  const text = String(key ?? "")
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}
