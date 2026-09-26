import { describe, expect, it } from "vitest";
import {
  type CharacterBuild,
  computeSheet,
  type DerivedSheet,
  evaluate,
  reportErrors,
  resolve,
} from "../src/index";
import * as svc from "../src/services/builder";
import { apply, autocomplete, catalog, classBuild } from "./helpers";

const CLASSES = Object.keys(catalog.classes);
const set = (b: CharacterBuild, key: string, values: string[]) =>
  apply(b, svc.setChoice, key, values);
const attack = (sheet: DerivedSheet, name: string) => sheet.attacks.find((a) => a.name === name);
const skill = (sheet: DerivedSheet, id: string) => sheet.skills.find((s) => s.skill === id);
const options = (b: CharacterBuild, key: string) => {
  const res = resolve(b, catalog);
  const choice = res.choice(key);
  if (!choice) throw new Error(`no choice ${key}`);
  return res.options(choice);
};

describe("every class, species and background combination can be completed", () => {
  for (const classId of CLASSES) {
    it(classId, () => {
      for (const species of Object.keys(catalog.species)) {
        for (const background of Object.keys(catalog.backgrounds)) {
          const build = autocomplete(classBuild(classId, { species, background }));
          const { report } = evaluate(build, catalog);
          const open = report.issues.filter((i) => i.severity !== "note");
          expect(open, `${classId}/${species}/${background}`).toEqual([]);
        }
      }
    });
  }
});

describe("hit points and saves", () => {
  it.each([
    ["barbarian", 12, ["str", "con"]],
    ["bard", 8, ["dex", "cha"]],
    ["cleric", 8, ["wis", "cha"]],
    ["druid", 8, ["int", "wis"]],
    ["fighter", 10, ["str", "con"]],
    ["monk", 8, ["str", "dex"]],
    ["paladin", 10, ["wis", "cha"]],
    ["ranger", 10, ["str", "dex"]],
    ["rogue", 8, ["dex", "int"]],
    ["sorcerer", 6, ["con", "cha"]],
    ["warlock", 8, ["wis", "cha"]],
    ["wizard", 6, ["int", "wis"]],
  ])("%s: d%i hit die, saves %j", (classId, die, saves) => {
    const sheet = computeSheet(classBuild(classId as string), catalog);
    expect(sheet.hit_dice).toEqual({ [String(die)]: 1 });
    expect(sheet.max_hp?.total).toBe((die as number) + sheet.modifiers.con);
    const proficient = Object.entries(sheet.saving_throws)
      .filter(([, s]) => s.proficient)
      .map(([a]) => a);
    expect(proficient).toEqual(saves);
  });
});

describe("Barbarian", () => {
  // Str 15+2 = 17, Dex 13, Con 14+1 = 15; no armor in the package.
  const build = set(
    autocomplete(classBuild("barbarian", { bonus: { str: 2, con: 1 } })),
    "class:barbarian#equipment",
    ["a"],
  );
  const sheet = computeSheet(build, catalog);

  it("Unarmored Defense: 10 + Dex + Con", () => {
    expect(sheet.armor_class.total).toBe(10 + 1 + 2);
    expect(sheet.armor_class.parts.map((p) => p.source)).toEqual([
      "Unarmored Defense",
      "Dex",
      "Con",
    ]);
  });

  it("Weapon Mastery is limited to melee weapons", () => {
    const ids = options(build, "class:barbarian#weapon_mastery").map((o) => o.id);
    expect(ids).toContain("greataxe");
    expect(ids).not.toContain("longbow");
  });

  it("greataxe attack", () => {
    expect(attack(sheet, "Greataxe")).toMatchObject({ attack_bonus: 3 + 2, damage: "1d12+3" });
  });
});

