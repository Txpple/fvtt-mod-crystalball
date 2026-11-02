/**
 * A character as a curated sheet: what the player sees on their dnd5e 6.x character sheet, read
 * from the raw actor in the world payload. The raw sheet (126–172 KB of JSON a character) never
 * goes to the model; this is its readable cut.
 *
 * The payload is source data, not prepared data: a modifier, a skill total, the hit point
 * maximum, the armour class and the spell slot maxima are not stored, so they are worked out here
 * the way dnd5e prepares them (its armour class formulas, its slot table, its hit point
 * advancement), without the bonuses items and effects add. The sheet says so once, so the ball
 * can tell a player a number may miss a bonus.
 */

import {
  ABILITY_NAMES,
  ABILITY_ORDER,
  ARMOR_PROFS,
  CURRENCIES,
  humanise,
  LANGUAGES,
  SCHOOLS,
  SIZES,
  SKILLS,
  TOOL_NAMES,
  WEAPON_PROFS,
  WEAPON_PROPERTIES
} from "./labels.js";
import { htmlToMarkdown } from "./markdown.js";

/* -------------------------------------------- */
/*  Numbers                                     */
/* -------------------------------------------- */

/** A stored value as a number, or null (formulas and blanks are not numbers). */
export function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export const abilityMod = score => Math.floor(((num(score) ?? 10) - 10) / 2);

export const signed = n => (n >= 0 ? `+${n}` : `${n}`);

/** The order items and documents are listed in: their sort key, then name, then id. */
export const bySortNameId = (a, b) =>
  (num(a.sort) ?? 0) - (num(b.sort) ?? 0) ||
  String(a.name ?? "").localeCompare(String(b.name ?? "")) ||
  String(a._id ?? "").localeCompare(String(b._id ?? ""));

const itemsOf = (actor, type) => (actor?.items ?? []).filter(i => i.type === type);

/** Each ability's score and modifier. */
export function abilityMods(actor) {
  const abilities = actor?.system?.abilities ?? {};
  return Object.fromEntries(ABILITY_ORDER.map(k => [k, abilityMod(abilities[k]?.value)]));
}

/* -------------------------------------------- */
/*  Effects                                     */
/* -------------------------------------------- */

/** Foundry's numeric change modes by their v13 numbers; v14 stores the name as `type`. */
const CHANGE_MODES = { 1: "multiply", 2: "add", 3: "downgrade", 4: "upgrade", 5: "override" };

const PHYSICAL = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container"]);

/** Whether dnd5e suppresses an item's transferred effects: unequipped gear, unattuned magic. */
function suppressed(item) {
  const sys = item?.system ?? {};
  if (!PHYSICAL.has(item?.type)) return false;
  if ("equipped" in sys && sys.equipped === false) return true;
  return (sys.attunement === "required" || sys.attunement === 1) && !sys.attuned;
}

/** The changes acting on the character: its own enabled effects and those its items transfer. */
export function activeChanges(actor) {
  const sources = [
    ...(actor?.effects ?? []).filter(e => !e.disabled),
    ...(actor?.items ?? []).flatMap(i =>
      suppressed(i)
        ? []
        : (i.effects ?? []).filter(e => e.transfer && !e.disabled && e.type !== "enchantment")
    )
  ];
  return sources.flatMap(e =>
    (e.system?.changes ?? e.changes ?? []).filter(c => c && typeof c.key === "string")
  );
}

const UNSAFE = /(^|\.)(__proto__|constructor|prototype)(\.|$)/;

/**
 * The actor with the plain numeric changes of its effects applied to a copy of its system data
 * (an Ability Score raised, a hit point bonus per level, an AC bonus, a skill's check bonus) and
 * the two dnd5e flags the sheet's numbers read. A change whose value is a formula is left out:
 * the Seer rolls nothing and evaluates nothing.
 */
