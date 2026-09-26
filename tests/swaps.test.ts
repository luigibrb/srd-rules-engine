import { describe, expect, it } from "vitest";
import {
  type ActiveChoice,
  type CharacterBuild,
  computeSheet,
  evaluate,
  reportErrors,
  resolve,
} from "../src/index";
import * as svc from "../src/services/builder";
import { apply, autocomplete, catalog, classBuild, levelUpIn } from "./helpers";

const set = (b: CharacterBuild, key: string, values: string[]) =>
  apply(b, svc.setChoice, key, values);
const choice = (b: CharacterBuild, key: string) => {
  const c = resolve(b, catalog).choice(key);
  if (!c) throw new Error(`no choice ${key}`);
  return c as ActiveChoice;
};
const levelOf = (id: string) => catalog.spells[id]?.level;
/** The first legal replacement for `old`, optionally of a given spell level. */
const freeNew = (b: CharacterBuild, key: string, old: string, level?: number) => {
  const found = resolve(b, catalog)
    .replaceNew(choice(b, key), old)
    .find((o) => !o.unavailable && (level === undefined || levelOf(o.id) === level));
  if (!found) throw new Error(`no free replacement for ${old}`);
  return found.id;
};

describe("Bard: replace one cantrip and one prepared spell per Bard level", () => {
  let bard = classBuild("bard"); // Soldier: no Magic Initiate
  bard = set(bard, "class:bard#cantrips", ["vicious-mockery", "dancing-lights"]);
  bard = set(bard, "class:bard#prepared", ["charm-person", "healing-word", "sleep", "heroism"]);
  bard = levelUpIn(autocomplete(bard), "bard", 4);
  const cantripSwap = "class:bard:5#replace:bard:bard-cantrips";
  const preparedSwap = "class:bard:5#replace:bard:bard-prepared";

  it("offers optional replacements at each Bard level", () => {
    const res = resolve(bard, catalog);
    expect(res.choicesForLevel(5).map((c) => c.key)).toEqual(
      expect.arrayContaining([cantripSwap, preparedSwap]),
    );
    expect(res.required(choice(bard, cantripSwap))).toBe(0);
    expect(reportErrors(evaluate(bard, catalog).report)).toEqual([]);
  });

  it("replaces a cantrip", () => {
    const old = resolve(bard, catalog)
      .replaceOld(choice(bard, cantripSwap))
      .map((o) => o.id);
    expect(old).toEqual(expect.arrayContaining(["vicious-mockery", "dancing-lights"]));
    const replacement = freeNew(bard, cantripSwap, "dancing-lights");
    const b = set(bard, cantripSwap, ["dancing-lights", replacement]);
    const sheet = computeSheet(b, catalog);
    expect(sheet.cantrips).toContain(replacement);
    expect(sheet.cantrips).not.toContain("dancing-lights");
  });

  it("a replacement can use the spell levels you have now", () => {
    const b = set(bard, preparedSwap, ["charm-person", "dispel-magic"]);
    const ids = computeSheet(b, catalog).spells.map((s) => s.id);
    expect(ids).toContain("dispel-magic");
    expect(ids).not.toContain("charm-person");
    expect(levelOf("dispel-magic")).toBe(3);
  });

  it("…but not levels you didn't have yet", () => {
    const two = "class:bard:2#replace:bard:bard-prepared";
    expect(() => svc.setChoice(bard, catalog, two, ["charm-person", "dispel-magic"])).toThrow(
      /can't replace/,
    );
  });

  it("one replacement per family per level; clearing it restores the original", () => {
    expect(() =>
      svc.setChoice(bard, catalog, cantripSwap, [
        "dancing-lights",
        "light",
        "vicious-mockery",
        "x",
      ]),
    ).toThrow(/what to replace and its replacement/);
    const swapped = set(bard, cantripSwap, [
      "dancing-lights",
      freeNew(bard, cantripSwap, "dancing-lights"),
    ]);
    const undone = set(swapped, cantripSwap, []);
    expect(computeSheet(undone, catalog).cantrips).toContain("dancing-lights");
  });

  it("a later replacement can replace an earlier replacement", () => {
    const first = freeNew(bard, cantripSwap, "dancing-lights");
    let b = set(bard, cantripSwap, ["dancing-lights", first]);
    b = levelUpIn(b, "bard");
    const sixKey = "class:bard:6#replace:bard:bard-cantrips";
    // (Taking Dancing Lights back would be legal too; pick something else to see the chain.)
    const second = resolve(b, catalog)
      .replaceNew(choice(b, sixKey), first)
      .find((o) => !o.unavailable && o.id !== "dancing-lights")?.id as string;
    b = set(b, sixKey, [first, second]);
    const cantrips = computeSheet(b, catalog).cantrips;
    expect(cantrips).toContain(second);
    expect(cantrips).not.toContain(first);
    expect(cantrips).not.toContain("dancing-lights");
    expect(reportErrors(evaluate(b, catalog).report)).toEqual([]);
  });

  it("changing the original pick invalidates a replacement of it", () => {
    let b = set(bard, cantripSwap, [
      "dancing-lights",
      freeNew(bard, cantripSwap, "dancing-lights"),
    ]);
    const other = resolve(b, catalog)
      .options(choice(b, "class:bard#cantrips"))
      .find((o) => !o.unavailable && o.id !== "dancing-lights" && o.id !== "vicious-mockery")
      ?.id as string;
    const { build, notes } = svc.setChoice(b, catalog, "class:bard#cantrips", [
      "vicious-mockery",
      other,
    ]);
    b = build;
    expect(b.choices[cantripSwap]).toEqual([]);
    expect(notes.some((n) => n.includes("Replace one"))).toBe(true);
  });
});