describe("Bard", () => {
  // Cha 15 + 2 (Acolyte) = 17 → +3.
  let build = classBuild("bard", { background: "acolyte", bonus: { cha: 2, int: 1 } });
  build = set(build, "class:bard#cantrips", ["vicious-mockery", "dancing-lights"]);
  build = set(build, "class:bard#prepared", ["healing-word", "charm-person", "sleep", "heroism"]);
  const sheet = computeSheet(build, catalog);

  it("casts with Charisma", () => {
    expect(sheet.spellcasting[0]).toMatchObject({
      source: "Bard",
      list: "bard",
      ability: "cha",
      save_dc: 8 + 2 + 3,
      attack_bonus: 2 + 3,
      progression: "full",
    });
    expect(sheet.spell_slots).toEqual([2]);
    expect(sheet.pact_magic).toBeNull();
  });

  it("only offers Bard spells of the right level", () => {
    const ids = options(build, "class:bard#cantrips").map((o) => o.id);
    expect(ids).toContain("vicious-mockery");
    expect(ids).not.toContain("fire-bolt");
    expect(options(build, "class:bard#prepared").map((o) => o.id)).not.toContain("vicious-mockery");
  });

  it("lists cantrips and prepared spells", () => {
    expect([...sheet.cantrips].sort()).toEqual(["dancing-lights", "vicious-mockery"]);
    expect(sheet.spells.filter((s) => s.level === 1)).toHaveLength(4);
  });

  it("picks three musical instruments", () => {
    const ids = options(build, "class:bard#instruments").map((o) => o.id);
    expect(ids).toContain("lute");
    expect(ids).not.toContain("thieves-tools");
  });
});

describe("Cleric", () => {
  it("Protector: heavy armor and martial weapons", () => {
    let build = classBuild("cleric");
    build = set(build, "class:cleric#divine_order", ["protector"]);
    build = set(build, "class:cleric#equipment", ["a"]);
    const sheet = computeSheet(build, catalog);
    expect(sheet.armor_training).toContain("heavy");
    expect(sheet.weapon_proficiencies).toContain("martial");
    // Chain Shirt 13 + Dex (8 → -1) + Shield 2.
    expect(sheet.armor_class.total).toBe(13 - 1 + 2);
  });

  it("Thaumaturge: an extra cantrip and Wis to Arcana and Religion", () => {
    // Wis 15 + 2 = 17 → +3; Int 10 + 1 = 11 → +0.
    let build = classBuild("cleric", { background: "sage", bonus: { wis: 2, int: 1 } });
    build = set(build, "class:cleric#divine_order", ["thaumaturge"]);
    build = set(build, "class:cleric#cantrips", ["guidance", "sacred-flame", "thaumaturgy"]);
    const extra = "class:cleric#divine_order=thaumaturge#cantrip";
    const available = options(build, extra)
      .filter((o) => !o.unavailable)
      .map((o) => o.id);
    expect(available).not.toContain("guidance"); // already known
    build = set(build, extra, ["spare-the-dying"]);
    const sheet = computeSheet(build, catalog);
    expect(sheet.cantrips).toHaveLength(4);
    // Arcana: Int +0, proficient from Sage +2, Thaumaturge Wis +3.
    expect(skill(sheet, "arcana")?.modifier).toBe(0 + 2 + 3);
  });

  it("the Thaumaturge bonus is at least +1", () => {
    let build = classBuild("cleric");
    build = apply(build, svc.setBaseScores, {
      str: 15,
      dex: 14,
      con: 13,
      int: 12,
      wis: 8,
      cha: 10,
    });
    build = apply(build, svc.setBackgroundBonus, { str: 2, con: 1 });
    build = set(build, "class:cleric#divine_order", ["thaumaturge"]);
    // Religion: Int 12 → +1, not proficient, Wis 8 → -1 raised to the +1 minimum.
    expect(skill(computeSheet(build, catalog), "religion")?.modifier).toBe(1 + 1);
  });
});

describe("Druid", () => {
  let build = classBuild("druid");
  build = set(build, "class:druid#primal_order", ["magician"]);
  const sheet = computeSheet(build, catalog);

  it("knows Druidic and always has Speak with Animals prepared", () => {
    expect(sheet.languages.druidic).toBe("Druid");
    expect(sheet.spells.find((s) => s.id === "speak-with-animals")?.always_prepared).toBe(true);
    const prepared = options(build, "class:druid#prepared").find(
      (o) => o.id === "speak-with-animals",
    );
    expect(prepared?.unavailable).toBe("already known from Druid");
  });

  it("Magician adds a cantrip choice", () => {
    expect(
      resolve(build, catalog).choice("class:druid#primal_order=magician#cantrip"),
    ).toBeDefined();
  });

  it("is proficient with the Herbalism Kit", () => {
    expect(sheet.tools["herbalism-kit"]).toBe("Druid");
  });
});

