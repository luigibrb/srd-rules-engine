import { describe, expect, it } from "vitest";
import {
  type CharacterBuild,
  castSpell,
  combatantFromCharacter,
  computePlaySheet,
  computeSheet,
  createCatalog,
  createState,
  evaluate,
  resolve,
  scriptedRng,
} from "../src/index";
import * as svc from "../src/services/builder";
import { srdPack } from "../src/srd";
import { autocomplete, catalog, classBuild, levelUpIn } from "./helpers";

// What content can say as data (`src/models/content.ts`): a one-third caster progression, grants
// at a character level, an attunement limit, feats of a category you can take only once, dice
// in a spell damage bonus. Homebrew where the SRD has no example.

const homebrew = createCatalog(srdPack, {
  name: "homebrew",
  subclasses: [
    {
      id: "spell-knight",
      name: "Spell Knight",
      class: "fighter",
      features: { "3": { spellcasting: { list: "wizard", ability: "int", progression: "third" } } },
    },
  ],
  feats: [
    {
      id: "deep-bond",
      name: "Deep Bond",
      category: "general",
      grants: { effects: [{ target: "attunement", op: "max", value: 4 }] },
    },
    { id: "mark-of-a", name: "Mark of A", category: "mark", exclusive: true },
    { id: "mark-of-b", name: "Mark of B", category: "mark", exclusive: true },
    {
      id: "late-bloomer",
      name: "Late Bloomer",
      category: "general",
      grants: { at_level: [{ level: 6, grants: { skills: ["stealth"] } }] },
    },
    {
      id: "spell-spark",
      name: "Spell Spark",
      category: "origin",
      grants: { spell_damage: [{ name: "Spell Spark", dice: "1d8", one_roll: true }] },
    },
  ],
});

const set = (b: CharacterBuild, key: string, values: string[], cat = homebrew) =>
  svc.setChoice(b, cat, key, values).build;
const fighter = (levels: number, choices: Record<string, string[]> = {}) => {
  let b = autocomplete(classBuild("fighter", { name: "Brakka" }), homebrew);
  for (let i = 1; i < levels; i++) {
    b = svc.levelUp(b, homebrew, "fighter", null).build;
    for (const [key, values] of Object.entries(choices)) {
      if (resolve(b, homebrew).choices.some((c) => c.key === key)) b = set(b, key, values);
    }
    b = autocomplete(b, homebrew);
  }
  return b;
};

describe("a one-third caster", () => {
  it("counts a third of its class levels, rounded up, on the Multiclass Spellcaster table", () => {
    const b = fighter(7, { "class:fighter:3#subclass": ["spell-knight"] });
    // Fighter 7: caster level 3, so four level 1 slots and two level 2 slots.
    expect(computeSheet(b, homebrew).spell_slots).toEqual([4, 2]);
  });
});

const stealth = (b: CharacterBuild) =>
  computeSheet(b, homebrew).skills.find((x) => x.skill === "stealth")?.proficient_from !== null;

describe("grants at a character level", () => {
  it("a Drow learns Faerie Fire at level 3 and Darkness at level 5, each castable once without a slot", () => {
    let b = autocomplete(classBuild("fighter", { species: "elf", name: "Ilyana" }));
    b = svc.setChoice(b, catalog, "species:elf#lineage", ["drow"]).build;
    b = autocomplete(b);
    const spellsAt = (build: CharacterBuild) =>
      computePlaySheet(build, createState(build, catalog), catalog).spells.map((s) => s.id);
    expect(spellsAt(levelUpIn(b, "fighter", 1))).not.toContain("faerie-fire");
    const five = levelUpIn(b, "fighter", 4);
    expect(spellsAt(five)).toEqual(expect.arrayContaining(["faerie-fire", "darkness"]));
    const uses = computePlaySheet(five, createState(five, catalog), catalog).play.uses;
    expect(uses.map((u) => [u.name, u.max])).toEqual(
      expect.arrayContaining([
        ["Faerie Fire (once without a slot)", 1],
        ["Darkness (once without a slot)", 1],
      ]),
    );
  });

  it("a feat taken at a class level gives its later grant once, at that character level", () => {
    const b = fighter(6, { "class:fighter:4#feat": ["late-bloomer"] });
    expect(stealth(b)).toBe(true);
    expect(evaluate(b, homebrew).report.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(stealth(fighter(5, { "class:fighter:4#feat": ["late-bloomer"] }))).toBe(false);
  });
});

describe("the attunement limit", () => {
  it("three items, unless a feature raises it", () => {
    expect(computeSheet(fighter(1), homebrew).attunement_max).toBe(3);
    const b = fighter(4, { "class:fighter:4#feat": ["deep-bond"] });
    expect(computeSheet(b, homebrew).attunement_max).toBe(4);
  });
});

describe("a feat category you can take only once", () => {
  it("with one Mark, the other is unavailable, saying which", () => {
    const b = fighter(6, { "class:fighter:4#feat": ["mark-of-a"] });
    const res = resolve(svc.levelUp(b, homebrew, "fighter", null).build, homebrew);
    const choice = res.choices.find((c) => c.key === "class:fighter:6#feat");
    const other = choice && res.options(choice).find((o) => o.id === "mark-of-b");
    expect(other?.unavailable).toBe("you can have only one feat of this kind (Mark of A)");
  });
});

describe("dice in a spell damage bonus", () => {
  it("a d8 added to one damage roll, of the spell's damage type", () => {
    let b = autocomplete(classBuild("wizard", { name: "Ilse" }), homebrew);
    b = set(b, "species:human#versatile", ["spell-spark"]);
    b = autocomplete(b, homebrew);
    const ilse = combatantFromCharacter(b, createState(b, homebrew), homebrew);
    expect(ilse.spell_damage).toEqual([expect.objectContaining({ dice: "1d8", bonus: 0 })]);
    const target = combatantFromCharacter(b, createState(b, homebrew), homebrew);
    const spell = homebrew.spells["fire-bolt"];
    if (!spell) throw new Error("no Fire Bolt");
    // A d20 of 15 hits; the d10 rolls 5, the added d8 rolls 7: 12 Fire damage.
    const r = castSpell(ilse, spell, [target], { rng: scriptedRng([15, 5, 7]) });
    expect(r.targets[0]?.attack?.hit).toBe(true);
    expect(r.targets[0]?.instances.map((x) => [x.amount, x.type])).toEqual([
      [5, "fire"],
      [7, "fire"],
    ]);
  });
});