export function withEffects(actor) {
  if (!actor?.system) return actor;
  const system = structuredClone(actor.system);
  const flags = {};
  for (const change of activeChanges(actor)) {
    const mode = change.type ?? CHANGE_MODES[change.mode] ?? "";
    if (UNSAFE.test(change.key)) continue;
    if (change.key.startsWith("flags.dnd5e.")) {
      if (change.value === true || change.value === "true" || num(change.value))
        flags[change.key.slice(12)] = true;
      continue;
    }
    const value = num(change.value);
    if (!change.key.startsWith("system.") || value === null) continue;
    const path = change.key.slice(7).split(".");
    let node = system;
    for (const part of path.slice(0, -1)) {
      if (node[part] === null || typeof node[part] !== "object") node[part] = {};
      node = node[part];
    }
    const last = path[path.length - 1];
    const current = num(node[last]);
    if (mode === "add") node[last] = (current ?? 0) + value;
    else if (mode === "override") node[last] = value;
    else if (mode === "upgrade") node[last] = current === null ? value : Math.max(current, value);
    else if (mode === "downgrade") node[last] = current === null ? value : Math.min(current, value);
    else if (mode === "multiply" && current !== null) node[last] = current * value;
  }
  return { ...actor, system, effectFlags: flags };
}

/* -------------------------------------------- */
/*  Identity                                    */
/* -------------------------------------------- */

/** A detail that is either an embedded item's id (dnd5e 6.x) or a plain string (older data). */
function detailName(actor, key, type) {
  const value = actor?.system?.details?.[key];
  const items = actor?.items ?? [];
  const byId = typeof value === "string" ? items.find(i => i._id === value) : null;
  if (byId) return byId.name;
  const byType = items.find(i => i.type === type);
  if (byType) return byType.name;
  if (typeof value === "string" && value && !/^[A-Za-z0-9]{16}$/.test(value)) return value;
  if (value && typeof value === "object" && typeof value.name === "string") return value.name;
  return "";
}

export const speciesOf = actor => detailName(actor, "race", "race");

export const backgroundOf = actor => detailName(actor, "background", "background");

/**
 * The classes, the original class first, then by levels and name; each with its subclass.
 * @returns {Array<{ name: string, levels: number, identifier: string, subclass: string, item: object, sub: object | null }>}
 */
export function classesOf(actor) {
  const subclasses = itemsOf(actor, "subclass");
  const original = actor?.system?.details?.originalClass;
  return itemsOf(actor, "class")
    .map(item => {
      const identifier = item.system?.identifier ?? "";
      const sub =
        subclasses.find(
          s => s.system?.classIdentifier && s.system.classIdentifier === identifier
        ) ?? null;
      return {
        name: item.name,
        levels: num(item.system?.levels) ?? 0,
        identifier,
        subclass: sub?.name ?? "",
        item,
        sub
      };
    })
    .sort(
      (a, b) =>
        (b.item._id === original) - (a.item._id === original) ||
        b.levels - a.levels ||
        a.name.localeCompare(b.name) ||
        String(a.item._id).localeCompare(String(b.item._id))
    );
}

export const levelOf = actor => classesOf(actor).reduce((sum, c) => sum + c.levels, 0);

export const profBonus = level => 2 + Math.floor((Math.max(1, level) - 1) / 4);

/** "Warlock 2 (The Fiend) / Fighter 1". */
export const classLine = actor =>
  classesOf(actor)
    .map(c => `${c.name} ${c.levels}${c.subclass ? ` (${c.subclass})` : ""}`)
    .join(" / ");

/** The class names alone, for the stub's line ("Fighter / Wizard"). */
export const classNames = actor =>
  classesOf(actor)
    .map(c => c.name)
    .join(" / ");

/* -------------------------------------------- */
/*  Hit points and armour class                 */
/* -------------------------------------------- */

const dieSize = cls =>
  num(String(cls.system?.hd?.denomination ?? cls.system?.hitDice ?? "").replace(/^d/i, ""));

/**
 * Hit points: the stored current and temporary, and the maximum (stored when the sheet overrides
 * it, else dnd5e's: each class's hit point advancement, Constitution per level, the bonuses).
 * @returns {{ value: number, max: number | null, temp: number, computed: boolean }}
 */