describe("Monk", () => {
  // Str 12, Dex 15 + 2 = 17 → +3, Con 13 + 1, Wis 14 → +2.
  let build = classBuild("monk", { bonus: { dex: 2, con: 1 } });
  build = set(build, "class:monk#equipment", ["a"]);
  const sheet = computeSheet(build, catalog);

  it("Unarmored Defense: 10 + Dex + Wis", () => {
    expect(sheet.armor_class.total).toBe(10 + 3 + 2);
  });

  it("Martial Arts: Dex and a d6 for Unarmed Strikes and Monk weapons", () => {
    expect(attack(sheet, "Unarmed Strike")).toMatchObject({ attack_bonus: 3 + 2, damage: "1d6+3" });
    expect(attack(sheet, "Dagger")).toMatchObject({ attack_bonus: 5, damage: "1d6+3" }); // d4 → d6
    expect(attack(sheet, "Spear")?.damage).toBe("1d6+3 (1d8+3 two-handed)");
  });

  it("is proficient with Martial weapons that have the Light property only", () => {
    const res = resolve(build, catalog);
    expect(res.granted("weapon_proficiencies")).toEqual(["simple", "martial:light"]);
    const mastery = options(
      classBuild("fighter", { species: "human" }),
      "class:fighter#weapon_mastery",
    );
    expect(mastery.length).toBeGreaterThan(0);
  });

  it("chooses an artisan's tool or musical instrument", () => {
    const categories = new Set(
      options(build, "class:monk#tool").map((o) => catalog.tools[o.id]?.category),
    );
    expect(categories).toEqual(new Set(["artisan", "musical-instrument"]));
  });
});

describe("Paladin", () => {
  let build = classBuild("paladin");
  build = set(build, "class:paladin#equipment", ["a"]);
  build = set(build, "class:paladin#prepared", ["heroism", "searing-smite"]);
  const sheet = computeSheet(build, catalog);

  it("Chain Mail and Shield", () => {
    expect(sheet.armor_class.total).toBe(16 + 2);
  });

  it("prepares two spells and knows no cantrips", () => {
    expect(sheet.cantrips).toEqual([]);
    expect(sheet.spells.map((s) => s.id)).toEqual(["heroism", "searing-smite"]);
    expect(resolve(build, catalog).choice("class:paladin#cantrips")).toBeUndefined();
  });
});

describe("Ranger", () => {
  const build = set(classBuild("ranger"), "class:ranger#equipment", ["a"]);
  const sheet = computeSheet(build, catalog);

  it("Favored Enemy: Hunter's Mark is always prepared and can't be prepared again", () => {
    expect(sheet.spells.find((s) => s.id === "hunters-mark")?.always_prepared).toBe(true);
    const option = options(build, "class:ranger#prepared").find((o) => o.id === "hunters-mark");
    expect(option?.unavailable).toBe("already known from Ranger");
  });

  it("Studded Leather and a longbow", () => {
    expect(sheet.armor_class.total).toBe(12 + sheet.modifiers.dex);
    expect(attack(sheet, "Longbow")?.attack_bonus).toBe(sheet.modifiers.dex + 2);
  });
});

