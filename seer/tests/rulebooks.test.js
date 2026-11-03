import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LEAVE_OUT as MODULE_LEAVE_OUT,
  DEFAULT_RULEBOOKS as MODULE_RULEBOOKS
} from "../../scripts/decide/rulebooks.js";
import {
  bookOf,
  capped,
  createLibrary,
  crossIndex,
  leaveOutRules,
  leftOut,
  norm,
  packLevel,
  packOpenTo,
  parseCompendiumUuid,
  renderEntry,
  searchShelf,
  shelfOf,
  spellFacts,
  tableRulebooks,
  TOOL_READ,
  TOOL_SEARCH,
  toolDefinitions
} from "../src/rulebooks.js";
import { DEFAULT_LEAVE_OUT, DEFAULT_RULEBOOKS, moduleSettings } from "../src/settings.js";
import { quietLog } from "./helpers.js";

/*
 * A synthetic table: two made-up books and a system glossary. Never a real book's text, which
 * is licensed and has no place in a public repository.
 */

const PLAYER = { _id: "player0000000001", name: "Ada", role: 1 };
const GM = { _id: "gamemaster000001", name: "DM", role: 4 };

const spell = (id, name, level, extra = {}) => ({
  _id: id,
  name,
  type: "spell",
  folder: level ? "fLevelThree00000" : "fCantrips0000000",
  system: {
    level,
    school: "evo",
    activation: { type: "action", value: null },
    range: { value: "120", units: "ft" },
    target: { template: { type: "sphere", size: "20", units: "ft" } },
    properties: ["vocal", "somatic", "material", ...(extra.concentration ? ["concentration"] : [])],
    materials: { value: "a pinch of ash", consumed: false },
    duration: extra.concentration ? { value: "1", units: "minute" } : { units: "inst" },
    description: { value: `<p>${name} scorches a point you choose.</p>` }
  }
});

const classItems = [
  {
    _id: "sageClass0000000",
    name: "Sage",
    type: "class",
    folder: null,
    system: {
      identifier: "sage",
      description: { value: "<p>Sages study the quiet arts.</p>" },
      advancement: [
        {
          type: "ItemGrant",
          level: 1,
          configuration: { items: [{ uuid: "Compendium.book-one.classes.Item.quietStudy000000" }] }
        },
        { type: "Subclass", level: 3 },
        { type: "AbilityScoreImprovement", level: 4 },
        {
          type: "ScaleValue",
          title: "Cantrips Known",
          configuration: { identifier: "cantrips", scale: { 1: { value: 2 }, 4: { value: 3 } } }
        }
      ]
    }
  },
  {
    _id: "lamplighter00000",
    name: "Lamplighter",
    type: "subclass",
    folder: null,
    system: {
      identifier: "lamplighter",
      classIdentifier: "sage",
      description: { value: "<p>Keepers of the lamps.</p>" },
      advancement: [
        {
          type: "ItemGrant",
          level: 3,
          configuration: { items: [{ uuid: "Compendium.book-one.classes.Item.lampWard00000000" }] }
        }
      ]
    }
  },
  {
    _id: "quietStudy000000",
    name: "Quiet Study",
    type: "feat",
    folder: "fFeatures0000000",
    system: {
      type: { value: "class" },
      uses: { max: "1", recovery: [{ period: "lr" }] },
      description: { value: "<p>Regain a little focus by reading.</p>" }
    }
  },
  {
    _id: "lampWard00000000",
    name: "Lamp Ward",
    type: "feat",
    folder: "fFeatures0000000",
    system: {
      type: { value: "subclass" },
      description: { value: "<p>A lamp's light wards you.</p>" }
    }
  },
  {
    _id: "monsterBite00000",
    name: "Bite",
    type: "feat",
    folder: null,
    system: { type: { value: "monster" }, description: { value: "<p>A creature's bite.</p>" } }
  }
];

