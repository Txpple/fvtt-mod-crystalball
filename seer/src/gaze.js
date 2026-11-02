/**
 * The gaze: what the ball knows for one user at one moment, built from the live world payload in
 * four layers, always in this order (the contract's *The gaze*):
 *
 *   1. instructions  the standing text and the DM's table notes (the same for everyone)
 *   2. lore          every journal page every player can observe (the same for every player)
 *   3. party         the user's party: members, stash, Clue Board record (the same for a party)
 *   4. own           the pages only this user observes, then each character they own
 *
 * Each layer is one cached system block, so the order runs from what the most people share to what
 * one person alone has, and every layer is deterministic: stable sorts by folder path, sort key,
 * name and id; no timestamps, no counters, no ids in the text. One changed byte in a layer misses
 * the cache from that layer on, so anything that varies per call stays out. Pure: the payload, a
 * user id and the module's settings in, the layers and their meta out. Never written to disk.
 */

import { createHash } from "node:crypto";
import { INSTRUCTIONS_VERSION, instructionsLayer } from "./instructions.js";
import { CURRENCIES } from "./labels.js";
import { htmlToMarkdown, uuidNamer } from "./markdown.js";
import {
  canObserve,
  defaultLevelOf,
  everyoneObserves,
  isGM,
  LEVELS,
  ownsExplicitly,
  ROLES,
  seesSecrets
} from "./permission.js";
import {
  bySortNameId,
  classNames,
  curatedSheet,
  itemFace,
  levelOf,
  memberLine,
  num
} from "./sheet.js";

export const LAYER_NAMES = Object.freeze(["instructions", "lore", "party", "own"]);

export const CLUEBOARD_ID = "fvtt-mod-clueboard";

export const CLUE_TYPE = "fvtt-mod-clueboard.clue";

/** The contract's token estimate: four characters a token. */
export const estimateTokens = text => Math.ceil(String(text ?? "").length / 4);

export const sha256 = text =>
  createHash("sha256")
    .update(String(text ?? ""))
    .digest("hex");

/* -------------------------------------------- */
/*  Order                                       */
/* -------------------------------------------- */

/** A folder's ancestry from the root, guarded against a cycle in broken data. */
function folderChain(foldersById, id) {
  const chain = [];
  const seen = new Set();
  let folder = id ? foldersById.get(id) : null;
  while (folder && !seen.has(folder._id)) {
    seen.add(folder._id);
    chain.unshift(folder);
    folder = folder.folder ? foldersById.get(folder.folder) : null;
  }
  return chain;
}

const tuple = (rank, doc) => [
  rank,
  num(doc.sort) ?? 0,
  String(doc.name ?? ""),
  String(doc._id ?? "")
];

function compareTuples(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    for (let j = 0; j < 4; j++) {
      if (x[j] === y[j]) continue;
      return typeof x[j] === "number" ? x[j] - y[j] : x[j].localeCompare(y[j]);
    }
  }
  return 0;
}

/**
 * Journal entries in folder order: each folder level by its sort, name and id, a folder's
 * entries after its subfolders (as Foundry's sidebar draws them), then the entry's own sort, name
 * and id.
 */
export function sortEntries(entries, folders = []) {
  const foldersById = new Map(folders.map(f => [f._id, f]));
  const keyed = entries.map(e => ({
    e,
    key: [...folderChain(foldersById, e.folder).map(f => tuple(0, f)), tuple(1, e)]
  }));
  return keyed.sort((a, b) => compareTuples(a.key, b.key)).map(k => k.e);
}

/* -------------------------------------------- */
/*  Journal pages                               */
/* -------------------------------------------- */

/** A page's text as Markdown, or its title line's companion for a picture, a video or a PDF. */
function pageBody(page, { nameOf, secrets, headingOffset }) {
  switch (page.type) {
    case "text": {
      const md =
        page.text?.format === 2 && typeof page.text?.markdown === "string"
          ? page.text.markdown.trim()
          : htmlToMarkdown(page.text?.content ?? "", { nameOf, secrets, headingOffset });
      return md;
    }
    case "image": {
      const caption = String(page.image?.caption ?? "").trim();
      return caption ? `(picture: ${caption})` : "(picture)";
    }
    case "video":
      return "(video)";
    case "pdf":
      return "(PDF document)";
    default:
      return `(${page.type} page)`;
  }
}

/**
 * The journal pages a user observes, split into those every player observes (lore) and those
 * the user alone, or a few, observe (own), each grouped by entry in folder order.
 */