export function hpOf(actor) {
  const hp = actor?.system?.attributes?.hp ?? {};
  const value = num(hp.value) ?? 0;
  const temp = num(hp.temp) ?? 0;
  const tempmax = num(hp.tempmax) ?? 0;
  if (num(hp.max) !== null) return { value, max: num(hp.max) + tempmax, temp, computed: false };
  const classes = classesOf(actor);
  if (!classes.length) return { value, max: null, temp, computed: false };
  const level = classes.reduce((sum, c) => sum + c.levels, 0);
  let max = 0;
  for (const c of classes) {
    const die = dieSize(c.item) ?? 0;
    const adv = Object.values(c.item.system?.advancement ?? {}).find(a => a?.type === "HitPoints");
    for (const v of Object.values(adv?.value ?? {})) {
      if (v === "max") max += die;
      else if (v === "avg") max += Math.floor(die / 2) + 1;
      else max += num(v) ?? 0;
    }
  }
  const con = abilityMods(actor).con;
  const bonuses = hp.bonuses ?? {};
  max += con * level + (num(bonuses.level) ?? 0) * level + (num(bonuses.overall) ?? 0) + tempmax;
  return { value, max: Math.max(max, 0), temp, computed: true };
}

const ARMOR_TYPES = new Set(["light", "medium", "heavy", "natural"]);

/**
 * Armour class as dnd5e 6.x prepares it: the override when set, else the best of the actor's
 * calculations (armoured, unarmoured and their variants) for the armour and shield equipped,
 * then the shield. Effects and item bonuses outside the armour itself are not applied.
 * @returns {{ value: number, label: string, computed: boolean }}
 */
export function acOf(actor) {
  const ac = actor?.system?.attributes?.ac ?? {};
  if (num(ac.override) !== null) return { value: num(ac.override), label: "", computed: false };
  if (ac.calc === "flat" && num(ac.flat) !== null)
    return { value: num(ac.flat), label: "", computed: false };
  const mods = abilityMods(actor);
  const equipped = itemsOf(actor, "equipment").filter(i => i.system?.equipped);
  const armor = equipped.find(i => ARMOR_TYPES.has(i.system?.type?.value)) ?? null;
  const shield = equipped.find(i => i.system?.type?.value === "shield") ?? null;
  const calcs = new Set(Array.isArray(ac.calcs) ? ac.calcs : ["unarmored", "armored"]);
  if (ac.calc === "default") {
    calcs.add("armored");
    calcs.add("unarmored");
  } else if (ac.calc) calcs.add(ac.calc);
  const armorBonus = i => num(i?.system?.armor?.magicalBonus) ?? 0;
  const dex =
    armor?.system?.type?.value === "heavy"
      ? 0
      : Math.min(mods.dex, num(armor?.system?.armor?.dex) ?? Number.POSITIVE_INFINITY);
  const formulas = {
    natural: { value: num(ac.flat) ?? 0 },
    armored: armor
      ? { value: (num(armor.system.armor?.value) ?? 10) + armorBonus(armor) + dex }
      : null,
    unarmored: armor ? null : { value: 10 + mods.dex },
    mage: armor ? null : { value: 13 + mods.dex },
    draconic: armor ? null : { value: 13 + mods.dex },
    unarmoredMonk: armor || shield ? null : { value: 10 + mods.dex + mods.wis },
    unarmoredBarb: armor ? null : { value: 10 + mods.dex + mods.con },
    unarmoredBard: armor ? null : { value: 10 + mods.dex + mods.cha }
  };
  let base = 0;
  let calc = "";
  for (const id of calcs) {
    const f = formulas[id];
    if (f && f.value > base) {
      base = f.value;
      calc = id;
    }
  }
  const shieldValue = shield ? (num(shield.system.armor?.value) ?? 0) + armorBonus(shield) : 0;
  const parts = [
    calc === "armored" ? armor.name : calc ? humanise(calc).toLowerCase() : "",
    shield?.name ?? ""
  ];
  return {
    value: base + shieldValue + (num(ac.bonus) ?? 0),
    label: parts.filter(Boolean).join(" and "),
    computed: true
  };
}

/* -------------------------------------------- */
/*  Movement, senses, slots                     */
/* -------------------------------------------- */

/** Speeds by mode, the character's own over its species'. */
export function movementOf(actor) {
  const species = itemsOf(actor, "race")[0]?.system?.movement ?? {};
  const own = actor?.system?.attributes?.movement ?? {};
  const read = m => ({
    ...(m?.speeds ?? {}),
    ...Object.fromEntries(
      Object.entries(m ?? {}).filter(
        ([k]) => !["speeds", "units", "hover", "ignoredDifficultTerrain", "special"].includes(k)
      )
    )
  });
  const merged = {
    ...read(species),
    ...Object.fromEntries(Object.entries(read(own)).filter(([, v]) => num(v)))
  };
  const units = own.units ?? species.units ?? "ft";
  const out = Object.entries(merged)
    .filter(([, v]) => num(v))
    .map(([k, v]) => `${k} ${num(v)} ${units}`)
    .sort();
  if (own.hover || species.hover) out.push("hover");
  return out.join(", ");
}