describe("Rogue", () => {
  let build = classBuild("rogue", { background: "criminal" }); // Stealth + Sleight of Hand
  build = set(build, "class:rogue#skills", [
    "acrobatics",
    "perception",
    "investigation",
    "insight",
  ]);
  build = set(build, "class:rogue#equipment", ["a"]);

  it("Expertise only in skills you're proficient in", () => {
    const opts = options(build, "class:rogue#expertise");
    expect(opts.find((o) => o.id === "stealth")?.unavailable).toBeNull();
    expect(opts.find((o) => o.id === "arcana")?.unavailable).toBe("not proficient");
    expect(() =>
      svc.setChoice(build, catalog, "class:rogue#expertise", ["arcana", "stealth"]),
    ).toThrow(/not proficient/);
  });

  it("Expertise doubles the Proficiency Bonus", () => {
    const expert = set(build, "class:rogue#expertise", ["stealth", "perception"]);
    const sheet = computeSheet(expert, catalog);
    // Dex 15+2 = 17 → +3; +2 +2.
    expect(skill(sheet, "stealth")).toMatchObject({ modifier: 3 + 4, expertise: true });
    expect(sheet.passive_perception).toBe(10 + 0 + 4);
  });

  it("losing a proficiency removes its Expertise", () => {
    let expert = set(build, "class:rogue#expertise", ["acrobatics", "stealth"]);
    expert = set(expert, "class:rogue#skills", [
      "athletics",
      "perception",
      "investigation",
      "insight",
    ]);
    expect(expert.choices["class:rogue#expertise"]).toEqual(["stealth"]);
  });

  it("weapons: Simple, and Martial with Finesse or Light", () => {
    const sheet = computeSheet(build, catalog);
    expect(attack(sheet, "Shortsword")?.notes).not.toContain("not proficient");
    const mastery = options(build, "class:rogue#weapon_mastery");
    expect(mastery.find((o) => o.id === "rapier")?.unavailable).toBeNull();
    expect(mastery.find((o) => o.id === "longsword")?.unavailable).toBe("not proficient");
  });

  it("knows Thieves' Cant and one more language", () => {
    expect(computeSheet(build, catalog).languages["thieves-cant"]).toBe("Rogue");
    const opts = options(build, "class:rogue#language");
    expect(opts.find((o) => o.id === "thieves-cant")?.unavailable).toBe("already known from Rogue");
    expect(opts.some((o) => o.id === "sylvan")).toBe(true); // rare languages allowed
  });
});

describe("Sorcerer", () => {
  it("four cantrips, two prepared spells, Charisma", () => {
    // Cha 15 + 2 = 17 → +3.
    const build = autocomplete(
      classBuild("sorcerer", { background: "acolyte", bonus: { cha: 2, wis: 1 } }),
    );
    const sheet = computeSheet(build, catalog);
    expect(sheet.spells.filter((s) => s.level === 0 && s.source === "Sorcerer")).toHaveLength(4);
    expect(sheet.spells.filter((s) => s.level === 1 && s.source === "Sorcerer")).toHaveLength(2);
    expect(sheet.spellcasting.find((s) => s.source === "Sorcerer")?.save_dc).toBe(8 + 2 + 3);
  });
});

describe("Warlock", () => {
  const base = classBuild("warlock");

  it("Pact Magic: one slot, back on a Short Rest", () => {
    const sheet = computeSheet(base, catalog);
    expect(sheet.pact_magic).toEqual({ slots: 1, slot_level: 1 });
    expect(sheet.spell_slots).toEqual([]);
  });

  it("only invocations without prerequisites are offered at level 1", () => {
    const available = options(base, "class:warlock#invocation").filter((o) => !o.unavailable);
    expect(available.map((o) => o.id)).toEqual([
      "armor-of-shadows",
      "eldritch-mind",
      "pact-of-the-blade",
      "pact-of-the-chain",
      "pact-of-the-tome",
    ]);
    const agonizing = options(base, "class:warlock#invocation").find(
      (o) => o.id === "agonizing-blast",
    );
    expect(agonizing?.unavailable).toBe("requires Warlock level 2+");
  });

  it("Armor of Shadows: Mage Armor at will", () => {
    const build = set(base, "class:warlock#invocation", ["armor-of-shadows"]);
    const sheet = computeSheet(build, catalog);
    expect(sheet.armor_class.total).toBe(13 + sheet.modifiers.dex);
    expect(sheet.armor_class.parts[0]?.source).toBe("Mage Armor");
  });

  it("Armor of Shadows loses to better worn armor", () => {
    let build = set(base, "class:warlock#invocation", ["armor-of-shadows"]);
    build = set(build, "class:warlock#equipment", ["a"]); // Leather: 11 + Dex < 13 + Dex
    expect(computeSheet(build, catalog).armor_worn).toBeNull();
  });

  it("Pact of the Tome: any cantrips, and level 1 rituals from any list", () => {
    const build = set(base, "class:warlock#invocation", ["pact-of-the-tome"]);
    const rituals = options(build, "feature:pact-of-the-tome@class:warlock#invocation#rituals").map(
      (o) => o.id,
    );
    expect(rituals).toContain("find-familiar"); // Wizard list
    expect(rituals).toContain("speak-with-animals"); // Druid list
    expect(rituals).not.toContain("magic-missile"); // not a ritual
    const cantrips = options(
      build,
      "feature:pact-of-the-tome@class:warlock#invocation#cantrips",
    ).map((o) => o.id);
    expect(cantrips).toContain("sacred-flame"); // Cleric list
  });

  it("Pact of the Chain: Find Familiar", () => {
    const build = set(base, "class:warlock#invocation", ["pact-of-the-chain"]);
    expect(computeSheet(build, catalog).spells.map((s) => s.id)).toContain("find-familiar");
  });
});

