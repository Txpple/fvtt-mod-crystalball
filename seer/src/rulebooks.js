/**
 * The rulebooks: the compendium packs the DM opens to the ball (the `rulebooks` world setting),
 * read on demand through two tools the model calls, never put in the gaze. A book is hundreds of
 * thousands of tokens; a lookup is a few hundred, paid only by the question that needs it.
 *
 * - **Which packs**: the setting's ids that are active in the world and hold journal entries or
 *   items. Never an actor, adventure, scene or table pack: no stat block reaches the ball, and an
 *   embedded actor in a page is dropped. The `rulebookLeaveOut` setting removes folders, entries
 *   and pages by name (the creature chapters, an adventure).
 * - **Whose eyes**: Foundry checks no read permission on a compendium get, so the Seer applies the
 *   pack's ownership itself, as the server's `getUserLevel` computes it: the world's
 *   `compendiumConfiguration` override, else the pack's own, else the default (Player: Observer);
 *   the highest level of any role the user holds, Observer to read. A GM reads what the players
 *   read.
 * - **The tools**: `search_rulebooks` (names first, then the text) and `read_rulebook` (one entry
 *   rendered whole: a spell's facts, a class's features by level, a feature's granting class, a
 *   rules page with the glossary entries it embeds). Their definitions are the same bytes for every
 *   player at the table, so they cache with the instructions layer.
 *
 * Everything here is pure but `createLibrary`, which holds the packs read off the ball's socket.
 */

import { humanise, SCHOOLS, WEAPON_PROPERTIES } from "./labels.js";
import { htmlToMarkdown } from "./markdown.js";
import { LEVELS, ROLES } from "./permission.js";
import { worldSetting } from "./settings.js";
import { num } from "./sheet.js";

export const TOOL_SEARCH = "search_rulebooks";
export const TOOL_READ = "read_rulebook";

/** The pack types the ball reads; every other type is refused whatever the setting lists. */
export const READABLE_TYPES = Object.freeze(["JournalEntry", "Item"]);

/** Foundry's default ownership of a package's pack (14.369's `packs.ownership` initial). */
export const DEFAULT_PACK_OWNERSHIP = Object.freeze({ PLAYER: "OBSERVER", ASSISTANT: "OWNER" });

/** What a search may be narrowed to. */
export const KINDS = Object.freeze([
  "spell",
  "spell list",
  "class",
  "subclass",
  "feature",
  "feat",
  "species",
  "background",
  "equipment",
  "facility",
  "rules"
]);

export const SEARCH_LIMIT = 8;

/** A read's cap: about six thousand tokens. */
export const READ_LIMIT_CHARS = 24000;

/** How much of a subclass's or species' granted features a read inlines before names alone. */
const INLINE_GRANTS_CHARS = 14000;

const QUERY_CHARS = 200;

/* -------------------------------------------- */
/*  Packs and permission                        */
/* -------------------------------------------- */

/** A pack's id as the world payload lists it (`<package>.<name>`). */
export const packIdOf = pack =>
  pack?.id ?? (pack?.packageName && pack?.name ? `${pack.packageName}.${pack.name}` : null);

/** The book a pack belongs to, as a reader names it: its package's title, the publisher's prefix dropped. */
export function bookOf(world, pack) {
  const pkg = pack?.packageName;
  const title =
    pack?.packageType === "system"
      ? world?.system?.title
      : (world?.modules ?? []).find(m => m?.id === pkg)?.title;
  return String(title || pack?.label || pkg || "")
    .replace(/^Dungeons\s*&\s*Dragons\s*:?\s+/i, "")
    .trim();
}

/** The world's compendium configuration (`core.compendiumConfiguration`), a GM's row only. */
export function compendiumConfiguration(world) {
  const value = worldSetting(world, "core.compendiumConfiguration");
  return value && typeof value === "object" ? value : {};
}

const levelValue = l => (typeof l === "number" ? l : (LEVELS[l] ?? LEVELS.NONE));

/** The level a role reaches on a pack: Foundry 14.369's `getUserLevel`, the role in place of the user. */
export function packLevel(pack, role, configuration = {}) {
  const ownership =
    configuration?.[packIdOf(pack)]?.ownership ?? pack?.ownership ?? DEFAULT_PACK_OWNERSHIP;
  let level = LEVELS.NONE;
  for (const [name, l] of Object.entries(ownership ?? {})) {
    if ((ROLES[name] ?? Number.POSITIVE_INFINITY) <= role) level = Math.max(level, levelValue(l));
  }
  return level;
}

/** Whether the user may read the pack: Observer, as the compendium sidebar opens it to them. */
export function packOpenTo(pack, user, { configuration = {} } = {}) {
  const role = user?.role ?? ROLES.NONE;
  if (role >= ROLES.ASSISTANT)
    return packLevel(pack, ROLES.PLAYER, configuration) >= LEVELS.OBSERVER;
  return role >= ROLES.PLAYER && packLevel(pack, role, configuration) >= LEVELS.OBSERVER;
}