const DOCS = {
  "book-one.spells": [
    spell("emberLance000000", "Ember Lance", 3),
    spell("embers0000000000", "Embers", 0)
  ],
  "book-one.classes": classItems,
  "book-one.gear": [
    {
      _id: "rope000000000001",
      name: "Rope",
      type: "consumable",
      folder: null,
      system: {
        price: { value: 1, denomination: "gp" },
        description: { value: "<p>Fifty feet.</p>" }
      }
    },
    {
      _id: "rope000000000002",
      name: "Rope",
      type: "consumable",
      folder: null,
      system: { description: { value: "<p>Fifty feet.</p>" } }
    },
    {
      _id: "longBlade0000000",
      name: "Long Blade",
      type: "weapon",
      folder: null,
      system: {
        type: { value: "martialM" },
        damage: { base: { number: 1, denomination: 8, types: ["slashing"] } },
        properties: ["ver"],
        mastery: "sap",
        description: { value: "" }
      }
    }
  ],
  "book-one.content": [
    {
      _id: "rulesEntry000000",
      name: "Rules",
      folder: "fChapterOne00000",
      pages: [
        {
          _id: "hiding0000000000",
          name: "Hiding",
          type: "text",
          sort: 1,
          text: { content: "<p>Hide itself from sight behind cover.</p>" }
        },
        {
          _id: "shrouded00000000",
          name: "Shrouded",
          type: "rule",
          sort: 2,
          text: {
            content:
              "<p>@Embed[Compendium.sys.glossary.JournalEntry.glossary00000000.JournalEntryPage.shroudedRule0000 inline]</p>"
          }
        },
        { _id: "artPage000000000", name: "Art", type: "image", sort: 3, src: "a.webp" },
        { _id: "sagePage00000000", name: "Sage", type: "class", sort: 4, system: { item: "x" } }
      ]
    },
    {
      _id: "listsEntry000000",
      name: "Spell Lists",
      folder: "fChapterOne00000",
      pages: [
        {
          _id: "sageList00000000",
          name: "Sage Spell List",
          type: "spells",
          sort: 1,
          system: {
            type: "class",
            spells: [
              "Compendium.book-one.spells.Item.emberLance000000",
              "Compendium.book-one.spells.Item.embers0000000000"
            ]
          }
        },
        {
          _id: "allSpells0000000",
          name: "All Spells",
          type: "spells",
          sort: 2,
          system: { type: "other", spells: [] }
        }
      ]
    },
    {
      _id: "creatures0000000",
      name: "Creatures",
      folder: "fBeastsChapter00",
      pages: [
        {
          _id: "wolfPage00000000",
          name: "Wolf",
          type: "text",
          sort: 1,
          text: {
            content:
              "<p>Wolves hunt in packs.</p><p>@Embed[Compendium.book-one.beasts.Actor.wolf000000000000 statblock]</p>"
          }
        }
      ]
    }
  ],
  "book-one.beasts": [{ _id: "wolf000000000000", name: "Wolf", type: "npc" }],
  "sys.glossary": [
    {
      _id: "glossary00000000",
      name: "Glossary",
      folder: null,
      pages: [
        {
          _id: "shroudedRule0000",
          name: "Shrouded",
          type: "text",
          text: {
            content:
              "<p>A shrouded creature is hard to see behind &amp;Reference[Total Cover].</p><p>@Embed[Compendium.book-one.beasts.Actor.wolf000000000000]</p>"
          }
        }
      ]
    }
  ],
  "book-two.secrets": [spell("hiddenFire000000", "Hidden Fire", 3)]
};

const pack = (packageName, name, type, extra = {}) => ({
  id: `${packageName}.${name}`,
  name,
  label: name,
  type,
  packageName,
  packageType: extra.packageType ?? "module",
  ownership: extra.ownership,
  folders: extra.folders ?? [],
  index: (DOCS[`${packageName}.${name}`] ?? []).map(d => ({ _id: d._id, name: d.name }))
});

function makeWorld({ settings = [], users = [PLAYER, GM] } = {}) {
  return {
    world: { id: "test-world" },
    system: { title: "Test System" },
    modules: [
      { id: "book-one", title: "Dungeons & Dragons Book One", active: true },
      { id: "book-two", title: "Book Two", active: true }
    ],
    users,
    settings,
    packs: [
      pack("book-one", "spells", "Item", {
        folders: [
          { _id: "fLevelThree00000", name: "3rd Level", folder: null },
          { _id: "fCantrips0000000", name: "Cantrips", folder: null }
        ]
      }),
      pack("book-one", "classes", "Item", {
        folders: [{ _id: "fFeatures0000000", name: "Class Features", folder: null }]
      }),
      pack("book-one", "gear", "Item"),
      pack("book-one", "content", "JournalEntry", {
        folders: [
          { _id: "fChapterOne00000", name: "Chapter 1", folder: null },
          { _id: "fBeastsChapter00", name: "Bestiary Chapter", folder: null }
        ]
      }),
      pack("book-one", "beasts", "Actor"),
      pack("sys", "glossary", "JournalEntry", { packageType: "system" }),
      pack("book-two", "secrets", "Item", { ownership: { PLAYER: "NONE", ASSISTANT: "OWNER" } })
    ]
  };
}