export function journalFor(world, user, { gmGaze = "player", nameOf } = {}) {
  const lore = [];
  const own = [];
  const allSee = isGM(user) && gmGaze === "all";
  for (const entry of sortEntries(world?.journal ?? [], world?.folders ?? [])) {
    if (!canObserve(entry, user, { gmGaze })) continue;
    const shared = [];
    const mine = [];
    for (const page of [...(entry.pages ?? [])].sort(bySortNameId)) {
      if (!canObserve(page, user, { gmGaze, parent: entry })) continue;
      if (everyoneObserves(entry) && everyoneObserves(page, entry)) {
        // The shared layer must read the same for every player, so its secret blocks show only
        // when every player owns the page; an owner's own view of one is the rare cost of that.
        const secrets = allSee || defaultLevelOf(page, entry) >= LEVELS.OWNER;
        shared.push({ page, body: pageBody(page, { nameOf, secrets, headingOffset: 3 }) });
      } else {
        const secrets = seesSecrets(page, user, { gmGaze, parent: entry });
        mine.push({ page, body: pageBody(page, { nameOf, secrets, headingOffset: 4 }) });
      }
    }
    if (shared.length) lore.push({ entry, pages: shared });
    if (mine.length) own.push({ entry, pages: mine });
  }
  return { lore, own };
}

const TRIMMED = "(Only the title fits in the ball's view: the gaze is over its budget.)";

function loreText(lore, trimmed) {
  const out = ["<lore>", "# Shared lore: the journal pages every player can read"];
  if (!lore.length) out.push("No journal page is shared with every player.");
  for (const { entry, pages } of lore) {
    out.push(`## ${entry.name}`);
    for (const { page, body } of pages) {
      out.push(`### ${page.name}`);
      const text = trimmed.has(page) ? TRIMMED : body;
      if (text) out.push(text);
    }
  }
  out.push("</lore>");
  return out.join("\n\n");
}

/* -------------------------------------------- */
/*  The party                                   */
/* -------------------------------------------- */

/** The ids of a group's members: dnd5e 6.x `[{ actor }]`, or older plain ids or uuids. */
export function memberIds(group) {
  const members = group?.system?.members;
  const list = Array.isArray(members) ? members : Array.isArray(members?.ids) ? members.ids : [];
  return list
    .map(m => (typeof m === "string" ? m : (m?.actor ?? m?.id ?? "")))
    .map(id => String(id).replace(/^Actor\./, ""))
    .filter(Boolean);
}

/** The characters a user owns by an explicit grant, by name. */
export const ownedCharacters = (world, user) =>
  (world?.actors ?? [])
    .filter(a => a.type === "character" && ownsExplicitly(a, user?._id))
    .sort(
      (a, b) =>
        String(a.name).localeCompare(String(b.name)) || String(a._id).localeCompare(String(b._id))
    );

/**
 * The user's party: the first Group actor (by name) they can observe whose members include a
 * character they own, or null.
 */
export function partyFor(world, user, { gmGaze = "player" } = {}) {
  const owned = new Set(ownedCharacters(world, user).map(a => a._id));
  if (!owned.size) return null;
  return (
    (world?.actors ?? [])
      .filter(a => a.type === "group" && canObserve(a, user, { gmGaze }))
      .filter(g => memberIds(g).some(id => owned.has(id)))
      .sort(
        (a, b) =>
          String(a.name).localeCompare(String(b.name)) || String(a._id).localeCompare(String(b._id))
      )[0] ?? null
  );
}

const coinLine = currency => {
  const parts = CURRENCIES.filter(c => num(currency?.[c])).map(c => `${currency[c]} ${c}`);
  return parts.length ? parts.join(", ") : "none";
};

/**
 * Clue Board's record on the group (its flags, schema 2), each entry joined to its world Clue
 * item, and the threads with their pinned clues in order. Empty when Clue Board never wrote here.
 */