/** The table's rulebooks: the setting's packs the world has, of a readable type, in its order. */
export function tableRulebooks(world, settings) {
  const byId = new Map((world?.packs ?? []).map(p => [packIdOf(p), p]));
  return (settings?.rulebooks ?? [])
    .map(id => byId.get(id))
    .filter(p => p && READABLE_TYPES.includes(p.type));
}

/**
 * A compendium uuid's parts: `Compendium.<pkg>.<pack>.<Type>.<id>[.<Embedded>.<id>]`, or the older
 * `Compendium.<pkg>.<pack>.<id>`. Null for anything else.
 */
export function parseCompendiumUuid(uuid) {
  const parts = String(uuid ?? "").split(".");
  if (parts[0] !== "Compendium" || parts.length < 4) return null;
  const pack = `${parts[1]}.${parts[2]}`;
  const rest = parts.slice(3);
  if (rest.length === 1) return { pack, type: null, id: rest[0], embedded: [] };
  const [type, id, ...tail] = rest;
  const embedded = [];
  for (let i = 0; i + 1 < tail.length; i += 2) embedded.push({ type: tail[i], id: tail[i + 1] });
  return { pack, type, id, embedded };
}

/* -------------------------------------------- */
/*  Text                                        */
/* -------------------------------------------- */

/** Words for matching: no accents, no apostrophes, lower case, single spaces. */
export const norm = text =>
  String(text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Stored HTML as bare words for the search: labels kept, links, tags and entities dropped. */
const plain = html =>
  String(html ?? "")
    .replace(/@\w+\[[^[\]]{0,500}\]\{([^{}]{0,500})\}/g, " $1 ")
    .replace(/@\w+\[[^[\]]{0,500}\]/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ");

const STOP = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "do",
  "does",
  "for",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "what",
  "with"
]);

const termsOf = q => {
  const words = norm(q).split(" ").filter(Boolean);
  const kept = words.filter(w => !STOP.has(w));
  return kept.length ? kept : words;
};

/* -------------------------------------------- */
/*  Entries                                     */
/* -------------------------------------------- */

const PHYSICAL = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container"]);

/** An item's kind on the shelf, or null for one the ball does not read (a monster's feature). */
export function itemKind(item) {
  switch (item?.type) {
    case "spell":
      return "spell";
    case "class":
      return "class";
    case "subclass":
      return "subclass";
    case "race":
      return "species";
    case "background":
      return "background";
    case "facility":
      return "facility";
    case "feat": {
      const t = item.system?.type?.value;
      if (t === "monster") return null;
      return t === "feat" ? "feat" : "feature";
    }
    default:
      return PHYSICAL.has(item?.type) ? "equipment" : null;
  }
}

/** A pack's folder path by folder id, root first, from the payload's folder list. */
function pathFinder(pack) {
  const byId = new Map((pack?.folders ?? []).map(f => [f?._id, f]));
  return id => {
    const names = [];
    const seen = new Set();
    let f = byId.get(id);
    while (f && !seen.has(f._id)) {
      seen.add(f._id);
      names.unshift(String(f.name ?? ""));
      f = byId.get(f.folder);
    }
    return names.filter(Boolean);
  };
}

const bySort = (a, b) =>
  (a?.sort ?? 0) - (b?.sort ?? 0) || String(a?.name).localeCompare(String(b?.name));

/**
 * One loaded pack's entries: every item of a kind the ball reads, and every text, rule and class
 * or subclass spell-list page of a journal pack (class and subclass pages repeat the items; image,
 * map, video and pdf pages have no words). Pure.
 * @param {object} pack  the payload's pack (id, type, folders)
 * @param {object[]} docs  its documents' source
 * @param {string} book
 */