/** Senses by kind, the character's own over its species'. */
export function sensesOf(actor) {
  const species = itemsOf(actor, "race")[0]?.system?.senses ?? {};
  const own = actor?.system?.attributes?.senses ?? {};
  const read = s => ({
    ...(s?.ranges ?? {}),
    ...Object.fromEntries(
      Object.entries(s ?? {}).filter(([k]) => !["ranges", "units", "special"].includes(k))
    )
  });
  const merged = {
    ...read(species),
    ...Object.fromEntries(Object.entries(read(own)).filter(([, v]) => num(v)))
  };
  const units = own.units ?? species.units ?? "ft";
  const out = Object.entries(merged)
    .filter(([, v]) => num(v))
    .map(([k, v]) => `${k} ${num(v)} ${units}`)
    .sort();
  const special = [species.special, own.special].filter(Boolean).join("; ");
  if (special) out.push(special);
  return out.join(", ");
}

/** dnd5e's spell slot table: slots per spell level for a caster level of 1 to 20. */
export const SLOT_TABLE = Object.freeze([
  [2],
  [3],
  [4, 2],
  [4, 3],
  [4, 3, 2],
  [4, 3, 3],
  [4, 3, 3, 1],
  [4, 3, 3, 2],
  [4, 3, 3, 3, 1],
  [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1, 1],
  [4, 3, 3, 3, 2, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 2, 1, 1]
]);

/** Pact magic by warlock level: slots and their level. */
const PACT_TABLE = [
  [17, 4, 5],
  [11, 3, 5],
  [9, 2, 5],
  [7, 2, 4],
  [5, 2, 3],
  [3, 2, 2],
  [2, 2, 1],
  [1, 1, 1]
];

/** dnd5e's progressions (the 2024 rules: a half caster rounds up). */
const PROGRESSIONS = { full: [1, false], half: [2, true], third: [3, false], artificer: [2, true] };

/**
 * Spell slots: the remaining count stored on the sheet and the maximum dnd5e would prepare
 * (from each class's progression, or a stored override).
 * @returns {{ slots: Array<{ level: number, value: number, max: number }>, pact: { level: number, value: number, max: number } | null }}
 */
export function spellSlotsOf(actor) {
  const spells = actor?.system?.spells ?? {};
  const casters = classesOf(actor).map(c => {
    const own = c.item.system?.spellcasting?.progression;
    const progression =
      own && own !== "none" ? own : (c.sub?.system?.spellcasting?.progression ?? "none");
    return { levels: c.levels, progression };
  });
  const multi = casters.filter(c => c.progression in PROGRESSIONS);
  let casterLevel = 0;
  for (const c of multi) {
    const [divisor, roundUp] = PROGRESSIONS[c.progression];
    casterLevel += (roundUp ? Math.ceil : Math.floor)(c.levels / divisor);
    if (multi.length === 1 && divisor > 1 && casterLevel)
      casterLevel = Math.ceil(c.levels / divisor);
  }
  const row = casterLevel ? (SLOT_TABLE[Math.min(casterLevel, 20) - 1] ?? []) : [];
  const slots = [];
  for (let level = 1; level <= 9; level++) {
    const stored = spells[`spell${level}`] ?? {};
    const max = num(stored.override) ?? row[level - 1] ?? 0;
    const value = num(stored.value) ?? 0;
    if (max || value) slots.push({ level, value, max });
  }
  const pactLevels = casters
    .filter(c => c.progression === "pact")
    .reduce((s, c) => s + c.levels, 0);
  let pact = null;
  const storedPact = spells.pact ?? {};
  const entry = PACT_TABLE.find(([at]) => pactLevels >= at);
  if (entry || num(storedPact.override) || num(storedPact.value)) {
    pact = {
      level: entry?.[2] ?? num(storedPact.level) ?? 1,
      value: num(storedPact.value) ?? 0,
      max: num(storedPact.override) ?? entry?.[1] ?? 0
    };
  }
  return { slots, pact };
}

/* -------------------------------------------- */
/*  Items                                       */
/* -------------------------------------------- */

