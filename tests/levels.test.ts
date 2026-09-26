import { describe, expect, it } from "vitest";
import {
  BuildError,
  type CharacterBuild,
  computeSheet,
  evaluate,
  issuesForLevel,
  parseBuild,
  reportErrors,
  resolve,
  seededRng,
} from "../src/index";
import * as svc from "../src/services/builder";
import { apply, autocomplete, catalog, classBuild, levelUpIn } from "./helpers";

const sheetOf = (b: CharacterBuild) => computeSheet(b, catalog);
const set = (b: CharacterBuild, key: string, values: string[]) =>
  apply(b, svc.setChoice, key, values);
const complete = (b: CharacterBuild) => {
  const open = evaluate(b, catalog).report.issues.filter((i) => i.severity !== "note");
  expect(open).toEqual([]);
};

describe("every class can reach level 20", () => {
  for (const classId of Object.keys(catalog.classes)) {
    it(classId, () => {
      const start = autocomplete(classBuild(classId));
      const build = levelUpIn(start, classId, 19);
      complete(build);
      const sheet = sheetOf(build);
      expect(sheet.level).toBe(20);
      expect(sheet.proficiency_bonus).toBe(6);
      expect(sheet.classes).toEqual([expect.objectContaining({ class_id: classId, level: 20 })]);
      expect(sheet.classes[0]?.subclass).not.toBeNull();
    });
  }
});

describe("level-up basics", () => {
  const fighter = autocomplete(classBuild("fighter", { bonus: { str: 1, con: 2 } })); // Str 16, Con 15

  it("proficiency bonus follows the character level", () => {
    expect(sheetOf(levelUpIn(fighter, "fighter", 3)).proficiency_bonus).toBe(2);
    expect(sheetOf(levelUpIn(fighter, "fighter", 4)).proficiency_bonus).toBe(3);
    expect(sheetOf(levelUpIn(fighter, "fighter", 8)).proficiency_bonus).toBe(4);
  });

  it("fixed Hit Points: max die, then die/2 + 1, plus Con every level", () => {
    const five = levelUpIn(fighter, "fighter", 4);
    const hp = sheetOf(five).max_hp;
    // Con 15 → +2: 10 + 4 × 6 + 5 × 2.
    expect(hp?.total).toBe(10 + 24 + 10);
    expect(hp?.parts.map((p) => p.source)).toEqual(["Fighter d10", "Fighter ×4 fixed", "Con ×5"]);
  });

  it("rolled Hit Points are stored and validated", () => {
    let b = svc.levelUp(fighter, catalog, "fighter", 3).build;
    expect(b.levels).toEqual([{ class_id: "fighter", hp: 3 }]);
    expect(sheetOf(b).max_hp?.total).toBe(10 + 3 + 2 * 2);
    b = apply(b, svc.setLevelHp, 2, null);
    expect(sheetOf(b).max_hp?.total).toBe(10 + 6 + 2 * 2);
    expect(() => svc.levelUp(fighter, catalog, "fighter", 11)).toThrow(/between 1 and 10/);
  });

  it("at least 1 Hit Point per level", () => {
    let weak = classBuild("wizard");
    weak = apply(weak, svc.setAbilityMethod, "point_buy");
    weak = apply(weak, svc.setBaseScores, { str: 8, dex: 14, con: 8, int: 15, wis: 12, cha: 8 });
    weak = apply(weak, svc.setBackgroundBonus, { str: 2, dex: 1 }); // Soldier; Con 8 → -1
    const b = svc.levelUp(weak, catalog, "wizard", 1).build; // rolled 1 - 1 = 0 → 1
    const hp = sheetOf(b).max_hp;
    expect(hp?.total).toBe(6 - 1 + 1);
    expect(hp?.parts.at(-1)).toEqual({ source: "minimum 1 HP per level", value: 1 });
  });

  it("level-up choices are asked at their level and reported by level", () => {
    const b = svc.levelUp(fighter, catalog, "fighter").build;
    const three = svc.levelUp(b, catalog, "fighter").build;
    const ev = evaluate(three, catalog);
    expect(ev.resolution.choicesForLevel(3).map((c) => c.key)).toEqual([
      "class:fighter:3#subclass",
    ]);
    expect(issuesForLevel(ev.report, 3).map((i) => i.message)).toEqual([
      "Fighter subclass: choose 1 more",
    ]);
    expect(svc.levelComplete(ev, 2)).toBe(true);
    expect(svc.levelComplete(ev, 3)).toBe(false);
  });

  it("removing the last level drops its choices", () => {
    const four = levelUpIn(fighter, "fighter", 3);
    expect(four.choices["class:fighter:4#feat"]).toBeDefined();
    const { build, notes } = svc.removeLastLevel(four, catalog);
    expect(build.levels).toHaveLength(2);
    expect(build.choices["class:fighter:4#feat"]).toBeUndefined();
    expect(notes[0]).toBe("Removed level 4.");
  });

  it("stops at level 20", () => {
    const twenty = levelUpIn(fighter, "fighter", 19);
    expect(() => svc.levelUp(twenty, catalog, "fighter")).toThrow(/already level 20/);
  });

  it("level-ups need a finished level 1 class", () => {
    const options = svc.levelUpOptions(classBuild("fighter"), catalog);
    expect(options.find((o) => o.class_id === "fighter")).toMatchObject({
      class_level: 2,
      fixed_hp: 6,
      unavailable: null,
    });
  });
});