export function clueBoardOf(world, group) {
  const flags = group?.flags?.[CLUEBOARD_ID];
  const stored = flags?.entries && typeof flags.entries === "object" ? flags.entries : {};
  const itemsById = new Map((world?.items ?? []).map(i => [i._id, i]));
  const actorsById = new Map((world?.actors ?? []).map(a => [a._id, a]));
  const entries = Object.entries(stored)
    .filter(([, e]) => e && typeof e === "object")
    .map(([id, e]) => {
      const item = itemsById.get(id);
      const clue = item?.type === CLUE_TYPE ? item : null;
      const snap = e.snapshot ?? {};
      const readers = Object.values(e.readers ?? {})
        .filter(r => r && typeof r === "object")
        .sort(
          (a, b) =>
            String(a.at ?? "").localeCompare(String(b.at ?? "")) ||
            String(a.actorId).localeCompare(String(b.actorId))
        )
        .map(r => actorsById.get(r.actorId)?.name ?? r.actorName ?? "")
        .filter(Boolean);
      return {
        id,
        name: clue?.name ?? snap.name ?? "",
        kind: clue?.system?.kind ?? e.kind ?? snap.kind ?? "",
        foundAt: clue?.system?.foundAt ?? snap.foundAt ?? "",
        html: clue?.system?.text ?? snap.html ?? "",
        readers: [...new Set(readers)],
        notes: typeof e.notes === "string" ? e.notes : "",
        realDate: String(e.foundIn?.realDate ?? ""),
        pins: e.threads && typeof e.threads === "object" ? e.threads : {}
      };
    })
    .sort(
      (a, b) =>
        a.realDate.localeCompare(b.realDate) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id)
    );
  const threads = Object.entries(flags?.threads ?? {})
    .filter(([, t]) => t && typeof t === "object")
    .map(([id, t]) => ({ ...t, id }))
    .sort(
      (a, b) =>
        (num(a.order) ?? 0) - (num(b.order) ?? 0) ||
        String(a.name ?? "").localeCompare(String(b.name ?? "")) ||
        a.id.localeCompare(b.id)
    )
    .map(t => ({
      name: String(t.name ?? ""),
      question: String(t.question ?? ""),
      status: t.status === "answered" ? "answered" : "open",
      stand: String(t.stand ?? ""),
      clues: entries
        .filter(e => e.pins[t.id])
        .sort(
          (a, b) =>
            (num(a.pins[t.id]?.order) ?? 0) - (num(b.pins[t.id]?.order) ?? 0) ||
            a.name.localeCompare(b.name) ||
            a.id.localeCompare(b.id)
        )
        .map(e => e.name)
    }));
  return { entries, threads };
}

function partyText(world, group, { nameOf }) {
  const out = ["<party>"];
  if (!group) {
    out.push("No party: the asker plays no character in a party the ball can see.", "</party>");
    return { text: out.join("\n\n"), members: 0, clues: 0 };
  }
  out.push(`# The party: ${group.name}`);
  const actorsById = new Map((world?.actors ?? []).map(a => [a._id, a]));
  const members = memberIds(group)
    .map(id => actorsById.get(id))
    .filter(Boolean);
  out.push("## Members");
  out.push(members.length ? members.map(m => `- ${memberLine(m)}`).join("\n") : "No members.");

  out.push("## The stash");
  out.push(`Coin: ${coinLine(group.system?.currency)}.`);
  const byId = new Map((group.items ?? []).map(i => [i._id, i]));
  const stash = [...(group.items ?? [])].sort(bySortNameId).map(i => {
    const qty = num(i.system?.quantity);
    const container = i.system?.container ? byId.get(i.system.container) : null;
    const where = container ? `, in ${itemFace(container).name}` : "";
    return `- ${itemFace(i).name}${qty !== null && qty !== 1 ? ` (${qty})` : ""}${where}`;
  });
  out.push(stash.length ? stash.join("\n") : "Nothing in the stash.");

  const board = clueBoardOf(world, group);
  if (group.flags?.[CLUEBOARD_ID]) {
    out.push("## The Clue Board");
    out.push(
      `${board.entries.length} ${board.entries.length === 1 ? "clue" : "clues"} collected, oldest first.`
    );
    for (const e of board.entries) {
      out.push(`### ${e.name}`);
      const facts = [
        e.kind && `Kind: ${e.kind}.`,
        e.foundAt && `Where found: ${e.foundAt}`,
        `Read by: ${e.readers.length ? e.readers.join(", ") : "nobody yet"}.`
      ].filter(Boolean);
      out.push(facts.join(" "));
      const text = htmlToMarkdown(e.html, { nameOf, secrets: false, headingOffset: 3 });
      if (text) out.push(text);
      if (e.notes.trim()) out.push(`The party's note: ${e.notes.trim()}`);
    }
    if (board.threads.length) {
      out.push("## Threads: the party's questions");
      for (const t of board.threads) {
        out.push(`### ${t.name} (${t.status === "answered" ? "solved" : "unsolved"})`);
        const lines = [
          t.question && `Question: ${t.question}`,
          t.stand && `Where the party stands: ${t.stand}`,
          `Pinned clues, in order: ${t.clues.length ? t.clues.join("; ") : "none yet"}.`
        ].filter(Boolean);
        out.push(lines.join("\n"));
      }
    }
  }
  out.push("</party>");
  return { text: out.join("\n\n"), members: members.length, clues: board.entries.length };
}