export function shelfOf(pack, docs, book) {
  const id = packIdOf(pack);
  const pathOf = pathFinder(pack);
  const entries = [];
  if (pack?.type === "Item") {
    for (const doc of docs ?? []) {
      const kind = itemKind(doc);
      if (!kind || !doc?._id) continue;
      entries.push({
        id: `${id}/${doc._id}`,
        uuid: `Compendium.${id}.Item.${doc._id}`,
        pack: id,
        book,
        kind,
        name: String(doc.name ?? ""),
        title: String(doc.name ?? ""),
        path: pathOf(doc.folder),
        doc,
        words: norm(plain(doc.system?.description?.value))
      });
    }
  } else if (pack?.type === "JournalEntry") {
    for (const doc of docs ?? []) {
      if (!doc?._id) continue;
      for (const page of [...(doc.pages ?? [])].sort(bySort)) {
        if (!page?._id) continue;
        const html = String(page.text?.content ?? "");
        let kind = null;
        if (page.type === "spells") {
          if (["class", "subclass"].includes(page.system?.type)) kind = "spell list";
        } else if (page.type === "text" || page.type === "rule") {
          if (plain(html).trim() || /@Embed\[/.test(html)) kind = "rules";
        }
        if (!kind) continue;
        const entryName = String(doc.name ?? "");
        const pageName = String(page.name ?? "");
        entries.push({
          id: `${id}/${doc._id}.${page._id}`,
          uuid: `Compendium.${id}.JournalEntry.${doc._id}.JournalEntryPage.${page._id}`,
          pack: id,
          book,
          kind,
          name: pageName,
          title: norm(entryName) === norm(pageName) ? pageName : `${entryName} › ${pageName}`,
          path: [...pathOf(doc.folder), entryName],
          doc: page,
          words: norm(plain(html || page.system?.description?.value))
        });
      }
    }
  }
  return entries;
}

/** A leave-out line that names its book: `<package or pack id>: <name>`. */
const SCOPED = /^([a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)?)\s*:\s*(.+)$/;

/**
 * The `rulebookLeaveOut` lines as rules: a plain name leaves out what it names in every book; a
 * line led by a package or pack id the world has and a colon (`dnd-arcana-unleashed: Chapter 5`)
 * leaves it out of that book alone, since books share folder names (two books' "Chapter 5").
 * A line whose lead is no known id is a plain name ("Appendix B: Creature Stat Blocks").
 * @param {string[]} lines
 * @param {Iterable<string>} ids  the package and pack ids the world has
 */
export function leaveOutRules(lines, ids) {
  const known = new Set(ids);
  const names = new Set();
  const scoped = new Map();
  for (const line of lines ?? []) {
    const m = SCOPED.exec(String(line).trim());
    if (m && known.has(m[1])) {
      if (!scoped.has(m[1])) scoped.set(m[1], new Set());
      scoped.get(m[1]).add(norm(m[2]));
    } else {
      names.add(norm(line));
    }
  }
  return { names, scoped };
}

/**
 * Whether an entry is left out by name: its own, or any folder or entry above it, by a plain rule
 * or one scoped to its pack or its package. A bare Set is the plain names alone.
 */
export function leftOut(entry, rules) {
  const { names, scoped } = rules instanceof Set ? { names: rules, scoped: new Map() } : rules;
  const words = [entry.name, ...entry.path].map(norm);
  const pkg = String(entry.pack ?? "").split(".")[0];
  const sets = [names, scoped.get(entry.pack), scoped.get(pkg)].filter(s => s?.size);
  return sets.some(set => words.some(w => set.has(w)));
}

/**
 * What the loaded entries say about each other: the item each uuid is, which class, subclass,
 * species or background grants a feature (and at what level), the spell lists a spell is on, and
 * each class's subclasses.
 */
export function crossIndex(entries) {
  const byUuid = new Map(entries.map(e => [e.uuid, e]));
  const grantedBy = new Map();
  const spellLists = new Map();
  const subclasses = new Map();
  for (const e of entries) {
    const sys = e.doc?.system ?? {};
    if (["class", "subclass", "species", "background"].includes(e.kind)) {
      for (const adv of advancementOf(e.doc)) {
        if (adv?.type !== "ItemGrant") continue;
        for (const item of adv.configuration?.items ?? []) {
          const uuid = typeof item === "string" ? item : item?.uuid;
          if (!uuid) continue;
          if (!grantedBy.has(uuid)) grantedBy.set(uuid, []);
          grantedBy.get(uuid).push({ name: e.name, level: num(adv.level) });
        }
      }
    }
    if (e.kind === "subclass" && sys.classIdentifier) {
      const key = String(sys.classIdentifier);
      if (!subclasses.has(key)) subclasses.set(key, []);
      subclasses.get(key).push(e);
    }
    if (e.kind === "spell list") {
      const list = { name: e.name.replace(/\s+Spell List$/i, ""), type: sys.type };
      for (const uuid of sys.spells ?? []) {
        if (!spellLists.has(uuid)) spellLists.set(uuid, []);
        spellLists.get(uuid).push(list);
      }
    }
  }
  return { byUuid, grantedBy, spellLists, subclasses };
}

const advancementOf = doc => {
  const adv = doc?.system?.advancement;
  return Array.isArray(adv) ? adv : Object.values(adv ?? {});
};

/* -------------------------------------------- */
/*  Search                                      */
/* -------------------------------------------- */

/** An entry's score for a query, 0 for no match: the name first, the folders next, the text last. */
export function scoreOf(entry, phrase, terms) {
  const name = norm(entry.name);
  const where = norm(entry.path.join(" "));
  // A term matches the start of a word: "grapple" finds "grappled", "elf" never "itself".
  const has = (text, t) => ` ${text}`.includes(` ${t}`);
  const inName = terms.filter(t => has(name, t));
  const inWhere = terms.filter(t => has(where, t));
  const inText = terms.filter(t => has(entry.words, t));
  const found = new Set([...inName, ...inWhere, ...inText]);
  if (found.size < terms.length) return 0;
  let score = 0;
  if (name === phrase) score += 100;
  else if (name.startsWith(phrase)) score += 60;
  else if (` ${name} `.includes(` ${phrase} `)) score += 45;
  score += (inName.length / terms.length) * 30;
  score += inWhere.length * 4;
  score += (inText.length / terms.length) * 8;
  if (terms.length > 1 && ` ${entry.words} `.includes(` ${phrase} `)) score += 6;
  // An item states its rule; a page usually tells about it.
  if (entry.kind !== "rules") score += 1;
  return score;
}

/** The best entries for a query, every term required somewhere. */
export function searchShelf(entries, query, { kind = null, limit = SEARCH_LIMIT } = {}) {
  const phrase = norm(query);
  const terms = termsOf(query);
  if (!terms.length) return { hits: [], total: 0 };
  const scored = [];
  for (const e of entries) {
    if (kind && e.kind !== kind) continue;
    const s = scoreOf(e, phrase, terms);
    if (s > 0) scored.push([s, e]);
  }
  scored.sort(
    (a, b) => b[0] - a[0] || a[1].name.length - b[1].name.length || a[1].id.localeCompare(b[1].id)
  );
  // A book that carries one item twice (the Handbook's four Ropes) shows it once.
  const seen = new Set();
  const unique = scored.filter(([, e]) => {
    const key = `${e.kind}|${norm(e.title)}|${e.book}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { hits: unique.slice(0, limit).map(([, e]) => e), total: unique.length };
}

const FEAT_KINDS = {
  origin: "origin feat",
  general: "general feat",
  fightingStyle: "fighting style feat",
  epicBoon: "epic boon feat"
};

/** The one-line hint a search result carries. */
export function hintOf(entry, index) {
  const sys = entry.doc?.system ?? {};
  switch (entry.kind) {
    case "spell":
      return spellLevel(sys);
    case "feature": {
      const by = index?.grantedBy.get(entry.uuid)?.[0];
      if (by) return `${by.name} feature${by.level ? `, level ${by.level}` : ""}`;
      return entry.path.length ? `feature, ${entry.path.join(" › ")}` : "feature";
    }
    case "subclass":
      return sys.classIdentifier ? `${humanise(sys.classIdentifier)} subclass` : "subclass";
    case "feat":
      return FEAT_KINDS[sys.type?.subtype] ?? "feat";
    case "equipment":
      return humanise(entry.doc?.type).toLowerCase();
    case "rules":
    case "spell list":
      return [entry.kind, entry.path.join(" › ")].filter(Boolean).join(", ");
    default:
      return entry.kind;
  }
}

/** The search's answer as the model reads it. */
export function searchText(query, { hits, total }, index) {
  if (!hits.length)
    return `Nothing in the rulebooks matches "${query}". Try the exact name, another word or fewer words.`;
  const head =
    total > hits.length
      ? `The best ${hits.length} of ${total} rulebook entries for "${query}":`
      : `Rulebook entries for "${query}":`;
  const lines = hits.map(e => `- ${e.title} (${hintOf(e, index)}; ${e.book}) id: ${e.id}`);
  return [head, ...lines].join("\n");
}

/* -------------------------------------------- */
/*  Reading                                     */
/* -------------------------------------------- */

const ACTIVATION = {
  action: "action",
  bonus: "bonus action",
  reaction: "reaction",
  minute: "minute",
  hour: "hour",
  day: "day",
  round: "round",
  turn: "turn"
};

const UNITS = { ft: "feet", mi: "miles", m: "metres", km: "kilometres" };

const DURATION = {
  inst: "instantaneous",
  perm: "until dispelled",
  disp: "until dispelled",
  dstr: "until dispelled or triggered",
  spec: "special",
  turn: "turn",
  round: "round",
  minute: "minute",
  hour: "hour",
  day: "day",
  month: "month",
  year: "year"
};

const RECOVERY = {
  lr: "a Long Rest",
  sr: "a Short Rest",
  day: "a day",
  dawn: "dawn",
  dusk: "dusk"
};

const WEAPON_TYPES = {
  simpleM: "simple melee weapon",
  simpleR: "simple ranged weapon",
  martialM: "martial melee weapon",
  martialR: "martial ranged weapon",
  natural: "natural weapon",
  improv: "improvised weapon"
};

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function spellLevel(sys) {
  const school = SCHOOLS[sys.school]?.toLowerCase() ?? "";
  return num(sys.level) ? `level ${sys.level} ${school}`.trim() : `${school} cantrip`.trim();
}

/** A spell's facts in the book's order: casting time, range, area, components, duration. */
export function spellFacts(sys) {
  const lines = [];
  const props = new Set(sys.properties ?? []);
  const act = sys.activation ?? {};
  if (act.type) {
    const n = num(act.value) ?? 1;
    const word = ACTIVATION[act.type] ?? humanise(act.type).toLowerCase();
    let time = ACTIVATION[act.type] ? plural(n, word) : word;
    if (props.has("ritual")) time += " or Ritual";
    if (act.condition) time += `, ${act.condition}`;
    lines.push(`Casting time: ${time}`);
  }
  const range = sys.range ?? {};
  if (num(range.value))
    lines.push(`Range: ${range.value} ${UNITS[range.units] ?? range.units ?? ""}`.trim());
  else if (range.units && range.units !== "spec") lines.push(`Range: ${humanise(range.units)}`);
  else if (range.special) lines.push(`Range: ${range.special}`);
  const tpl = sys.target?.template ?? {};
  if (tpl.type && num(tpl.size))
    lines.push(`Area: ${tpl.size}-${tpl.units === "ft" ? "foot" : (tpl.units ?? "")} ${tpl.type}`);
  const comps = [
    props.has("vocal") ? "V" : "",
    props.has("somatic") ? "S" : "",
    props.has("material") ? "M" : ""
  ].filter(Boolean);
  if (comps.length) {
    const m = sys.materials ?? {};
    const material =
      props.has("material") && m.value
        ? ` (${m.value}${m.consumed ? ", which the spell consumes" : ""})`
        : "";
    lines.push(`Components: ${comps.join(", ")}${material}`);
  }
  const dur = sys.duration ?? {};
  if (dur.units) {
    const n = num(dur.value);
    const word = DURATION[dur.units] ?? humanise(dur.units).toLowerCase();
    let text = n ? plural(n, word) : word;
    if (props.has("concentration")) text = `Concentration, up to ${text}`;
    lines.push(`Duration: ${text}`);
  }
  return lines;
}

function usesLine(sys) {
  const max = sys?.uses?.max;
  if (!max) return "";
  const periods = (sys.uses.recovery ?? [])
    .map(r => RECOVERY[r?.period] ?? humanise(r?.period).toLowerCase())
    .filter(Boolean);
  return `Uses: ${max}${periods.length ? `, regained on ${periods.join(" or ")}` : ""}`;
}

function equipmentFacts(doc) {
  const sys = doc.system ?? {};
  const facts = [];
  const type = WEAPON_TYPES[sys.type?.value] ?? humanise(sys.type?.value ?? doc.type).toLowerCase();
  const armor = doc.type === "equipment" && num(sys.armor?.value) && type !== "shield";
  if (type) facts.push(`Type: ${type}${armor ? " armor" : ""}`);
  if (sys.rarity && !["", "none"].includes(sys.rarity))
    facts.push(`Rarity: ${humanise(sys.rarity).toLowerCase()}`);
  if (sys.attunement === "required" || sys.attunement === 1) facts.push("Requires attunement");
  if (num(sys.price?.value))
    facts.push(`Cost: ${sys.price.value} ${sys.price.denomination ?? "gp"}`);
  if (num(sys.weight?.value)) facts.push(`Weight: ${sys.weight.value} ${sys.weight.units ?? "lb"}`);
  if (doc.type === "weapon") {
    const dmg = part =>
      part && num(part.number) && num(part.denomination)
        ? `${part.number}d${part.denomination}${part.bonus ? ` + ${part.bonus}` : ""} ${(part.types ?? []).join("/")}`.trim()
        : "";
    const base = dmg(sys.damage?.base);
    if (base) facts.push(`Damage: ${base}`);
    const versatile = dmg(sys.damage?.versatile);
    if (versatile && (sys.properties ?? []).includes("ver")) facts.push(`Versatile: ${versatile}`);
    const props = (sys.properties ?? []).map(p => WEAPON_PROPERTIES[p] ?? humanise(p));
    if (props.length) facts.push(`Properties: ${props.join(", ")}`);
    if (num(sys.range?.value))
      facts.push(
        `Range: ${sys.range.value}${num(sys.range.long) ? `/${sys.range.long}` : ""} ${sys.range.units ?? "ft"}`
      );
    if (sys.mastery) facts.push(`Mastery: ${humanise(sys.mastery)}`);
  }
  if (doc.type === "equipment" && num(sys.armor?.value)) {
    const shield = sys.type?.value === "shield";
    const dex =
      sys.armor?.dex === 0
        ? ""
        : num(sys.armor?.dex)
          ? ` + Dex modifier (max ${sys.armor.dex})`
          : " + Dex modifier";
    facts.push(`Armor Class: ${shield ? "+" : ""}${sys.armor.value}${shield ? "" : dex}`);
    if (num(sys.strength)) facts.push(`Strength: ${sys.strength}`);
    if ((sys.properties ?? []).includes("stealthDisadvantage")) facts.push("Stealth: Disadvantage");
  }
  return facts;
}

const scaleText = v => {
  if (v === null || typeof v !== "object") return String(v ?? "");
  if (v.value !== undefined && v.value !== null) return String(v.value);
  if (num(v.faces)) return `${num(v.number) ? v.number : ""}d${v.faces}`;
  if (num(v.distance?.value)) return `${v.distance.value} ft`;
  return "";
};

/** A class's or subclass's progression: the features it grants by level and its scale values. */
function progression(doc, index, nameOf) {
  const lines = [];
  const byLevel = new Map();
  let subclassAt = null;
  const add = (level, names) => {
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(...names);
  };
  for (const adv of advancementOf(doc)) {
    const level = num(adv?.level);
    if (adv?.type === "Subclass" && level) subclassAt = level;
    if (adv?.type === "AbilityScoreImprovement" && level)
      add(level, [adv.title || "Ability Score Improvement"]);
    if (adv?.type !== "ItemGrant" || !level) continue;
    const names = (adv.configuration?.items ?? [])
      .map(i => (typeof i === "string" ? i : i?.uuid))
      .map(uuid => index.byUuid.get(uuid)?.name ?? nameOf(uuid))
      .filter(Boolean);
    add(level, names);
  }
  if (subclassAt) add(subclassAt, ["a subclass"]);
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  if (levels.length) {
    lines.push("Features by level:");
    for (const l of levels) lines.push(`- Level ${l}: ${byLevel.get(l).join(", ")}`);
  }
  const scales = advancementOf(doc).filter(a => a?.type === "ScaleValue" && a.configuration?.scale);
  if (scales.length) {
    lines.push("", "Scale values:");
    for (const s of scales) {
      const steps = Object.entries(s.configuration.scale)
        .map(([l, v]) => [Number(l), scaleText(v)])
        .filter(([l, v]) => Number.isFinite(l) && v)
        .sort((a, b) => a[0] - b[0])
        .map(([l, v]) => `level ${l}: ${v}`);
      if (steps.length)
        lines.push(`- ${s.title || humanise(s.configuration.identifier)}: ${steps.join("; ")}`);
    }
  }
  return lines;
}

/** The features a subclass, species or background grants, each with its text, while they fit. */
function grantedTexts(doc, index, md) {
  const out = [];
  let used = 0;
  const grants = advancementOf(doc)
    .filter(a => a?.type === "ItemGrant")
    .sort((a, b) => (num(a.level) ?? 0) - (num(b.level) ?? 0));
  for (const adv of grants) {
    for (const i of adv.configuration?.items ?? []) {
      const e = index.byUuid.get(typeof i === "string" ? i : i?.uuid);
      if (!e) continue;
      const level = num(adv.level);
      const text = md(e.doc?.system?.description?.value, 2);
      const head = `## ${e.name}${level ? ` (level ${level})` : ""}`;
      if (used + text.length > INLINE_GRANTS_CHARS) {
        out.push(`${head}\n(read it by its id: ${e.id})`);
      } else {
        used += text.length;
        out.push(text ? `${head}\n\n${text}` : head);
      }
    }
  }
  return out;
}

/**
 * One entry rendered whole, as Markdown.
 * @param {object} entry
 * @param {{ index: object, nameOf: (uuid: string) => string | null,
 *   embed: (uuid: string) => string | null }} ctx
 */
export function renderEntry(entry, { index, nameOf, embed }) {
  const md = (html, offset = 1) =>
    htmlToMarkdown(html, { nameOf, embed, secrets: false, headingOffset: offset });
  const doc = entry.doc ?? {};
  const sys = doc.system ?? {};
  const where = entry.path.length ? ` (${entry.path.join(" › ")})` : "";
  const what = ["rules", "spell list"].includes(entry.kind) ? entry.kind : hintOf(entry, index);
  const parts = [`# ${entry.title}`, `${humanise(what)}. From ${entry.book}${where}.`];
  const facts = [];
  const tail = [];
  let body = "";

  switch (entry.kind) {
    case "spell": {
      facts.push(...spellFacts(sys));
      const lists = index.spellLists.get(entry.uuid) ?? [];
      const classes = [...new Set(lists.filter(l => l.type === "class").map(l => l.name))];
      const granted = [...new Set(lists.filter(l => l.type !== "class").map(l => l.name))];
      if (classes.length) facts.push(`On the spell lists of: ${classes.join(", ")}`);
      if (granted.length) facts.push(`Also among: ${granted.join(", ")}`);
      body = md(sys.description?.value);
      break;
    }
    case "class": {
      body = md(sys.description?.value);
      tail.push(...progression(doc, index, nameOf));
      const subs = index.subclasses.get(String(sys.identifier ?? "")) ?? [];
      if (subs.length) {
        const byBook = new Map();
        for (const s of subs) {
          if (!byBook.has(s.book)) byBook.set(s.book, []);
          byBook.get(s.book).push(s.name);
        }
        tail.push(
          "",
          `Subclasses in the table's books: ${[...byBook].map(([b, n]) => `${n.join(", ")} (${b})`).join("; ")}`
        );
      }
      break;
    }
    case "subclass":
    case "species":
    case "background": {
      body = md(sys.description?.value);
      if (entry.kind === "subclass") tail.push(...progression(doc, index, nameOf));
      const granted = grantedTexts(doc, index, md);
      if (granted.length) tail.push("", granted.join("\n\n"));
      break;
    }
    case "feature":
    case "feat": {
      const by = index.grantedBy.get(entry.uuid) ?? [];
      if (by.length)
        facts.push(
          `Granted by: ${by.map(b => `${b.name}${b.level ? ` at level ${b.level}` : ""}`).join("; ")}`
        );
      const pre = [];
      if (num(sys.prerequisites?.level)) pre.push(`level ${sys.prerequisites.level}+`);
      if (sys.requirements) pre.push(String(sys.requirements));
      if (pre.length) facts.push(`Prerequisite: ${pre.join(", ")}`);
      if (sys.prerequisites?.repeatable) facts.push("Repeatable");
      const uses = usesLine(sys);
      if (uses) facts.push(uses);
      body = md(sys.description?.value);
      break;
    }
    case "equipment": {
      facts.push(...equipmentFacts(doc));
      body = md(sys.description?.value);
      break;
    }
    case "facility": {
      if (num(sys.level)) facts.push(`Level: ${sys.level}`);
      if (sys.type?.value) facts.push(`Type: ${humanise(sys.type.value).toLowerCase()} facility`);
      body = md(sys.description?.value);
      break;
    }
    case "spell list": {
      const intro = md(sys.description?.value);
      const groups = new Map();
      for (const uuid of sys.spells ?? []) {
        const e = index.byUuid.get(uuid);
        const name = e?.name ?? nameOf(uuid);
        if (!name) continue;
        const level = e ? (num(e.doc?.system?.level) ?? 0) : -1;
        if (!groups.has(level)) groups.set(level, []);
        groups.get(level).push(name);
      }
      const lines = [...groups.keys()]
        .sort((a, b) => (a < 0) - (b < 0) || a - b)
        .map(l => {
          const label = l < 0 ? "Other" : l === 0 ? "Cantrips" : `Level ${l}`;
          return `- ${label}: ${groups
            .get(l)
            .sort((a, b) => a.localeCompare(b))
            .join(", ")}`;
        });
      body = [intro, lines.length ? `Spells by level:\n${lines.join("\n")}` : ""]
        .filter(Boolean)
        .join("\n\n");
      break;
    }
    default:
      body = md(doc.text?.content ?? sys.description?.value);
  }

  if (facts.length) parts.push(facts.join("\n"));
  if (body) parts.push(body);
  if (tail.length) parts.push(tail.join("\n").trim());
  return parts.filter(Boolean).join("\n\n");
}

/** A read's text under the cap, cut at a line when it runs over. */
export function capped(text, limit = READ_LIMIT_CHARS) {
  if (text.length <= limit) return text;
  const cut = text.lastIndexOf("\n", limit);
  return `${text.slice(0, cut > limit / 2 ? cut : limit).trimEnd()}\n\n(The entry runs on past this point.)`;
}

/* -------------------------------------------- */
/*  The tools                                   */
/* -------------------------------------------- */

/** The two tools' definitions: the same bytes for every player at the table. */
export function toolDefinitions(books) {
  return [
    {
      name: TOOL_SEARCH,
      description:
        `Search the table's rulebooks (${books.join("; ")}) by name or keywords: classes, subclasses, ` +
        "class and subclass features, species and their traits, backgrounds, feats, spells, the class " +
        "spell lists, equipment, and the rules chapters (conditions, combat, the rules glossary). They " +
        `hold no monsters and no stat blocks. Returns up to ${SEARCH_LIMIT} matches, the best first, ` +
        `each with an id to read in full with ${TOOL_READ}.`,
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "A name (Fireball, Arcane Recovery, Grappled) or a few keywords (wizard subclass, opportunity attack)."
          },
          kind: { type: "string", enum: [...KINDS], description: "Only entries of this kind." }
        },
        required: ["query"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_READ,
      description:
        "Read one rulebook entry in full: a spell's casting time, range, components, duration, " +
        "spell lists and text; a class's traits, features by level and subclasses; a subclass's or " +
        "species' features; a feature's text and the class level that grants it; a feat; an item; a " +
        "rules section.",
      input_schema: {
        type: "object",
        properties: { id: { type: "string", description: `An id from ${TOOL_SEARCH}.` } },
        required: ["id"],
        additionalProperties: false
      }
    }
  ];
}