const SETTINGS = {
  ...moduleSettings({ settings: [] }),
  rulebooks: [
    "book-one.spells",
    "book-one.classes",
    "book-one.gear",
    "book-one.content",
    "book-one.beasts",
    "book-two.secrets",
    "book-one.missing"
  ],
  rulebookLeaveOut: ["Bestiary Chapter"]
};

function fakeLink() {
  const reads = [];
  return {
    reads,
    packDocuments: vi.fn(async (id, type) => {
      reads.push([id, type]);
      return structuredClone(DOCS[id] ?? []);
    })
  };
}

const deskFor = (user = PLAYER, settings = SETTINGS, world = makeWorld()) => {
  const link = fakeLink();
  const library = createLibrary({ link, log: quietLog() });
  return { link, library, desk: library.desk(world, user, settings) };
};

const search = (desk, query, kind) =>
  desk.run({ name: TOOL_SEARCH, input: { query, ...(kind ? { kind } : {}) } });
const read = (desk, id, onLookup) => desk.run({ name: TOOL_READ, input: { id } }, onLookup);

describe("the defaults", () => {
  it("are the same in the Seer and the module", () => {
    expect(DEFAULT_RULEBOOKS).toBe(MODULE_RULEBOOKS);
    expect(DEFAULT_LEAVE_OUT).toBe(MODULE_LEAVE_OUT);
  });

  it("name journal and item packs, never a bestiary", () => {
    for (const id of DEFAULT_RULEBOOKS.split("\n"))
      expect(id).not.toMatch(/actors|adventures|scenes|tables/);
  });
});

describe("a pack's permission", () => {
  const p = (ownership, id = "a.b") => ({ id, ownership });

  it("is Foundry's getUserLevel: the highest level of any role the user holds", () => {
    expect(packLevel(p({ PLAYER: "OBSERVER", ASSISTANT: "OWNER" }), 1)).toBe(2);
    expect(packLevel(p({ PLAYER: "NONE", TRUSTED: "OBSERVER" }), 1)).toBe(0);
    expect(packLevel(p({ PLAYER: "NONE", TRUSTED: "OBSERVER" }), 2)).toBe(2);
    expect(packLevel(p({ PLAYER: "LIMITED" }), 1)).toBe(1);
  });

  it("falls back to the default ownership, and the world's configuration overrides the pack's", () => {
    expect(packLevel(p(undefined), 1)).toBe(2);
    expect(
      packLevel(p({ PLAYER: "OBSERVER" }), 1, { "a.b": { ownership: { PLAYER: "NONE" } } })
    ).toBe(0);
  });

  it("opens to a player at Observer, never at Limited, and never to a banned user", () => {
    expect(packOpenTo(p({ PLAYER: "OBSERVER" }), PLAYER)).toBe(true);
    expect(packOpenTo(p({ PLAYER: "LIMITED" }), PLAYER)).toBe(false);
    expect(packOpenTo(p({ PLAYER: "OBSERVER" }), { role: 0 })).toBe(false);
  });

  it("opens to a GM what the players read, and no more", () => {
    const hidden = p({ PLAYER: "NONE", ASSISTANT: "OWNER" });
    expect(packOpenTo(hidden, GM)).toBe(false);
    expect(packOpenTo(hidden, GM, { gmGaze: "all" })).toBe(false);
    expect(packOpenTo(p({ PLAYER: "OBSERVER" }), GM)).toBe(true);
  });

  it("reads the compendium configuration from a GM's row only", () => {
    const row = by => ({
      key: "core.compendiumConfiguration",
      user: null,
      value: JSON.stringify({ "book-two.secrets": { ownership: { PLAYER: "OBSERVER" } } }),
      _stats: { lastModifiedBy: by }
    });
    const forged = deskFor(PLAYER, SETTINGS, makeWorld({ settings: [row(PLAYER._id)] })).desk;
    const real = deskFor(PLAYER, SETTINGS, makeWorld({ settings: [row(GM._id)] })).desk;
    expect(forged.open).toBe(4);
    expect(real.open).toBe(5);
  });
});