/* -------------------------------------------- */
/*  The user's own                              */
/* -------------------------------------------- */

function askerLine(user, gmGaze) {
  if (isGM(user)) {
    const who =
      user.role >= ROLES.GAMEMASTER ? "the Dungeon Master" : "an assistant Dungeon Master";
    return gmGaze === "all"
      ? `The person asking is ${who}, and the ball shows them the whole world, the Dungeon Master's pages included.`
      : `The person asking is ${who}; the ball shows them what the players see, plus what is granted to them by name.`;
  }
  return "The person asking is a player.";
}

function ownText(user, characters, ownPages, { gmGaze, nameOf }) {
  const out = ["<own>", "# Yours alone", askerLine(user, gmGaze)];
  out.push(
    characters.length
      ? `They play: ${characters.map(c => c.name).join(", ")}.`
      : "They play no character, so no sheet is shown."
  );
  if (ownPages.length) {
    out.push("## Journal pages only they can read");
    for (const { entry, pages } of ownPages) {
      out.push(`### ${entry.name}`);
      for (const { page, body } of pages) {
        out.push(`#### ${page.name}`);
        if (body) out.push(body);
      }
    }
  }
  for (const actor of characters) out.push(curatedSheet(actor, { nameOf }));
  out.push("</own>");
  return out.join("\n\n");
}

/* -------------------------------------------- */
/*  The gaze                                    */
/* -------------------------------------------- */

const layer = (name, text) => ({ name, text, hash: sha256(text), estTokens: estimateTokens(text) });

/**
 * Build one user's gaze.
 * @param {object} world     the `world` payload
 * @param {string} userId    the asker's Foundry user id
 * @param {ReturnType<import("./settings.js").moduleSettings>} settings
 * @param {{ budgetTokens?: number, warn?: (message: string, fields?: object) => void }} [options]
 */
export function buildGaze(
  world,
  userId,
  settings,
  { budgetTokens = 120000, warn = () => {} } = {}
) {
  const user = (world?.users ?? []).find(u => u._id === userId);
  if (!user) throw new Error("the user is not in the world");
  const gmGaze = settings?.gmGaze === "all" ? "all" : "player";
  const nameOf = uuidNamer(world);

  const instructions = layer("instructions", instructionsLayer(settings?.tableNotes ?? ""));
  const { lore, own: ownPages } = journalFor(world, user, { gmGaze, nameOf });
  const group = partyFor(world, user, { gmGaze });
  const party = partyText(world, group, { nameOf });
  const characters = ownedCharacters(world, user);
  const own = layer("own", ownText(user, characters, ownPages, { gmGaze, nameOf }));
  const partyLayer = layer("party", party.text);

  // Over budget: the oldest lore pages (lowest sort key within their entries first) give up
  // their text and keep their titles, one at a time, until the gaze fits.
  const trimmed = new Set();
  let loreLayer = layer("lore", loreText(lore, trimmed));
  const total = () =>
    instructions.estTokens + loreLayer.estTokens + partyLayer.estTokens + own.estTokens;
  if (total() > budgetTokens) {
    const before = total();
    const candidates = lore
      .flatMap(({ pages }, entryIndex) => pages.map(p => ({ ...p, entryIndex })))
      .filter(p => p.body && p.page.type === "text")
      .sort(
        (a, b) =>
          (num(a.page.sort) ?? 0) - (num(b.page.sort) ?? 0) ||
          a.entryIndex - b.entryIndex ||
          String(a.page._id).localeCompare(String(b.page._id))
      );
    for (const c of candidates) {
      if (total() <= budgetTokens) break;
      trimmed.add(c.page);
      loreLayer = layer("lore", loreText(lore, trimmed));
    }
    warn("gaze over budget: oldest lore pages cut to their titles", {
      userId,
      budgetTokens,
      before,
      after: total(),
      pagesCut: trimmed.size
    });
  }

  const main = characters[0] ?? null;
  return {
    layers: [instructions, loreLayer, partyLayer, own],
    user: { id: user._id, name: user.name, role: user.role },
    meta: {
      characterName: main?.name ?? null,
      className: main ? classNames(main) : null,
      level: main ? levelOf(main) : null,
      sharedPages: lore.reduce((sum, e) => sum + e.pages.length, 0),
      clues: party.clues,
      members: party.members,
      trimmed: trimmed.size,
      instructionsVersion: INSTRUCTIONS_VERSION
    }
  };
}
