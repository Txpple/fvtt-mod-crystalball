/**
 * The world's HTML as Markdown the model reads cheaply: journal pages, clue texts and item
 * descriptions. Two passes. First Foundry's enricher syntax, which is plain text in the stored
 * HTML (`@UUID[...]{Name}`, `[[/check ...]]`, `&Reference[...]`), is turned into the words a
 * player would read on the rendered page. Then turndown converts the HTML: ATX headings, `-`
 * bullets, images as their alt text, links as their text, `<script>` and `<style>` dropped, and
 * Foundry's secret blocks dropped unless the reader would see them. Pure and deterministic.
 */

import TurndownService from "turndown";
import { ABILITY_NAMES, SKILL_NAMES } from "./labels.js";

/* -------------------------------------------- */
/*  Enrichers                                   */
/* -------------------------------------------- */

/**
 * The names a payload can resolve an unlabeled `@UUID[Type.id]` to: world documents and, one
 * level down, embedded ones (a journal page, an actor's item). Compendium links have no name in
 * the payload and are dropped.
 */
export function uuidNamer(world) {
  const collections = {
    Actor: world?.actors,
    Item: world?.items,
    JournalEntry: world?.journal,
    Scene: world?.scenes,
    RollTable: world?.tables,
    Macro: world?.macros,
    Playlist: world?.playlists,
    Cards: world?.cards,
    User: world?.users,
    Folder: world?.folders
  };
  const embedded = {
    JournalEntryPage: "pages",
    Item: "items",
    ActiveEffect: "effects",
    PlaylistSound: "sounds"
  };
  return uuid => {
    const parts = String(uuid ?? "").split(".");
    if (parts.length < 2 || parts.length % 2) return null;
    let doc = (collections[parts[0]] ?? []).find?.(d => d._id === parts[1]);
    for (let i = 2; doc && i < parts.length; i += 2) {
      const key = embedded[parts[i]];
      doc = key ? (doc[key] ?? []).find(d => d._id === parts[i + 1]) : null;
    }
    return doc?.name ?? null;
  };
}

/** The words of a roll command (`[[/check ability=cha skill=itm dc=15]]`) as a page shows them. */
function rollWords(command, args) {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const named = {};
  const loose = [];
  for (const t of tokens) {
    const eq = t.indexOf("=");
    if (eq > 0) named[t.slice(0, eq).toLowerCase()] = t.slice(eq + 1);
    else loose.push(t);
  }
  const cmd = command.toLowerCase();
  if (["check", "skill", "tool", "save", "ability"].includes(cmd)) {
    const pick = (map, ...keys) =>
      keys.map(k => named[k]).find(Boolean) ?? loose.find(t => map[t.toLowerCase()]) ?? null;
    const ability = pick(ABILITY_NAMES, "ability");
    const skill = pick(SKILL_NAMES, "skill");
    const dc = named.dc ?? loose.find(t => /^\d+$/.test(t));
    const abilityName = ability ? (ABILITY_NAMES[ability.toLowerCase()] ?? ability) : "";
    const skillName = skill ? (SKILL_NAMES[skill.toLowerCase()] ?? skill) : "";
    const what = skillName
      ? abilityName
        ? `${abilityName} (${skillName})`
        : skillName
      : abilityName;
    const kind = cmd === "save" ? "saving throw" : "check";
    return [dc ? `DC ${dc}` : "", what, kind].filter(Boolean).join(" ");
  }
  if (cmd === "damage" || cmd === "heal") {
    // The formula is the leading run of dice, numbers and operators; the words after it are types.
    const words = [...loose];
    const parts = [];
    while (words.length && /^[\d+\-*/()dkhlDKHL@.]+$/.test(words[0])) parts.push(words.shift());
    const formula = named.formula ?? parts.join(" ");
    const type = named.type ?? words.filter(t => t !== "average" && t !== "extended").join(" ");
    return [formula, type].filter(Boolean).join(" ");
  }
  // /r, /roll, /gmr, /br, /sr and the like: the formula, without its #flavour.
  return args.split("#")[0].trim();
}

/*
 * The enrichers' patterns. Every inner part excludes both brackets (or both braces) and is
 * capped in length, so text full of unclosed `[[` or `@UUID[` (a player's own biography is world
 * text) is scanned in linear time instead of rescanning to the end of the page from every
 * opening bracket.
 */
const INNER = "([^\\[\\]]{0,500})";
const LABEL = "(?:\\{([^{}]{0,500})\\})?";
const DOCUMENT_LINK = new RegExp(
  `@(UUID|Actor|Item|JournalEntry|Scene|RollTable|Macro|Compendium)\\[${INNER}\\]${LABEL}`,
  "g"
);
const DND_LINK = new RegExp(
  `@(Check|Save|Skill|Tool|Damage|Attack|Lookup)\\[${INNER}\\]${LABEL}`,
  "g"
);
const REFERENCE = new RegExp(`&(?:amp;)?Reference\\[${INNER}\\]${LABEL}`, "g");
const EMBED = new RegExp(`@Embed\\[${INNER}\\]${LABEL}`, "g");
const LOOKUP = new RegExp(`\\[\\[\\s{0,20}lookup\\b${INNER}\\]\\]${LABEL}`, "gi");
const COMMAND = new RegExp(`\\[\\[\\/(\\w{1,32})${INNER}\\]\\]${LABEL}`, "g");
const INLINE_ROLL = new RegExp(`\\[\\[${INNER}\\]\\]${LABEL}`, "g");