/** What a player sees of an item: an unidentified one shows its unidentified name and text. */
export function itemFace(item) {
  const sys = item?.system ?? {};
  if (sys.identified === false) {
    return {
      name: sys.unidentified?.name || `Unidentified ${humanise(item.type).toLowerCase()}`,
      description: sys.unidentified?.description ?? ""
    };
  }
  return { name: item?.name ?? "", description: sys.description?.value ?? "" };
}

const md = (html, nameOf) => htmlToMarkdown(html, { nameOf, secrets: false, headingOffset: 4 });

/** "1d8 slashing" from a dnd5e damage part. */
function damageText(part) {
  if (!part) return "";
  if (part.custom?.enabled && part.custom.formula) return part.custom.formula;
  const dice =
    num(part.number) && num(part.denomination) ? `${part.number}d${part.denomination}` : "";
  const bonus = part.bonus ? ` + ${part.bonus}` : "";
  const types = (part.types ?? []).join("/");
  return [dice + bonus, types].filter(Boolean).join(" ").trim();
}

function usesText(sys) {
  const max = num(sys?.uses?.max);
  if (!max) return "";
  const left = max - (num(sys.uses.spent) ?? 0);
  return `uses ${left} of ${max}`;
}

/** One inventory line's facts: quantity, equipped, attunement, container, uses, the weapon or armour. */
function itemFacts(item, byId) {
  const sys = item.system ?? {};
  const facts = [humanise(item.type).toLowerCase()];
  const qty = num(sys.quantity);
  if (qty !== null && qty !== 1) facts.push(`qty ${qty}`);
  if (sys.equipped) facts.push("equipped");
  if (sys.attuned) facts.push("attuned");
  else if (sys.attunement === "required" || sys.attunement === 1)
    facts.push("needs attunement, not attuned");
  if (sys.rarity && !["common", "none", ""].includes(sys.rarity))
    facts.push(humanise(sys.rarity).toLowerCase());
  const container = sys.container ? byId.get(sys.container) : null;
  if (container) facts.push(`in ${itemFace(container).name}`);
  const uses = usesText(sys);
  if (uses) facts.push(uses);
  if (item.type === "weapon") {
    const base = damageText(sys.damage?.base);
    if (base) facts.push(base);
    const versatile = damageText(sys.damage?.versatile);
    if (versatile && num(sys.damage?.versatile?.number)) facts.push(`versatile ${versatile}`);
    const props = (sys.properties ?? []).map(p => WEAPON_PROPERTIES[p] ?? p);
    if (props.length) facts.push(props.join(", "));
    if (sys.mastery) facts.push(`mastery ${humanise(sys.mastery).toLowerCase()}`);
  }
  if (item.type === "equipment" && num(sys.armor?.value)) {
    const kind = sys.type?.value === "shield" ? "shield" : `${sys.type?.value ?? ""} armour`.trim();
    facts.push(`${kind}, AC ${sys.type?.value === "shield" ? "+" : ""}${num(sys.armor.value)}`);
  }
  return facts;
}

const INVENTORY_TYPES = ["weapon", "equipment", "consumable", "tool", "container", "loot"];

/* -------------------------------------------- */
/*  Spells, features, effects                   */
/* -------------------------------------------- */

/** How a spell is held: dnd5e 6.x's `method` and numeric `prepared`, or the older `preparation`. */
function preparedText(sys) {
  const method = sys.method ?? sys.preparation?.mode ?? "spell";
  const prepared = sys.prepared ?? sys.preparation?.prepared;
  if (method === "atwill") return "at will";
  if (method === "innate") return "innate";
  if (method === "ritual") return "ritual only";
  if (method === "always" || prepared === 2) return "always prepared";
  if (method === "pact")
    return prepared === 0 || prepared === false ? "pact magic, not prepared" : "pact magic";
  if (prepared === 1 || prepared === true) return "prepared";
  if (sys.level === 0) return "cantrip";
  return "not prepared";
}