describe("same-level replacements", () => {
  it("Mystic Arcanum: another Warlock spell of the same level", () => {
    const warlock = levelUpIn(autocomplete(classBuild("warlock")), "warlock", 12);
    const key = "class:warlock:13#replace:warlock:warlock-arcanum";
    const c = choice(warlock, key);
    const res = resolve(warlock, catalog);
    const [level6] = res
      .replaceOld(c)
      .map((o) => o.id)
      .filter((id) => levelOf(id) === 6);
    expect(level6).toBeDefined();
    const news = res.replaceNew(c, level6);
    expect(news.length).toBeGreaterThan(0);
    expect(news.every((o) => levelOf(o.id) === 6)).toBe(true);
    expect(() => svc.setChoice(warlock, catalog, key, [level6 as string, "forcecage"])).toThrow();
  });

  it("Magic Initiate: on any level-up, same level, same list", () => {
    let b = classBuild("fighter", { background: "sage" }); // Magic Initiate (Wizard)
    b = set(b, "feat:magic-initiate@background:sage#cantrips", ["fire-bolt", "mage-hand"]);
    b = set(b, "feat:magic-initiate@background:sage#spell", ["shield"]);
    b = levelUpIn(autocomplete(b), "fighter");
    const key = "class:fighter:2#replace:feat:magic-initiate@background:sage:magic-initiate";
    const c = choice(b, key);
    const res = resolve(b, catalog);
    expect(res.replaceNew(c, "fire-bolt").every((o) => levelOf(o.id) === 0)).toBe(true);
    expect(res.replaceNew(c, "shield").every((o) => levelOf(o.id) === 1)).toBe(true);
    expect(res.replaceNew(c, "fire-bolt").map((o) => o.id)).not.toContain("sacred-flame"); // Cleric
    b = set(b, key, ["shield", "magic-missile"]);
    const spells = computeSheet(b, catalog).spells;
    expect(spells.find((s) => s.id === "magic-missile")?.always_prepared).toBe(true);
    expect(spells.map((s) => s.id)).not.toContain("shield");
  });
});