describe("Wizard", () => {
  const book = [
    "detect-magic",
    "feather-fall",
    "mage-armor",
    "magic-missile",
    "sleep",
    "thunderwave",
  ];
  let build = classBuild("wizard", { background: "sage" });
  build = set(build, "class:wizard#cantrips", ["light", "mage-hand", "ray-of-frost"]);
  build = set(build, "class:wizard#spellbook", book);

  it("prepares only from the spellbook", () => {
    expect(options(build, "class:wizard#prepared").map((o) => o.id)).toEqual(book);
    expect(() => svc.setChoice(build, catalog, "class:wizard#prepared", ["shield"])).toThrow(
      /isn't an option/,
    );
  });

  it("lists the spellbook separately from prepared spells", () => {
    const prepared = set(build, "class:wizard#prepared", [
      "magic-missile",
      "sleep",
      "mage-armor",
      "detect-magic",
    ]);
    const sheet = computeSheet(prepared, catalog);
    expect(sheet.spellbook).toEqual(book);
    expect(
      sheet.spells
        .filter((s) => s.level === 1)
        .map((s) => s.id)
        .sort(),
    ).toEqual(["detect-magic", "mage-armor", "magic-missile", "sleep"]);
    // Int 15 + 2 (Sage) = 17 → +3.
    expect(sheet.spellcasting[0]).toMatchObject({ ability: "int", save_dc: 13, attack_bonus: 5 });
    expect(evaluate(prepared, catalog).report.is_complete).toBe(false); // skills, equipment…
    expect(reportErrors(evaluate(prepared, catalog).report)).toEqual([]);
  });

  it("removing a spell from the spellbook unprepares it", () => {
    let b = set(build, "class:wizard#prepared", [
      "magic-missile",
      "sleep",
      "mage-armor",
      "detect-magic",
    ]);
    const { build: next, notes } = svc.setChoice(b, catalog, "class:wizard#spellbook", [
      ...book.filter((s) => s !== "sleep"),
      "shield",
    ]);
    b = next;
    expect(b.choices["class:wizard#prepared"]).not.toContain("sleep");
    expect(notes).toEqual(["Wizard prepared spells: removed Sleep (no longer available)."]);
  });
});

describe("species spellcasting", () => {
  it("Tiefling legacy cantrips use the chosen ability", () => {
    let build = classBuild("fighter", { species: "tiefling", bonus: { str: 2, con: 1 } });
    build = set(build, "species:tiefling#legacy", ["infernal"]);
    build = set(build, "species:tiefling#spellcasting_ability", ["cha"]);
    const sheet = computeSheet(build, catalog);
    // Fighter standard array: Cha 12 → +1.
    expect(sheet.spellcasting).toEqual([
      expect.objectContaining({ source: "Tiefling", list: null, ability: "cha", save_dc: 11 }),
    ]);
    expect([...sheet.cantrips].sort()).toEqual(["fire-bolt", "thaumaturgy"]);
  });

  it("Forest Gnome always has Speak with Animals prepared", () => {
    const build = set(classBuild("wizard", { species: "gnome" }), "species:gnome#lineage", [
      "forest-gnome",
    ]);
    const spell = computeSheet(build, catalog).spells.find((s) => s.id === "speak-with-animals");
    expect(spell).toMatchObject({ always_prepared: true, source: "Forest Gnome (Gnome)" });
  });
});