function spellHeader(sys) {
  const parts = [];
  parts.push(sys.level ? `level ${sys.level}` : "cantrip");
  if (SCHOOLS[sys.school]) parts.push(SCHOOLS[sys.school].toLowerCase());
  const act = sys.activation;
  if (act?.type)
    parts.push(
      `${num(act.value) && act.value !== 1 ? `${act.value} ` : ""}${humanise(act.type).toLowerCase()}`
    );
  const range = sys.range;
  if (num(range?.value)) parts.push(`range ${range.value} ${range.units ?? ""}`.trim());
  else if (range?.units && !["", "spec"].includes(range.units))
    parts.push(`range ${humanise(range.units).toLowerCase()}`);
  const props = new Set(sys.properties ?? []);
  if (props.has("concentration")) parts.push("concentration");
  if (props.has("ritual")) parts.push("ritual");
  const comps = [
    props.has("vocal") ? "V" : "",
    props.has("somatic") ? "S" : "",
    props.has("material") ? "M" : ""
  ].filter(Boolean);
  if (comps.length) parts.push(comps.join(""));
  const dur = sys.duration;
  if (num(dur?.value)) parts.push(`${dur.value} ${dur.units ?? ""}`.trim());
  else if (dur?.units && dur.units !== "inst") parts.push(humanise(dur.units).toLowerCase());
  parts.push(preparedText(sys));
  return parts.join("; ");
}

/** The effects on the character: its own and those its items transfer, enabled ones only. */
export function effectsOf(actor) {
  const own = (actor?.effects ?? []).filter(e => !e.disabled).map(e => e.name);
  const carried = (actor?.items ?? []).flatMap(i =>
    suppressed(i)
      ? []
      : (i.effects ?? [])
          .filter(e => e.transfer && !e.disabled && e.type !== "enchantment")
          .map(e => (e.name === itemFace(i).name ? e.name : `${e.name} (from ${itemFace(i).name})`))
  );
  return [...new Set([...own, ...carried])].sort((a, b) => a.localeCompare(b));
}

/* -------------------------------------------- */
/*  The sheet                                   */
/* -------------------------------------------- */

/** The party layer's line for a member: name, species, classes, HP, AC. */
export function memberLine(raw) {
  const actor = withEffects(raw);
  const hp = hpOf(actor);
  const ac = acOf(actor);
  const parts = [speciesOf(actor), classLine(actor)].filter(Boolean);
  parts.push(
    `HP ${hp.value}${hp.max !== null ? `/${hp.max}` : ""}${hp.temp ? ` (+${hp.temp} temp)` : ""}`
  );
  parts.push(`AC ${ac.value}`);
  return `${actor.name}: ${parts.join("; ")}`;
}

const listOr = (values, empty = "none") => (values.length ? values.join(", ") : empty);

function proficiencyLines(actor) {
  const traits = actor?.system?.traits ?? {};
  const words = (trait, map = {}) => [
    ...(trait?.value ?? []).map(v => map[v] ?? humanise(v).toLowerCase()),
    ...String(trait?.custom ?? "")
      .split(";")
      .map(s => s.trim())
      .filter(Boolean)
  ];
  const lines = [];
  lines.push(`Armour: ${listOr(words(traits.armorProf, ARMOR_PROFS))}.`);
  const weapons = words(traits.weaponProf, WEAPON_PROFS);
  lines.push(`Weapons: ${listOr(weapons)}.`);
  const mastery = traits.weaponProf?.mastery?.value ?? [];
  if (mastery.length)
    lines.push(`Weapon mastery: ${mastery.map(m => humanise(m).toLowerCase()).join(", ")}.`);
  const mods = abilityMods(actor);
  const prof = profBonus(levelOf(actor));
  const tools = Object.entries(actor?.system?.tools ?? {})
    .filter(([, t]) => num(t?.value))
    .map(([k, t]) => {
      const bonus = mods[t.ability ?? "int"] + Math.floor(prof * num(t.value));
      return `${TOOL_NAMES[k] ?? humanise(k)} ${signed(bonus)}`;
    })
    .sort();
  lines.push(`Tools: ${listOr(tools)}.`);
  const languages = words(traits.languages, LANGUAGES).map(l => humanise(l));
  lines.push(`Languages: ${listOr(languages)}.`);
  for (const [key, label] of [
    ["dr", "Damage resistances"],
    ["di", "Damage immunities"],
    ["dv", "Damage vulnerabilities"],
    ["ci", "Condition immunities"]
  ]) {
    const values = words(traits[key]);
    if (values.length) lines.push(`${label}: ${values.join(", ")}.`);
  }
  return lines;
}

/**
 * A character's curated sheet as Markdown, under a `##` heading of its name.
 * @param {object} actor  the raw actor from the world payload
 * @param {{ nameOf?: (uuid: string) => string | null }} [options]
 */