describe("the table's rulebooks", () => {
  it("are the setting's packs the world has, journal and item packs only, in its order", () => {
    const ids = tableRulebooks(makeWorld(), SETTINGS).map(p => p.id);
    expect(ids).toEqual([
      "book-one.spells",
      "book-one.classes",
      "book-one.gear",
      "book-one.content",
      "book-two.secrets"
    ]);
  });

  it("are named by their package's title, the publisher's prefix dropped", () => {
    const w = makeWorld();
    expect(bookOf(w, w.packs[0])).toBe("Book One");
    expect(
      bookOf(
        w,
        w.packs.find(p => p.packageType === "system")
      )
    ).toBe("Test System");
  });

  it("make no desk when the setting is empty or names nothing the world has", () => {
    expect(deskFor(PLAYER, { ...SETTINGS, rulebooks: [] }).desk).toBeNull();
    expect(deskFor(PLAYER, { ...SETTINGS, rulebooks: ["nowhere.pack"] }).desk).toBeNull();
  });

  it("give the same tool definitions to every player, whatever packs each may open", () => {
    const a = deskFor(PLAYER).desk;
    const b = deskFor(GM).desk;
    expect(JSON.stringify(a.definitions)).toBe(JSON.stringify(b.definitions));
    expect(a.books).toEqual(["Book One", "Book Two"]);
    expect(a.definitions.map(d => d.name)).toEqual([TOOL_SEARCH, TOOL_READ]);
    expect(JSON.stringify(toolDefinitions(a.books))).toBe(JSON.stringify(a.definitions));
  });
});

describe("a pack's entries", () => {
  const w = makeWorld();
  const packOf = id => w.packs.find(p => p.id === id);

  it("are the items of a kind the ball reads, a monster's feature never", () => {
    const entries = shelfOf(packOf("book-one.classes"), DOCS["book-one.classes"], "Book One");
    expect(entries.map(e => [e.name, e.kind])).toEqual([
      ["Sage", "class"],
      ["Lamplighter", "subclass"],
      ["Quiet Study", "feature"],
      ["Lamp Ward", "feature"]
    ]);
    expect(entries[2].path).toEqual(["Class Features"]);
  });

  it("are a journal's text, rule and class spell-list pages; pictures, class pages and the full list never", () => {
    const entries = shelfOf(packOf("book-one.content"), DOCS["book-one.content"], "Book One");
    expect(entries.map(e => [e.title, e.kind])).toEqual([
      ["Rules › Hiding", "rules"],
      ["Rules › Shrouded", "rules"],
      ["Spell Lists › Sage Spell List", "spell list"],
      ["Creatures › Wolf", "rules"]
    ]);
    expect(entries[0].path).toEqual(["Chapter 1", "Rules"]);
  });

  it("are left out by a folder, an entry or a page name, accents and case aside", () => {
    const [entry] = shelfOf(packOf("book-one.content"), DOCS["book-one.content"], "Book One");
    expect(leftOut(entry, new Set([norm("chapter 1")]))).toBe(true);
    expect(leftOut(entry, new Set([norm("RULES")]))).toBe(true);
    expect(leftOut(entry, new Set([norm("Hiding")]))).toBe(true);
    expect(leftOut(entry, new Set([norm("Combat")]))).toBe(false);
    expect(norm("Heroes of Faerûn")).toBe("heroes of faerun");
  });

  it("are left out of one book alone by a line led by its package or pack id", () => {
    const ids = ["book-one", "book-one.content", "book-two"];
    const rules = leaveOutRules(
      [
        "book-one: Chapter 1",
        "book-two.secrets: Rules",
        "Appendix B: Creature Stat Blocks",
        "nowhere: Rules"
      ],
      ids
    );
    expect([...rules.scoped.keys()]).toEqual(["book-one"]);
    expect([...rules.names]).toEqual([
      "book two secrets rules",
      "appendix b creature stat blocks",
      "nowhere rules"
    ]);
    const [entry] = shelfOf(packOf("book-one.content"), DOCS["book-one.content"], "Book One");
    expect(leftOut(entry, rules)).toBe(true);
    expect(leftOut(entry, leaveOutRules(["book-two: Chapter 1"], ids))).toBe(false);
    expect(leftOut(entry, leaveOutRules(["book-one.content: Rules"], ids))).toBe(true);
    expect(
      leftOut(entry, leaveOutRules(["book-one.spells: Rules"], [...ids, "book-one.spells"]))
    ).toBe(false);
  });

  it("keep one book's chapter when another book's same-named chapter is left out", async () => {
    const settings = { ...SETTINGS, rulebookLeaveOut: ["book-two: Chapter 1"] };
    expect((await search(deskFor(PLAYER, settings).desk, "hiding")).content).toContain(
      "Rules › Hiding"
    );
    const scoped = { ...SETTINGS, rulebookLeaveOut: ["book-one: Chapter 1"] };
    const desk = deskFor(PLAYER, scoped).desk;
    expect((await search(desk, "hiding")).content).toMatch(/^Nothing/);
    expect((await search(desk, "ember lance")).content).toContain("Ember Lance");
  });
});

