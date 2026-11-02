import { describe, expect, it } from "vitest";
import {
  abilityMod,
  acOf,
  activeChanges,
  backgroundOf,
  classLine,
  classNames,
  curatedSheet,
  effectsOf,
  hpOf,
  itemFace,
  levelOf,
  memberLine,
  movementOf,
  profBonus,
  sensesOf,
  speciesOf,
  spellSlotsOf,
  withEffects
} from "../src/sheet.js";
import { world } from "./helpers.js";

const actor = name => world().actors.find(a => a.name === name);

describe("the numbers dnd5e prepares", () => {
  it("has the modifier and proficiency tables right", () => {
    expect([1, 8, 10, 11, 16, 20].map(abilityMod)).toEqual([-5, -1, 0, 0, 3, 5]);
    expect([1, 4, 5, 8, 9, 13, 17, 20].map(profBonus)).toEqual([2, 2, 3, 3, 4, 5, 6, 6]);
  });

  it("works out hit points from advancement, Constitution and an effect's bonus per level", () => {
    // d10 fighter: 10 (max) + 6 (avg) + 6, Constitution +2 × 3, Tough +2 × 3.
    expect(hpOf(withEffects(actor("Ada Stone")))).toEqual({
      value: 20,
      max: 34,
      temp: 3,
      computed: true
    });
    expect(hpOf(actor("Ada Stone")).max).toBe(28);
    // d6 wizard, advancement stored as an array: 6 + 4, Constitution +1 × 2.
    expect(hpOf(actor("Ben Reed"))).toEqual({ value: 9, max: 12, temp: 0, computed: true });
  });

  it("keeps a stored maximum", () => {
    const a = actor("Ben Reed");
    a.system.attributes.hp.max = 30;
    expect(hpOf(a)).toEqual({ value: 9, max: 30, temp: 0, computed: false });
  });

  it("works out armour class from armour, Dexterity and shield", () => {
    expect(acOf(withEffects(actor("Ada Stone")))).toEqual({
      value: 18,
      label: "Chain Mail and Shield",
      computed: true
    });
    expect(acOf(actor("Ben Reed")).value).toBe(12);
  });

  it("caps Dexterity for medium armour and takes the best calculation", () => {
    const a = actor("Ben Reed");
    a.system.abilities.dex.value = 18;
    a.items.push({
      _id: "x",
      name: "Scale",
      type: "equipment",
      system: { equipped: true, type: { value: "medium" }, armor: { value: 14, dex: 2 } }
    });
    expect(acOf(a)).toMatchObject({ value: 16, label: "Scale" });
    a.items.pop();
    a.system.attributes.ac.calcs = ["unarmored", "armored", "unarmoredMonk"];
    a.system.abilities.wis.value = 16;
    expect(acOf(a)).toMatchObject({ value: 17 });
  });

  it("keeps an override and a flat calculation", () => {
    const a = actor("Ben Reed");
    a.system.attributes.ac.override = 21;
    expect(acOf(a)).toEqual({ value: 21, label: "", computed: false });
    a.system.attributes.ac = { calc: "flat", flat: 15 };
    expect(acOf(a).value).toBe(15);
  });

  it("works out spell slots from the progression", () => {
    expect(spellSlotsOf(actor("Ben Reed"))).toEqual({
      slots: [{ level: 1, value: 2, max: 3 }],
      pact: null
    });
    expect(spellSlotsOf(actor("Ada Stone"))).toEqual({ slots: [], pact: null });
  });

  it("rounds a lone half caster up, and gives a warlock pact slots", () => {
    const paladin = {
      system: { spells: {} },
      items: [
        {
          _id: "c",
          name: "Paladin",
          type: "class",
          system: { identifier: "paladin", levels: 1, spellcasting: { progression: "half" } }
        }
      ]
    };
    expect(spellSlotsOf(paladin).slots).toEqual([{ level: 1, value: 0, max: 2 }]);
    const warlock = {
      system: { spells: { pact: { value: 1 } } },
      items: [
        {
          _id: "c",
          name: "Warlock",
          type: "class",
          system: { identifier: "warlock", levels: 5, spellcasting: { progression: "pact" } }
        }
      ]
    };
    expect(spellSlotsOf(warlock).pact).toEqual({ level: 3, value: 1, max: 2 });
  });

  it("reads speed and senses from the species, the character's own winning", () => {
    expect(movementOf(actor("Ada Stone"))).toBe("walk 30 ft");
    expect(sensesOf(actor("Ada Stone"))).toBe("darkvision 120 ft");
    expect(movementOf(actor("Ben Reed"))).toBe("walk 30 ft");
    const a = actor("Ada Stone");
    a.system.attributes.movement.speeds = { walk: 25, fly: 30 };
    expect(movementOf(a)).toBe("fly 30 ft, walk 25 ft");
  });
});

describe("identity", () => {
  it("names species, background and classes from items or plain strings", () => {
    expect(speciesOf(actor("Ada Stone"))).toBe("Dwarf");
    expect(backgroundOf(actor("Ada Stone"))).toBe("Soldier");
    expect(speciesOf(actor("Ben Reed"))).toBe("Human");
    expect(backgroundOf(actor("Ben Reed"))).toBe("");
    expect(classLine(actor("Ada Stone"))).toBe("Fighter 3 (Champion)");
    expect(classNames(actor("Ada Stone"))).toBe("Fighter");
    expect(levelOf(actor("Ada Stone"))).toBe(3);
  });
});