describe("Warlock invocations", () => {
  let base = classBuild("warlock");
  base = set(base, "class:warlock#invocation", ["pact-of-the-blade"]);
  base = levelUpIn(autocomplete(base), "warlock", 3);

  it("can't replace an invocation another one requires", () => {
    let b = svc.levelUp(base, catalog, "warlock").build; // level 5
    b = set(b, "class:warlock:5#invocations", ["thirsting-blade", "eldritch-smite"]);
    b = levelUpIn(autocomplete(b), "warlock"); // level 6
    const key = "class:warlock:6#replace:warlock:warlock-invocations";
    const old = resolve(b, catalog).replaceOld(choice(b, key));
    expect(old.find((o) => o.id === "pact-of-the-blade")?.unavailable).toMatch(/requires it/);
    expect(() => svc.setChoice(b, catalog, key, ["pact-of-the-blade", "armor-of-shadows"])).toThrow(
      /can't be replaced/,
    );
  });

  it("replacing an invocation removes what it gave, choices included", () => {
    let b = classBuild("warlock");
    b = set(b, "class:warlock#invocation", ["pact-of-the-tome"]);
    b = autocomplete(b);
    const tome = "feature:pact-of-the-tome@class:warlock#invocation#cantrips";
    expect(resolve(b, catalog).choice(tome)).toBeDefined();
    // Level up without auto-picking, so Armor of Shadows is still free for the replacement.
    b = svc.levelUp(b, catalog, "warlock").build;
    b = set(b, "class:warlock:2#replace:warlock:warlock-invocations", [
      "pact-of-the-tome",
      "armor-of-shadows",
    ]);
    b = autocomplete(b);
    const res = resolve(b, catalog);
    expect(res.choice(tome)).toBeUndefined();
    expect(b.choices[tome]).toBeUndefined(); // dropped by normalize
    const sheet = computeSheet(b, catalog);
    expect(sheet.features).toContain("Armor of Shadows");
    expect(sheet.features).not.toContain("Pact of the Tome");
    expect(sheet.armor_class.parts[0]?.source).toBe("Mage Armor");
    expect(reportErrors(evaluate(b, catalog).report)).toEqual([]);
  });
});

describe("Fighter: replace the Fighting Style at a Fighter level only", () => {
  it("is offered at Fighter levels, not at other classes' levels", () => {
    let b = classBuild("fighter");
    b = set(b, "class:fighter#fighting_style", ["defense"]);
    b = levelUpIn(autocomplete(b), "rogue"); // level 2: Rogue 1
    b = levelUpIn(b, "fighter"); // level 3: Fighter 2
    const keys = resolve(b, catalog).choices.map((c) => c.key);
    expect(keys).not.toContain("class:rogue#replace:fighter:fighter-style");
    expect(keys).toContain("class:fighter:2#replace:fighter:fighter-style");
    b = set(b, "class:fighter:2#replace:fighter:fighter-style", ["defense", "archery"]);
    const sheet = computeSheet(b, catalog);
    expect(sheet.feats).toContain("Archery");
    expect(sheet.feats).not.toContain("Defense");
  });
});

describe("pools: lists you can change after a rest", () => {
  it("Cleric prepared spells: one list that grows, with the levels you have now", () => {
    let b = levelUpIn(autocomplete(classBuild("cleric")), "cleric", 3); // Cleric 4
    const key = "class:cleric#prepared";
    const res4 = resolve(b, catalog);
    expect(res4.countOf(choice(b, key))).toBe(7);
    expect(res4.maxSpellLevelOf(choice(b, key))).toBe(2);
    expect(res4.options(choice(b, key)).some((o) => levelOf(o.id) === 3)).toBe(false);
    b = levelUpIn(b, "cleric"); // Cleric 5: 9 prepared, level 3 spells
    const res5 = resolve(b, catalog);
    expect(res5.countOf(choice(b, key))).toBe(9);
    const all = res5.options(choice(b, key)).filter((o) => !o.unavailable);
    const pick = [
      ...all.filter((o) => levelOf(o.id) === 3).slice(0, 5),
      ...all.filter((o) => levelOf(o.id) === 1).slice(0, 4),
    ];
    b = set(
      b,
      key,
      pick.map((o) => o.id),
    );
    expect(reportErrors(evaluate(b, catalog).report)).toEqual([]);
    expect(
      computeSheet(b, catalog).spells.filter((s) => s.level === 3 && !s.always_prepared),
    ).toHaveLength(5);
  });

  it("Weapon Mastery grows with the Fighter table", () => {
    const f = autocomplete(classBuild("fighter"));
    const key = "class:fighter#weapon_mastery";
    const four = svc.levelUp(levelUpIn(f, "fighter", 2), catalog, "fighter").build;
    expect(resolve(four, catalog).countOf(choice(four, key))).toBe(4);
    const issues = evaluate(four, catalog).report.issues.filter((i) => i.choice_key === key);
    expect(issues.map((i) => i.message)).toEqual(["Weapon Mastery: choose 1 more"]);
    const sixteen = levelUpIn(f, "fighter", 15);
    expect(computeSheet(sixteen, catalog).weapon_masteries).toHaveLength(6);
  });
});