describe("the search", () => {
  it("puts the exact name first and finds a term at the start of a word only", async () => {
    const { desk } = deskFor();
    const text = (await search(desk, "ember lance")).content;
    expect(text.split("\n")[1]).toMatch(
      /^- Ember Lance \(level 3 evocation; Book One\) id: book-one\.spells\/emberLance000000$/
    );
    // "itself" in the Hiding page never answers a search for "it".
    expect((await search(desk, "self")).content).toMatch(/^Nothing in the rulebooks/);
  });

  it("requires every term, narrows by kind and shows a doubled item once", async () => {
    const { desk } = deskFor();
    expect((await search(desk, "ember quiet")).content).toMatch(/^Nothing/);
    const kinds = (await search(desk, "sage", "spell list")).content;
    expect(kinds).toContain("Sage Spell List");
    expect(kinds).not.toContain("(class;");
    const ropes = (await search(desk, "rope")).content;
    expect(ropes.match(/- Rope /g)).toHaveLength(1);
  });

  it("never finds what is left out, nor a pack the player may not open", async () => {
    const { desk } = deskFor();
    expect((await search(desk, "wolves")).content).toMatch(/^Nothing/);
    expect((await search(desk, "hidden fire")).content).toMatch(/^Nothing/);
    const gm = deskFor(GM).desk;
    expect((await search(gm, "hidden fire")).content).toMatch(/^Nothing/);
  });

  it("names a feature by the class that grants it, and a subclass by its class", async () => {
    const { desk } = deskFor();
    expect((await search(desk, "quiet study")).content).toContain(
      "(Sage feature, level 1; Book One)"
    );
    expect((await search(desk, "lamplighter")).content).toContain("(Sage subclass; Book One)");
  });

  it("reads each pack once, however many lookups ask at once, and never an actor pack", async () => {
    const { desk, link } = deskFor();
    await Promise.all([
      search(desk, "ember"),
      search(desk, "sage"),
      read(desk, "book-one.spells/emberLance000000")
    ]);
    const ids = link.reads.map(([id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("book-one.beasts");
    expect(ids).not.toContain("book-two.secrets");
  });

  it("says when some books could not be opened, and tries them again next time", async () => {
    const link = fakeLink();
    let fail = true;
    link.packDocuments = vi.fn(async id => {
      if (id === "book-one.gear" && fail) throw new Error("socket dropped");
      return structuredClone(DOCS[id] ?? []);
    });
    const log = quietLog();
    const desk = createLibrary({ link, log }).desk(makeWorld(), PLAYER, SETTINGS);
    expect((await search(desk, "ember")).content).toContain("could not be opened");
    expect(log.lines.some(l => l.message === "rulebooks: a pack could not be read")).toBe(true);
    fail = false;
    expect((await search(desk, "rope")).content).toContain("- Rope ");
  });

  it("is the pure ranking underneath", () => {
    const w = makeWorld();
    const entries = shelfOf(w.packs[0], DOCS["book-one.spells"], "Book One");
    expect(searchShelf(entries, "embers").hits.map(e => e.name)).toEqual(["Embers"]);
    expect(searchShelf(entries, "ember").hits.map(e => e.name)).toEqual(["Embers", "Ember Lance"]);
    expect(searchShelf(entries, "the").hits).toEqual([]);
  });
});

describe("a read", () => {
  it("gives a spell's facts, its class lists and its text", async () => {
    const { desk } = deskFor();
    const looks = [];
    const r = await read(desk, "book-one.spells/emberLance000000", l => looks.push(l));
    expect(r.isError).toBe(false);
    expect(r.content).toBe(
      [
        "# Ember Lance",
        "Level 3 evocation. From Book One (3rd Level).",
        [
          "Casting time: 1 action",
          "Range: 120 feet",
          "Area: 20-foot sphere",
          "Components: V, S, M (a pinch of ash)",
          "Duration: instantaneous",
          "On the spell lists of: Sage"
        ].join("\n"),
        "Ember Lance scorches a point you choose."
      ].join("\n\n")
    );
    expect(looks).toEqual([{ action: "read", name: "Ember Lance", book: "Book One" }]);
  });

  it("gives a class's features by level, its scale values and its subclasses", async () => {
    const { desk } = deskFor();
    const { content } = await read(desk, "book-one.classes/sageClass0000000");
    expect(content).toContain(
      "Features by level:\n- Level 1: Quiet Study\n- Level 3: a subclass\n- Level 4: Ability Score Improvement"
    );
    expect(content).toContain("- Cantrips Known: level 1: 2; level 4: 3");
    expect(content).toContain("Subclasses in the table's books: Lamplighter (Book One)");
  });

  it("gives a subclass its granted features' text, and a feature the class level that grants it", async () => {
    const { desk } = deskFor();
    const sub = (await read(desk, "book-one.classes/lamplighter00000")).content;
    expect(sub).toContain("## Lamp Ward (level 3)\n\nA lamp's light wards you.");
    const feat = (await read(desk, "book-one.classes/quietStudy000000")).content;
    expect(feat).toContain("Granted by: Sage at level 1\nUses: 1, regained on a Long Rest");
  });

  it("places an embedded glossary page from a pack the player may open, and drops an embedded stat block", async () => {
    const { desk, link } = deskFor();
    const { content } = await read(desk, "book-one.content/rulesEntry000000.shrouded00000000");
    expect(content).toBe(
      "# Rules › Shrouded\n\nRules. From Book One (Chapter 1 › Rules).\n\nA shrouded creature is hard to see behind Total Cover."
    );
    expect(link.reads.map(([id]) => id)).toContain("sys.glossary");
    expect(link.reads.map(([id]) => id)).not.toContain("book-one.beasts");
  });

  it("lists a spell list's spells by level", async () => {
    const { desk } = deskFor();
    const { content } = await read(desk, "book-one.content/listsEntry000000.sageList00000000");
    expect(content).toContain("Spells by level:\n- Cantrips: Embers\n- Level 3: Ember Lance");
  });

  it("refuses an id from a pack the player may not open, a left-out page and an unknown tool", async () => {
    const { desk } = deskFor();
    expect((await read(desk, "book-two.secrets/hiddenFire000000")).isError).toBe(true);
    expect((await read(desk, "book-one.beasts/wolf000000000000")).isError).toBe(true);
    expect((await read(desk, "book-one.content/creatures0000000.wolfPage00000000")).isError).toBe(
      true
    );
    expect((await desk.run({ name: "roll_dice", input: {} })).isError).toBe(true);
  });

  it("is cut at a line when it runs past the cap", () => {
    const text = `${"a line of text\n".repeat(50)}`;
    const cut = capped(text, 100);
    expect(cut.length).toBeLessThan(160);
    expect(cut).toMatch(/a line of text\n\n\(The entry runs on past this point\.\)$/);
  });
});

describe("the pure helpers", () => {
  it("parse a compendium uuid, embedded parts and the older form included", () => {
    expect(parseCompendiumUuid("Compendium.a.b.JournalEntry.e.JournalEntryPage.p")).toEqual({
      pack: "a.b",
      type: "JournalEntry",
      id: "e",
      embedded: [{ type: "JournalEntryPage", id: "p" }]
    });
    expect(parseCompendiumUuid("Compendium.a.b.x")).toEqual({
      pack: "a.b",
      type: null,
      id: "x",
      embedded: []
    });
    expect(parseCompendiumUuid("Actor.x")).toBeNull();
  });

  it("word a concentration spell's duration and a ritual's casting time", () => {
    const sys = spell("x", "X", 1, { concentration: true }).system;
    sys.properties.push("ritual");
    const facts = spellFacts(sys);
    expect(facts).toContain("Casting time: 1 action or Ritual");
    expect(facts).toContain("Duration: Concentration, up to 1 minute");
  });

  it("render an entry without the library, and a weapon by its facts", () => {
    const w = makeWorld();
    const entries = shelfOf(w.packs[2], DOCS["book-one.gear"], "Book One");
    const blade = entries.find(e => e.name === "Long Blade");
    const out = renderEntry(blade, {
      index: crossIndex(entries),
      nameOf: () => null,
      embed: () => null
    });
    expect(out).toContain(
      "Type: martial melee weapon\nDamage: 1d8 slashing\nProperties: versatile\nMastery: Sap"
    );
  });
});