/**
 * Foundry's enricher syntax as plain words, on the stored HTML before conversion.
 * @param {string} html
 * @param {(uuid: string) => string | null} [nameOf]  resolves an unlabeled `@UUID[...]`
 */
export function enrichToText(html, nameOf = () => null) {
  let out = String(html ?? "");
  // @UUID[...]{Label} and the older @Actor[...]{Label}, @Compendium[...]{Label} and friends.
  out = out.replace(DOCUMENT_LINK, (_m, kind, target, label) => {
    if (label !== undefined) return label;
    if (kind === "Compendium") return "";
    const uuid = kind === "UUID" ? target.split("#")[0] : `${kind}.${target}`;
    return nameOf(uuid) ?? "";
  });
  // dnd5e's @Check[...]{Label}, @Save[...], @Damage[...]: the label, or the bracket's words.
  out = out.replace(DND_LINK, (_m, _kind, inner, label) =>
    label !== undefined ? label : inner.replace(/[|]/g, " ")
  );
  // &Reference[Charmed apply=false]{Label}: the label, or the reference's first word. Stored
  // HTML usually carries the ampersand encoded.
  out = out.replace(REFERENCE, (_m, inner, label) => {
    if (label !== undefined) return label;
    const name = inner.split(/\s+/).find(t => !t.includes("=")) ?? "";
    const plain = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
    return plain ? plain.charAt(0).toUpperCase() + plain.slice(1) : "";
  });
  // @Embed[...] places a picture or a table the reader cannot be given here.
  out = out.replace(EMBED, "");
  // [[lookup @scale...]] reads a computed value the raw world does not hold: dropped.
  out = out.replace(LOOKUP, (_m, _inner, label) => label ?? "");
  // [[/command args]]{Label}: the label, or the command's words.
  out = out.replace(COMMAND, (_m, cmd, args, label) =>
    label !== undefined ? label : rollWords(cmd, args.trim())
  );
  // [[1d6 + 2]]{Label}: an inline roll, as its formula.
  out = out.replace(INLINE_ROLL, (_m, formula, label) => label ?? formula.trim());
  return out;
}

/* -------------------------------------------- */
/*  HTML to Markdown                            */
/* -------------------------------------------- */

const converters = new Map();

/** A turndown converter for one combination of options, built once. */
function converter({ secrets, headingOffset }) {
  const key = `${secrets ? 1 : 0}:${headingOffset}`;
  if (converters.has(key)) return converters.get(key);
  const td = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    hr: "---"
  });
  // Markdown escapes (`1\.`, `\*`) are for a renderer; the model reads the text, and every
  // backslash is a token spent on nothing.
  td.escape = text => text;
  td.remove(["script", "style", "noscript", "iframe"]);
  if (!secrets) {
    td.addRule("secret", {
      filter: node =>
        node.nodeName === "SECTION" && /\bsecret\b/.test(node.getAttribute?.("class") ?? ""),
      replacement: () => ""
    });
  }
  // A page's own headings sit under the gaze's (layer, entry, page), so they are pushed down.
  td.addRule("heading", {
    filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
    replacement: (content, node) => {
      const level = Math.min(6, Number(node.nodeName.charAt(1)) + headingOffset);
      const text = content.replace(/\s+/g, " ").trim();
      return text ? `\n\n${"#".repeat(level)} ${text}\n\n` : "";
    }
  });
  td.addRule("image", {
    filter: "img",
    replacement: (_content, node) => {
      const alt = (node.getAttribute("alt") ?? "").replace(/\s+/g, " ").trim();
      return alt ? `(picture: ${alt})` : "";
    }
  });
  // Links carry Foundry routes and file paths the model has no use for: their words alone.
  td.addRule("link", { filter: "a", replacement: content => content });
  td.addRule("listItem", {
    filter: "li",
    replacement: (content, node, options) => {
      const body = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n  ");
      const parent = node.parentNode;
      let prefix = `${options.bulletListMarker} `;
      if (parent?.nodeName === "OL") {
        const start = Number(parent.getAttribute("start") ?? 1);
        prefix = `${start + Array.prototype.indexOf.call(parent.children, node)}. `;
      }
      return prefix + body + (node.nextSibling && !/\n$/.test(body) ? "\n" : "");
    }
  });
  td.addRule("tableCell", {
    filter: ["th", "td"],
    replacement: (content, node) => {
      const text = content.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
      return `${node.previousElementSibling ? " " : "| "}${text} |`;
    }
  });
  td.addRule("tableRow", { filter: "tr", replacement: content => `\n${content}` });
  td.addRule("tableSection", {
    filter: ["thead", "tbody", "tfoot"],
    replacement: content => content
  });
  td.addRule("table", { filter: "table", replacement: content => `\n\n${content.trim()}\n\n` });
  converters.set(key, td);
  return td;
}

/**
 * Stored HTML as Markdown.
 * @param {string} html
 * @param {{ nameOf?: (uuid: string) => string | null, secrets?: boolean, headingOffset?: number }} [options]
 *   `secrets`: keep `<section class="secret">` blocks (the reader is the document's owner);
 *   `headingOffset`: levels added to the page's own headings.
 */
export function htmlToMarkdown(html, { nameOf, secrets = false, headingOffset = 0 } = {}) {
  const source = enrichToText(html, nameOf);
  if (!source.trim()) return "";
  const md = converter({ secrets, headingOffset }).turndown(source);
  return md
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