/**
 * The library: the table's rulebook packs read off the ball's socket on first need and held for
 * `ttlMs` (a pack whose index grows or a new world reads again), each loaded once however many
 * requests wait on it.
 * @param {{ link: { packDocuments: (pack: string, type: string) => Promise<object[]> },
 *   log: object, ttlMs?: number, now?: () => number }} options
 */
export function createLibrary({
  link,
  log,
  ttlMs = 6 * 3600 * 1000,
  now = () => performance.now()
}) {
  const held = new Map();

  function load(world, pack) {
    const id = packIdOf(pack);
    const signature = `${world?.world?.id ?? ""}|${(pack.index ?? []).length}`;
    const h = held.get(id);
    if (h && h.signature === signature && (h.promise || now() - h.at < ttlMs))
      return h.promise ?? Promise.resolve(h.value);
    const book = bookOf(world, pack);
    const promise = link.packDocuments(id, pack.type).then(
      docs => {
        const value = { docs, entries: shelfOf(pack, docs, book) };
        held.set(id, { signature, at: now(), value, promise: null });
        return value;
      },
      err => {
        held.delete(id);
        throw err;
      }
    );
    held.set(id, { signature, at: 0, value: null, promise });
    return promise;
  }

  return {
    /** How many packs are held (for the log). */
    get size() {
      return held.size;
    },

    /**
     * The asker's desk: the table's books (for the tools and the instructions, the same for every
     * player) and a runner for the model's tool calls under the asker's view. Null when the table
     * opens no rulebook to the ball.
     */
    desk(world, user, settings) {
      const table = tableRulebooks(world, settings);
      if (!table.length) return null;
      const configuration = compendiumConfiguration(world);
      const opts = { configuration };
      const mine = table.filter(p => packOpenTo(p, user, opts));
      const mineIds = new Set(mine.map(packIdOf));
      const packsById = new Map((world?.packs ?? []).map(p => [packIdOf(p), p]));
      const leave = leaveOutRules(
        settings?.rulebookLeaveOut,
        [...packsById.keys(), ...(world?.packs ?? []).map(p => p?.packageName)].filter(Boolean)
      );
      const books = [...new Set(table.map(p => bookOf(world, p)))];
      const definitions = toolDefinitions(books);

      /** Every open rulebook loaded: its entries (left-out ones dropped) and their cross-index. */
      async function shelf() {
        const settled = await Promise.allSettled(mine.map(p => load(world, p)));
        const entries = [];
        const loaded = new Map();
        settled.forEach((r, i) => {
          const id = packIdOf(mine[i]);
          if (r.status === "fulfilled") {
            loaded.set(id, r.value);
            for (const e of r.value.entries) if (!leftOut(e, leave)) entries.push(e);
          } else {
            log.warn("rulebooks: a pack could not be read", { pack: id, error: r.reason?.message });
          }
        });
        return {
          entries,
          loaded,
          index: crossIndex(entries),
          missing: settled.some(r => r.status === "rejected")
        };
      }

      /** A pack the asker may read for a name or an embed: open to them and active in the world. */
      const openPack = id => {
        const p = packsById.get(id);
        return p && READABLE_TYPES.includes(p.type) && packOpenTo(p, user, opts) ? p : null;
      };

      /** The embedded packs a text reaches (two levels down), loaded before it is rendered. */
      async function loadEmbeds(html, loaded) {
        let frontier = [String(html ?? "")];
        for (let depth = 0; depth < 2 && frontier.length; depth++) {
          const want = new Set();
          for (const h of frontier) {
            for (const m of h.matchAll(/@Embed\[(Compendium\.[^\s\]]{1,300})/g)) {
              const u = parseCompendiumUuid(m[1]);
              if (u?.type === "JournalEntry" && !loaded.has(u.pack) && openPack(u.pack))
                want.add(u.pack);
            }
          }
          const next = [];
          for (const id of want) {
            try {
              const value = await load(world, openPack(id));
              loaded.set(id, value);
              for (const doc of value.docs)
                for (const page of doc.pages ?? []) next.push(String(page.text?.content ?? ""));
            } catch (err) {
              log.warn("rulebooks: an embedded pack could not be read", {
                pack: id,
                error: err?.message
              });
            }
          }
          frontier = next.filter(h => h.includes("@Embed["));
        }
      }

      /** The document a compendium uuid names in the loaded packs, or null. */
      function resolve(uuid, loaded) {
        const u = parseCompendiumUuid(uuid);
        if (!u || !openPack(u.pack)) return null;
        const pack = loaded.get(u.pack);
        let doc = pack?.docs.find(d => d?._id === u.id) ?? null;
        for (const e of u.embedded) {
          const key = e.type === "JournalEntryPage" ? "pages" : e.type === "Item" ? "items" : null;
          doc = key ? ((doc?.[key] ?? []).find(d => d?._id === e.id) ?? null) : null;
        }
        if (doc) return { u, doc };
        // A pack not loaded still names its documents in the payload's index.
        if (!u.embedded.length) {
          const hit = (packsById.get(u.pack)?.index ?? []).find(i => i?._id === u.id);
          if (hit) return { u, doc: { name: hit.name } };
        }
        return null;
      }

      async function run(block, onLookup = () => {}) {
        const input = block?.input ?? {};
        if (block?.name === TOOL_SEARCH) {
          const query = String(input.query ?? "")
            .slice(0, QUERY_CHARS)
            .trim();
          if (!query) return { content: "Give the search a name or a few words.", isError: true };
          const kind = KINDS.includes(input.kind) ? input.kind : null;
          if (!mine.length)
            return {
              content: "None of the table's rulebooks is open to this player.",
              isError: false
            };
          onLookup({ action: "search", query });
          const { entries, index, missing } = await shelf();
          const text = searchText(query, searchShelf(entries, query, { kind }), index);
          return {
            content: missing ? `${text}\n(Some of the books could not be opened just now.)` : text,
            isError: false
          };
        }
        if (block?.name === TOOL_READ) {
          const id = String(input.id ?? "").trim();
          const pack = id.slice(0, id.indexOf("/"));
          if (!mineIds.has(pack))
            return {
              content: `There is no rulebook entry "${id}" open to this player.`,
              isError: true
            };
          const { entries, loaded, index } = await shelf();
          const entry = entries.find(e => e.id === id);
          if (!entry)
            return {
              content: `There is no rulebook entry "${id}" open to this player.`,
              isError: true
            };
          onLookup({ action: "read", name: entry.title, book: entry.book });
          await loadEmbeds(
            entry.doc?.text?.content ?? entry.doc?.system?.description?.value,
            loaded
          );
          const nameOf = uuid => {
            const r = resolve(uuid, loaded);
            return r?.doc?.name ?? null;
          };
          const embed = uuid => {
            const r = resolve(uuid, loaded);
            if (r?.u.type !== "JournalEntry") return null; // an actor's stat block, a table, a picture
            const page = r.doc;
            return ["text", "rule"].includes(page?.type) ? String(page.text?.content ?? "") : null;
          };
          return { content: capped(renderEntry(entry, { index, nameOf, embed })), isError: false };
        }
        return { content: `There is no tool "${block?.name}".`, isError: true };
      }

      return { books, definitions, open: mine.length, run };
    }
  };
}