export function curatedSheet(raw, { nameOf } = {}) {
  const actor = withEffects(raw);
  const sys = actor?.system ?? {};
  const details = sys.details ?? {};
  const attrs = sys.attributes ?? {};
  const level = levelOf(actor);
  const prof = profBonus(level);
  const mods = abilityMods(actor);
  const jack = actor.effectFlags?.jackOfAllTrades ? Math.floor(prof / 2) : 0;
  const out = [`## ${actor.name}`];

  const identity = [
    speciesOf(actor) && `Species: ${speciesOf(actor)}`,
    backgroundOf(actor) && `Background: ${backgroundOf(actor)}`,
    classLine(actor) && `Classes: ${classLine(actor)}`,
    `Level ${level}, proficiency bonus ${signed(prof)}`,
    SIZES[sys.traits?.size] && `Size: ${SIZES[sys.traits.size]}`,
    details.alignment && `Alignment: ${details.alignment}`,
    num(details.xp?.value) !== null && `XP ${details.xp.value}`
  ].filter(Boolean);
  out.push(`${identity.join(". ")}.`);
  out.push(
    "Numbers marked (worked out) are computed from the raw sheet the way dnd5e does, with the plain bonuses of its effects; a bonus that is a formula or a roll is not in them."
  );

  const hp = hpOf(actor);
  const ac = acOf(actor);
  const initAbility = attrs.init?.ability || "dex";
  // dnd5e adds Jack of All Trades to initiative, and the 2024 Alert feat the proficiency bonus.
  const init =
    mods[initAbility] +
    (num(attrs.init?.bonus) ?? 0) +
    (actor.effectFlags?.initiativeAlert ? prof : jack);
  const vitals = [
    `HP ${hp.value}${hp.max !== null ? ` of ${hp.max}${hp.computed ? " (worked out)" : ""}` : ""}${hp.temp ? `, ${hp.temp} temporary` : ""}`,
    `AC ${ac.value}${ac.computed ? ` (worked out${ac.label ? `: ${ac.label}` : ""})` : ""}`,
    `Initiative ${signed(init)} (worked out)`
  ];
  const speed = movementOf(actor);
  if (speed) vitals.push(`Speed ${speed}`);
  const senses = sensesOf(actor);
  if (senses) vitals.push(`Senses: ${senses}`);
  const hd = classesOf(actor)
    .map(c => {
      const die = dieSize(c.item);
      const spent = num(c.item.system?.hd?.spent) ?? 0;
      return die ? `${Math.max(c.levels - spent, 0)} of ${c.levels} d${die}` : "";
    })
    .filter(Boolean);
  if (hd.length) vitals.push(`Hit dice left: ${hd.join(", ")}`);
  if (num(attrs.exhaustion)) vitals.push(`Exhaustion level ${attrs.exhaustion}`);
  if (hp.value === 0 && attrs.death) {
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : word.endsWith("s") ? "es" : "s"}`;
    const ok = num(attrs.death.success) ?? 0;
    const fail = num(attrs.death.failure) ?? 0;
    vitals.push(`Death saves: ${plural(ok, "success")}, ${plural(fail, "failure")}`);
  }
  if (attrs.inspiration) vitals.push("Heroic Inspiration: yes");
  out.push(`${vitals.join(". ")}.`);

  out.push("### Abilities and saving throws (worked out)");
  out.push(
    ABILITY_ORDER.map(k => {
      const a = sys.abilities?.[k] ?? {};
      const save = mods[k] + (num(a.proficient) ? prof : 0);
      const mark = num(a.proficient) ? " (proficient)" : "";
      return `- ${ABILITY_NAMES[k]} ${num(a.value) ?? 10} (${signed(mods[k])}), save ${signed(save)}${mark}`;
    }).join("\n")
  );

  out.push("### Skills (worked out)");
  const skills = Object.entries(SKILLS).map(([k, [label, ability]]) => {
    const s = sys.skills?.[k] ?? {};
    const mult = num(s.value) ?? 0;
    const base = mult ? Math.floor(prof * mult) : jack;
    const total = mods[s.ability || ability] + base + (num(s.bonuses?.check) ?? 0);
    const mark =
      mult >= 2
        ? " (expertise)"
        : mult >= 1
          ? " (proficient)"
          : mult > 0
            ? " (half proficiency)"
            : "";
    return { k, text: `${label} ${signed(total)}${mark}`, total };
  });
  out.push(skills.map(s => s.text).join("; "));
  out.push(`Passive Perception ${10 + skills.find(s => s.k === "prc").total}.`);

  out.push("### Proficiencies and languages");
  out.push(...proficiencyLines(actor));

  out.push("### Coin");
  const coin = CURRENCIES.filter(c => num(sys.currency?.[c])).map(c => `${sys.currency[c]} ${c}`);
  out.push(coin.length ? coin.join(", ") : "None.");

  const spells = itemsOf(actor, "spell").sort(
    (a, b) => (num(a.system?.level) ?? 0) - (num(b.system?.level) ?? 0) || bySortNameId(a, b)
  );
  const { slots, pact } = spellSlotsOf(actor);
  if (spells.length || slots.length || pact) {
    out.push("### Spell slots (worked out)");
    const slotText = slots.map(s => `level ${s.level}: ${s.value} of ${s.max} left`);
    if (pact) slotText.push(`pact magic (level ${pact.level}): ${pact.value} of ${pact.max} left`);
    out.push(slotText.length ? `${slotText.join("; ")}.` : "None.");
    if (ABILITY_NAMES[attrs.spellcasting]) {
      const ability = attrs.spellcasting;
      out.push(
        `Spellcasting ability ${ABILITY_NAMES[ability] ?? ability}: spell attack ${signed(mods[ability] + prof)}, save DC ${8 + mods[ability] + prof}.`
      );
    }
    // A prepared caster's sheet holds its whole list; what it cannot cast today is named, not
    // described (the ball knows the books' spells in general).
    const resting = spells.filter(s => preparedText(s.system ?? {}) === "not prepared");
    const ready = spells.filter(s => !resting.includes(s));
    out.push("### Spells");
    for (const spell of ready) {
      const face = itemFace(spell);
      out.push(`#### ${face.name} (${spellHeader(spell.system ?? {})})`);
      const text = md(face.description, nameOf);
      if (text) out.push(text);
    }
    if (resting.length) {
      out.push(
        `On the sheet but not prepared: ${resting.map(s => `${itemFace(s).name} (level ${num(s.system?.level) ?? 0})`).join(", ")}.`
      );
    }
  }

  const feats = itemsOf(actor, "feat").sort(bySortNameId);
  if (feats.length) {
    out.push("### Features");
    for (const feat of feats) {
      const face = itemFace(feat);
      const type = feat.system?.type?.value;
      const kind = type === "race" ? "species" : type ? humanise(type).toLowerCase() : "";
      const uses = usesText(feat.system);
      const tag = [kind === "feat" ? "feat" : kind && `${kind} feature`, uses]
        .filter(Boolean)
        .join("; ");
      out.push(`#### ${face.name}${tag ? ` (${tag})` : ""}`);
      const text = md(face.description, nameOf);
      if (text) out.push(text);
    }
  }

  const byId = new Map((actor?.items ?? []).map(i => [i._id, i]));
  const gear = (actor?.items ?? [])
    .filter(i => INVENTORY_TYPES.includes(i.type))
    .sort(
      (a, b) =>
        INVENTORY_TYPES.indexOf(a.type) - INVENTORY_TYPES.indexOf(b.type) || bySortNameId(a, b)
    );
  out.push("### Inventory");
  if (!gear.length) out.push("Nothing carried.");
  for (const item of gear) {
    const face = itemFace(item);
    out.push(`#### ${face.name} (${itemFacts(item, byId).join("; ")})`);
    const text = md(face.description, nameOf);
    if (text) out.push(text);
  }

  out.push("### Effects and conditions");
  out.push(`${listOr(effectsOf(actor))}.`);

  const persona = [
    ["Personality", details.trait],
    ["Ideals", details.ideal],
    ["Bonds", details.bond],
    ["Flaws", details.flaw],
    ["Appearance", details.appearance]
  ].filter(([, v]) => typeof v === "string" && v.trim());
  const biography = md(details.biography?.value ?? "", nameOf);
  if (persona.length || biography) {
    out.push("### Who they are");
    for (const [label, value] of persona)
      out.push(`${label}: ${htmlToMarkdown(value, { nameOf })}`);
    if (biography) out.push(biography);
  }
  return out.join("\n\n");
}