describe("the brief's example characters", () => {
  it("level 5 Paladin, Str 16, longsword: +6 to hit, 1d8+3, two attacks", () => {
    let b = autocomplete(classBuild("paladin", { bonus: { str: 1, con: 2 } }));
    b = set(b, "class:paladin#equipment", ["a"]);
    b = levelUpIn(b, "paladin", 4);
    const sheet = sheetOf(b);
    expect(sheet.scores.str).toBe(16);
    const longsword = sheet.attacks.find((a) => a.name === "Longsword");
    expect(longsword).toMatchObject({ attack_bonus: 6, damage: "1d8+3 (1d10+3 two-handed)" });
    expect(sheet.attacks_per_action).toBe(2);
  });

  it("level 11 Fighter attacks three times, level 20 four times", () => {
    const f = autocomplete(classBuild("fighter"));
    expect(sheetOf(levelUpIn(f, "fighter", 10)).attacks_per_action).toBe(3);
    expect(sheetOf(levelUpIn(f, "fighter", 19)).attacks_per_action).toBe(4);
  });
});

describe("ability score improvements and feats", () => {
  const four = levelUpIn(
    autocomplete(classBuild("fighter", { bonus: { str: 2, con: 1 } })),
    "fighter",
    3,
  );

  it("Ability Score Improvement: +2 to one score, up to 20", () => {
    let b = set(four, "class:fighter:4#feat", ["ability-score-improvement"]);
    const key = "feat:ability-score-improvement@class:fighter:4#feat#increase";
    b = set(b, key, ["str", "str"]);
    expect(sheetOf(b).scores.str).toBe(19);
    b = set(b, key, ["str", "con"]);
    expect(sheetOf(b).scores.str).toBe(18);
    expect(sheetOf(b).scores.con).toBe(15);
  });

  it("can't raise a score past 20", () => {
    let b = apply(four, svc.setBaseScores, { str: 15, dex: 14, con: 13, int: 8, wis: 10, cha: 12 });
    b = apply(b, svc.setBackgroundBonus, { str: 2, con: 1 });
    b = set(b, "class:fighter:4#feat", ["ability-score-improvement"]);
    const key = "feat:ability-score-improvement@class:fighter:4#feat#increase";
    b = set(b, key, ["str", "str"]); // 17 → 19
    b = levelUpIn(b, "fighter", 2); // level 6: another ASI (autocompleted with Str/Dex +1)
    b = set(b, "class:fighter:6#feat", ["ability-score-improvement"]);
    const six = "feat:ability-score-improvement@class:fighter:6#feat#increase";
    expect(() => svc.setChoice(b, catalog, six, ["str", "str"])).toThrow(/can't exceed 20/);
    b = set(b, six, ["str", "dex"]);
    expect(sheetOf(b).scores.str).toBe(20);
    const opts = resolve(b, catalog).options(resolve(b, catalog).choice(six) as never);
    expect(opts.find((o) => o.id === "str")?.unavailable).toBeNull(); // 19 before this level
  });

  it("feat prerequisites: level, abilities, and features", () => {
    const res = resolve(autocomplete(classBuild("fighter")), catalog);
    const humanFeat = res.choice("species:human#versatile");
    const ids = new Map(res.options(humanFeat as never).map((o) => [o.id, o.unavailable]));
    expect(ids.has("grappler")).toBe(false); // origin category only
    const res4 = resolve(four, catalog);
    const asi = new Map(
      res4.options(res4.choice("class:fighter:4#feat") as never).map((o) => [o.id, o.unavailable]),
    );
    expect(asi.get("ability-score-improvement")).toBeNull();
    expect(asi.get("grappler")).toBeNull(); // Str 17
    expect(asi.get("boon-of-fate")).toBe("requires level 19+");
    expect(asi.get("great-weapon-fighting")).toBeNull(); // Fighters have the Fighting Style feature
    const wizard = levelUpIn(autocomplete(classBuild("wizard")), "wizard", 3);
    const resW = resolve(wizard, catalog);
    const wizardAsi = new Map(
      resW.options(resW.choice("class:wizard:4#feat") as never).map((o) => [o.id, o.unavailable]),
    );
    expect(wizardAsi.get("great-weapon-fighting")).toBe("requires the Fighting Style feature");
  });

  it("Primal Champion raises Strength and Constitution to 25", () => {
    const barbarian = levelUpIn(autocomplete(classBuild("barbarian")), "barbarian", 19);
    const sheet = sheetOf(barbarian);
    expect(sheet.scores.str).toBeGreaterThan(20);
    expect(sheet.scores.str).toBeLessThanOrEqual(25);
  });
});

describe("multiclassing", () => {
  const fighter = autocomplete(classBuild("fighter", { bonus: { str: 2, con: 1 } })); // Int 8

  it("needs 13 in the primary abilities of the old and the new class", () => {
    const wizard = svc.levelUpOptions(fighter, catalog).find((o) => o.class_id === "wizard");
    expect(wizard?.unavailable).toBe("Wizard needs Intelligence 13+");
    expect(() => svc.levelUp(fighter, catalog, "wizard")).toThrow(BuildError);
    const rogue = svc.levelUpOptions(fighter, catalog).find((o) => o.class_id === "rogue");
    expect(rogue?.unavailable).toBeNull(); // Dex 14
  });

  it("the Monk needs Dexterity and Wisdom", () => {
    const monk = svc.levelUpOptions(fighter, catalog).find((o) => o.class_id === "monk");
    expect(monk?.unavailable).toBe("Monk needs Dexterity and Wisdom 13+");
  });

  it("gains only the multiclass proficiencies", () => {
    const b = levelUpIn(fighter, "rogue");
    const sheet = sheetOf(b);
    expect(
      Object.entries(sheet.saving_throws)
        .filter(([, s]) => s.proficient)
        .map(([a]) => a),
    ).toEqual(["str", "con"]);
    expect(sheet.tools["thieves-tools"]).toBe("Rogue");
    const skills = resolve(b, catalog).choice("class:rogue#skills");
    expect(skills?.definition.count).toBe(1);
    expect(skills?.level).toBe(2);
    // Rogue level 1 features still apply: Expertise, Sneak Attack, Weapon Mastery.
    expect(resolve(b, catalog).choice("class:rogue#expertise")).toBeDefined();
    expect(sheet.resources).toContainEqual({
      class_id: "rogue",
      name: "Sneak Attack",
      value: "1d6",
    });
    expect(sheet.hit_dice).toEqual({ "10": 1, "8": 1 });
  });

  it("combines spell slots (SRD example: Ranger 4 / Sorcerer 3 = four 1st, three 2nd, two 3rd)", () => {
    let b = autocomplete(classBuild("ranger"));
    // Ranger needs Dex and Wis 13+, Sorcerer Cha 13+ (standard array).
    b = apply(b, svc.setBaseScores, { str: 10, dex: 15, con: 12, int: 8, wis: 13, cha: 14 });
    b = apply(b, svc.setBackgroundBonus, { str: 1, dex: 2 });
    b = levelUpIn(b, "ranger", 3);
    b = levelUpIn(b, "sorcerer", 3);
    const sheet = sheetOf(b);
    expect(sheet.classes.map((c) => [c.class_id, c.level])).toEqual([
      ["ranger", 4],
      ["sorcerer", 3],
    ]);
    expect(sheet.spell_slots).toEqual([4, 3, 2]);
    complete(b);
  });

  it("a Paladin alone uses the Paladin table (half casters round up)", () => {
    // Paladin Features table: slots at levels 1, 3, 5, 9, 17, 19.
    const table: Record<number, number[]> = {
      1: [2],
      2: [2],
      3: [3],
      5: [4, 2],
      9: [4, 3, 2],
      13: [4, 3, 3, 1],
      17: [4, 3, 3, 3, 1],
      19: [4, 3, 3, 3, 2],
    };
    let b = autocomplete(classBuild("paladin"));
    for (let level = 1; level <= 20; level++) {
      if (level > 1) b = levelUpIn(b, "paladin");
      const expected = table[level];
      if (expected) expect(sheetOf(b).spell_slots, `level ${level}`).toEqual(expected);
    }
  });

  it("Pact Magic is separate from Spellcasting slots", () => {
    let b = autocomplete(classBuild("warlock"));
    b = apply(b, svc.setBaseScores, { str: 8, dex: 14, con: 12, int: 13, wis: 10, cha: 15 });
    b = apply(b, svc.setBackgroundBonus, { str: 2, dex: 1 }); // Int 13, Cha 15
    b = levelUpIn(b, "warlock", 2); // Warlock 3: two level 2 slots
    b = levelUpIn(b, "wizard", 2); // Wizard 2: three level 1 slots
    const sheet = sheetOf(b);
    expect(sheet.pact_magic).toEqual({ slots: 2, slot_level: 2 });
    expect(sheet.spell_slots).toEqual([3]);
  });

  it("Extra Attack from two classes doesn't stack", () => {
    let b = autocomplete(classBuild("fighter", { bonus: { str: 2, con: 1 } }));
    b = apply(b, svc.setBaseScores, { str: 15, dex: 12, con: 13, int: 8, wis: 10, cha: 14 });
    b = apply(b, svc.setBackgroundBonus, { str: 2, con: 1 });
    b = levelUpIn(b, "fighter", 4);
    b = levelUpIn(b, "paladin", 5);
    expect(sheetOf(b).attacks_per_action).toBe(2);
  });
});

describe("subclasses", () => {
  it("Champion: critical hits on 19-20, then 18-20", () => {
    let b = levelUpIn(autocomplete(classBuild("fighter")), "fighter", 2);
    b = set(b, "class:fighter:3#subclass", ["champion"]);
    expect(sheetOf(b).critical_hit_on).toBe(19);
    b = levelUpIn(b, "fighter", 12);
    expect(sheetOf(b).critical_hit_on).toBe(18);
  });

  it("Life Domain spells arrive with Cleric levels", () => {
    let b = levelUpIn(autocomplete(classBuild("cleric")), "cleric", 2);
    b = set(b, "class:cleric:3#subclass", ["life-domain"]);
    const ids = () =>
      sheetOf(b)
        .spells.filter((s) => s.always_prepared)
        .map((s) => s.id);
    expect(ids()).toEqual(
      expect.arrayContaining(["aid", "bless", "cure-wounds", "lesser-restoration"]),
    );
    expect(ids()).not.toContain("revivify");
    b = levelUpIn(b, "cleric", 2);
    expect(ids()).toContain("revivify");
  });

  it("Circle of the Land: spells and resistance follow the land type", () => {
    let b = levelUpIn(autocomplete(classBuild("druid")), "druid", 2);
    b = set(b, "class:druid:3#subclass", ["circle-of-the-land"]);
    b = set(b, "subclass:circle-of-the-land:3#land", ["arid"]);
    b = levelUpIn(b, "druid", 7);
    const sheet = sheetOf(b);
    expect(sheet.spells.map((s) => s.id)).toEqual(
      expect.arrayContaining(["fire-bolt", "fireball", "blight", "wall-of-stone"]),
    );
    expect(sheet.resistances).toContain("fire");
  });

  it("Draconic Sorcery: +1 HP per Sorcerer level and Draconic Resilience AC", () => {
    let b = levelUpIn(autocomplete(classBuild("sorcerer")), "sorcerer", 2);
    b = set(b, "class:sorcerer:3#subclass", ["draconic-sorcery"]);
    const sheet = sheetOf(b);
    expect(sheet.max_hp?.parts.at(-1)).toEqual({ source: "Draconic Sorcery", value: 3 });
    expect(sheet.armor_class.parts[0]?.source).toBe("Draconic Resilience");
  });
});

describe("class features", () => {
  it("Wizard spellbook grows by two spells per level", () => {
    const b = levelUpIn(autocomplete(classBuild("wizard")), "wizard", 4);
    const sheet = sheetOf(b);
    // 6 at level 1, 2 per level, and the Evoker's free evocation spells (2 at 3, 1 at 5).
    expect(sheet.spellbook).toHaveLength(6 + 2 * 4 + 2 + 1);
    expect(sheet.spells.filter((s) => s.level > 0 && !s.always_prepared)).toHaveLength(9);
    expect(sheet.spell_slots).toEqual([4, 3, 2]);
  });

  it("Bard Jack of All Trades adds half the Proficiency Bonus to other skills", () => {
    const one = sheetOf(autocomplete(classBuild("bard")));
    const two = sheetOf(levelUpIn(autocomplete(classBuild("bard")), "bard"));
    const unproficient = one.skills.find((s) => !s.proficient_from);
    const after = two.skills.find((s) => s.skill === unproficient?.skill);
    expect((after?.modifier ?? 0) - (unproficient?.modifier ?? 0)).toBe(1);
  });

  it("Monk Unarmored Movement and Martial Arts die", () => {
    const monk = autocomplete(classBuild("monk"));
    expect(sheetOf(levelUpIn(monk, "monk", 1)).speed.total).toBe(40);
    const eleven = sheetOf(levelUpIn(monk, "monk", 10));
    expect(eleven.speed.total).toBe(50);
    expect(eleven.attacks.find((a) => a.name === "Unarmed Strike")?.damage).toMatch(/^1d10/);
    expect(eleven.resources).toContainEqual({ class_id: "monk", name: "Focus Points", value: 11 });
  });

  it("Paladin Aura of Protection adds Charisma to every save", () => {
    const b = autocomplete(classBuild("paladin"));
    const five = sheetOf(levelUpIn(b, "paladin", 4));
    const six = sheetOf(levelUpIn(b, "paladin", 5));
    expect(six.saving_throws.dex.modifier - five.saving_throws.dex.modifier).toBe(
      Math.max(1, six.modifiers.cha),
    );
  });

  it("Warlock invocations need their prerequisites", () => {
    let b = levelUpIn(autocomplete(classBuild("warlock")), "warlock", 4);
    const res = resolve(b, catalog);
    const choice = res.choicesForLevel(5).find((c) => c.definition.kind === "feature");
    const opts = new Map(res.options(choice as never).map((o) => [o.id, o.unavailable]));
    expect(opts.get("thirsting-blade")).toBe("requires Pact of the Blade");
    expect(opts.get("witch-sight")).toBe("requires Warlock level 15+");
    expect(opts.get("ascendant-step")).toBeNull();
    b = autocomplete(b);
    expect(reportErrors(evaluate(b, catalog).report)).toEqual([]);
  });
});

describe("random multiclass paths (seeded)", () => {
  it("stay valid all the way to level 20", () => {
    const rng = seededRng(2024);
    const classIds = Object.keys(catalog.classes);
    for (let run = 0; run < 12; run++) {
      const start = classIds[rng.int(0, classIds.length - 1)] as string;
      // 26 points: 13+ in Str, Dex, Int and Cha allows most multiclass combinations.
      let b = classBuild(start);
      b = apply(b, svc.setAbilityMethod, "point_buy");
      b = apply(b, svc.setBaseScores, { str: 13, dex: 13, con: 10, int: 13, wis: 12, cha: 13 });
      b = apply(b, svc.setBackgroundBonus, { str: 1, dex: 1, con: 1 });
      b = autocomplete(b);
      const path = [start];
      for (let level = 2; level <= 20; level++) {
        const options = svc.levelUpOptions(b, catalog).filter((o) => !o.unavailable);
        const pick = options[rng.int(0, options.length - 1)]?.class_id as string;
        path.push(pick);
        const hp = rng.int(0, 1) ? null : rng.int(1, catalog.classes[pick]?.hit_die ?? 6);
        b = autocomplete(svc.levelUp(b, catalog, pick, hp).build);
      }
      const { report, sheet } = evaluate(b, catalog);
      const open = report.issues.filter((i) => i.severity !== "note");
      expect(open, path.join(" → ")).toEqual([]);
      expect(sheet.level).toBe(20);
      expect(sheet.classes.reduce((n, c) => n + c.level, 0)).toBe(20);
      expect(sheet.max_hp?.total ?? 0).toBeGreaterThan(20);
      // Round-trips as JSON.
      expect(parseBuild(JSON.parse(JSON.stringify(b)))).toEqual(b);
    }
  });
});