describe("effects and items", () => {
  it("applies an effect only when its item is in use", () => {
    const keys = activeChanges(actor("Ada Stone")).map(c => c.key);
    expect(keys).toContain("system.attributes.hp.bonuses.level");
    expect(keys).not.toContain("system.attributes.ac.bonus");
  });

  it("applies the ring's effect once it is attuned and worn", () => {
    const a = actor("Ada Stone");
    const ring = a.items.find(i => i._id === "lootRing00000001");
    ring.system.equipped = true;
    ring.system.attuned = true;
    expect(acOf(withEffects(a)).value).toBe(13);
  });

  it("never writes through a key that names a prototype", () => {
    const a = {
      system: {},
      effects: [{ system: { changes: [{ key: "system.__proto__.x", value: 1, type: "add" }] } }]
    };
    withEffects(a);
    expect({}.x).toBeUndefined();
  });

  it("shows an unidentified item as the player sees it", () => {
    const ring = actor("Ada Stone").items.find(i => i._id === "lootRing00000001");
    expect(itemFace(ring)).toEqual({
      name: "Plain Ring",
      description: "<p>A ring of grey metal.</p>"
    });
  });

  it("lists the character's effects, not the suppressed ones", () => {
    expect(effectsOf(actor("Ada Stone"))).toEqual(["Bloodied", "Tough"]);
  });
});

describe("curatedSheet", () => {
  const sheet = curatedSheet(actor("Ada Stone"));

  it("opens with the character's name and identity", () => {
    expect(
      sheet.startsWith(
        "## Ada Stone\n\nSpecies: Dwarf. Background: Soldier. Classes: Fighter 3 (Champion). Level 3, proficiency bonus +2."
      )
    ).toBe(true);
  });

  it("carries the vitals with what was worked out marked", () => {
    expect(sheet).toContain(
      "HP 20 of 34 (worked out), 3 temporary. AC 18 (worked out: Chain Mail and Shield). Initiative +1 (worked out)."
    );
    expect(sheet).toContain(
      "Speed walk 30 ft. Senses: darkvision 120 ft. Hit dice left: 2 of 3 d10."
    );
  });

  it("lists abilities, saves and skills with proficiency and expertise", () => {
    expect(sheet).toContain(
      "- Strength 16 (+3), save +5 (proficient)\n- Dexterity 12 (+1), save +1"
    );
    expect(sheet).toContain("Athletics +5 (proficient)");
    expect(sheet).toContain("Intimidation +3 (expertise)");
    expect(sheet).toContain("Passive Perception 13.");
  });

  it("lists proficiencies, languages, resistances and coin", () => {
    expect(sheet).toContain("Armour: light armor, medium armor, heavy armor, shields.");
    expect(sheet).toContain("Weapon mastery: longsword.");
    expect(sheet).toContain("Languages: Common, Dwarvish.");
    expect(sheet).toContain("Damage resistances: poison.");
    expect(sheet).toContain("### Coin\n\n15 gp, 3 sp");
  });

  it("lists features with uses and inventory with its facts and descriptions", () => {
    expect(sheet).toContain("#### Second Wind (class feature; uses 1 of 2)");
    expect(sheet).toContain(
      "#### Longsword (weapon; equipped; 1d8 slashing; versatile 1d10 slashing; versatile; mastery sap)"
    );
    expect(sheet).toContain("#### Chain Mail (equipment; equipped; heavy armour, AC 16)");
    expect(sheet).toContain(
      "#### Potion of Healing (consumable; qty 2; uses 1 of 1)\n\nDrink to regain 2d4 + 2 hit points."
    );
    expect(sheet).toContain("#### Plain Ring (equipment; needs attunement, not attuned)");
    expect(sheet).not.toContain("TRUE-RING-TEXT");
    expect(sheet).not.toContain("Spite");
  });

  it("ends with who the character is", () => {
    expect(sheet).toContain(
      "### Who they are\n\nIdeals: Protect the road.\n\nADA-BIO: raised by her aunt."
    );
  });

  it("describes prepared spells and only names the rest", () => {
    const ben = curatedSheet(actor("Ben Reed"));
    expect(ben).toContain("### Spell slots (worked out)\n\nlevel 1: 2 of 3 left.");
    expect(ben).toContain("Spellcasting ability Intelligence: spell attack +5, save DC 13.");
    expect(ben).toContain(
      "#### Fire Bolt (cantrip; evocation; VS; always prepared)\n\nA mote of fire, 1d10 fire."
    );
    expect(ben).toContain(
      "#### Magic Missile (level 1; evocation; action; range 120 ft; VS; prepared)"
    );
    expect(ben).toContain("On the sheet but not prepared: Shield (level 1).");
    expect(ben).not.toContain("UNPREPARED-SPELL-TEXT");
    expect(ben).toContain("Languages: Common, Old Valley Cant.");
  });

  it("is the same text for the same actor", () => {
    expect(curatedSheet(actor("Ada Stone"))).toBe(sheet);
  });
});

describe("memberLine", () => {
  it("gives name, species, classes, HP and AC", () => {
    expect(memberLine(actor("Ada Stone"))).toBe(
      "Ada Stone: Dwarf; Fighter 3 (Champion); HP 20/34 (+3 temp); AC 18"
    );
    expect(memberLine(actor("Ben Reed"))).toBe("Ben Reed: Human; Wizard 2; HP 9/12; AC 12");
  });
});
