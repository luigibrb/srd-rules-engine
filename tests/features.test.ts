import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyEncounterAction,
  type CharacterBuild,
  type CharacterState,
  castSpell,
  combatantFromCharacter,
  computePlaySheet,
  createEncounter,
  createState,
  lookup,
  makeAttack,
  type PlayAction,
  rollAbilityCheck,
  type Skill,
  type SpellDef,
  scriptedRng,
} from "../src/index";
import * as svc from "../src/services/builder";
import { apply, autocomplete, catalog, classBuild, levelUpIn } from "./helpers";

// SRD 5.2.1 class features that change rolls. Each test builds a concrete character.

const level = (classId: string, n: number, name = "Tester") =>
  levelUpIn(autocomplete(classBuild(classId, { name })), classId, n - 1);
const state = (build: CharacterBuild, ...actions: PlayAction[]) => {
  let s: CharacterState = createState(build, catalog);
  for (const a of actions) s = applyAction(build, s, catalog, a).state;
  return s;
};
const view = (build: CharacterBuild, ...actions: PlayAction[]) =>
  combatantFromCharacter(build, state(build, ...actions), catalog);
const spell = (id: string) => lookup(catalog.spells, id) as SpellDef;

describe("Barbarian", () => {
  const ulla = level("barbarian", 2, "Ulla");

  it("Danger Sense: Advantage on Dexterity saves, unless Incapacitated", () => {
    expect(view(ulla).advantages).toContain("save.dex");
    const stunned = view(ulla, { type: "add_condition", condition: "incapacitated" });
    expect(stunned.advantages).not.toContain("save.dex");
  });

  it("Reckless Attack: Advantage on Strength attacks, and on attacks against you", () => {
    const reckless = view(ulla, { type: "activate", key: "barbarian:reckless-attack" });
    const target = { ...view(ulla), armor_class: 5 };
    const hit = makeAttack(reckless, "Greataxe", target, { rng: scriptedRng([3, 15, 6]) });
    expect(hit.roll.mode).toBe("advantage");
    expect(hit.reasons).toEqual(["Advantage: Ulla's features"]);
    const against = makeAttack(target, "Greataxe", reckless, { rng: scriptedRng([3, 15, 6]) });
    expect(against.reasons).toEqual(["Advantage: Ulla attacks recklessly"]);
  });

  it("Reckless Attack ends at the start of the barbarian's next turn", () => {
    let encounter = createEncounter();
    let ullaState = state(ulla);
    const notes: string[] = [];
    const act = (...actions: Parameters<typeof applyEncounterAction>[1][]) => {
      for (const a of actions) {
        const characters = { ulla: { build: ulla, state: ullaState } };
        const r = applyEncounterAction(encounter, a, { catalog, characters, rng: scriptedRng([]) });
        encounter = r.encounter;
        ullaState = r.states.ulla ?? ullaState;
        notes.push(...r.notes);
      }
    };
    act(
      { type: "add_character", character: "ulla" },
      { type: "add_monster", monster: "goblin-warrior" },
      { type: "set_initiative", id: "ulla", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 10 },
      { type: "start" },
      {
        type: "effects",
        id: "ulla",
        actions: [{ type: "activate", key: "barbarian:reckless-attack" }],
      },
      { type: "next_turn" },
    );
    expect(ullaState.active).toContain("barbarian:reckless-attack");
    act({ type: "next_turn" });
    expect(notes).toContain("Reckless Attack ends: it lasts until the start of Ulla's next turn.");
    expect(ullaState.active).not.toContain("barbarian:reckless-attack");
  });

  it("Feral Instinct: Advantage on Initiative", () => {
    const seven = level("barbarian", 7, "Ulla");
    let encounter = createEncounter();
    const characters = { ulla: { build: seven, state: state(seven) } };
    const ctx = { catalog, characters, rng: scriptedRng([3, 18]) };
    ({ encounter } = applyEncounterAction(
      encounter,
      { type: "add_character", character: "ulla" },
      ctx,
    ));
    const r = applyEncounterAction(encounter, { type: "roll_initiative" }, ctx);
    const bonus = computePlaySheet(seven, state(seven), catalog).initiative.total;
    expect(r.encounter.combatants[0]?.initiative).toBe(18 + bonus);
  });

  it("Frenzy (Berserker): Rage Damage d6s while raging recklessly, once per turn", () => {
    const three = level("barbarian", 3, "Ulla");
    const greataxe = (s: CharacterState) =>
      computePlaySheet(three, s, catalog).attacks.find((a) => a.name === "Greataxe");
    expect(greataxe(state(three, { type: "activate", key: "barbarian:rage" }))?.riders).toEqual([]);
    const both = state(
      three,
      { type: "activate", key: "barbarian:rage" },
      { type: "activate", key: "barbarian:reckless-attack" },
    );
    expect(greataxe(both)?.riders).toEqual([
      expect.objectContaining({ id: "frenzy", dice: "2d6", once_per_turn: true }),
    ]);
  });
});

describe("Rogue", () => {
  const pip = level("rogue", 7, "Pip");

  it("Evasion: no damage on a successful Dexterity save, half on a failure", () => {
    const wizard = view(level("wizard", 5, "Ilse"));
    const rogue = view(pip);
    const dice = Array<number>(8).fill(4); // 8d6 = 32
    const saved = castSpell(wizard, spell("fireball"), [rogue], {
      rng: scriptedRng([20, ...dice]),
    });
    expect(saved.targets[0]?.instances).toEqual([]);
    const failed = castSpell(wizard, spell("fireball"), [rogue], {
      rng: scriptedRng([1, ...dice]),
    });
    expect(failed.targets[0]?.instances).toEqual([{ amount: 16, type: "fire" }]);
  });

  it("Reliable Talent: a d20 of 9 or lower counts as 10 with a proficient skill", () => {
    const rogue = view(pip);
    const skill = rogue.proficient_skills[0] as Skill;
    const check = rollAbilityCheck(rogue, { skill }, null, { rng: scriptedRng([2]) });
    expect(check.roll.d20).toBe(10);
    expect(check.reasons).toContain("Reliable Talent: the d20 counts as 10");
  });
});

describe("damage riders", () => {
  it("Primal Strike (Druid 7): 1d8 of a chosen element, once per turn on weapon hits", () => {
    let druid = level("druid", 7, "Fen");
    druid = apply(druid, svc.setChoice, "class:druid:7#elemental_fury", ["primal-strike"]);
    const sheet = computePlaySheet(druid, state(druid), catalog);
    const weapon = sheet.attacks.find((a) => a.weapon);
    expect(weapon?.riders).toEqual([
      expect.objectContaining({
        id: "primal-strike",
        dice: "1d8",
        type: ["cold", "fire", "lightning", "thunder"],
        once_per_turn: true,
      }),
    ]);
  });

  it("Colossus Slayer (Hunter): 1d8 against a creature missing Hit Points", () => {
    const ranger = view(level("ranger", 3, "Ash"));
    const weapon = ranger.attacks.find((a) => a.weapon)?.name as string;
    const target = { ...ranger, armor_class: 5 };
    const rider = [{ rider: "colossus-slayer" }];
    expect(() => makeAttack(ranger, weapon, target, { riders: rider })).toThrow(
      "Colossus Slayer needs a target that's missing some of its Hit Points",
    );
    const hurt = { ...target, hp: target.max_hp - 1 };
    const hit = makeAttack(ranger, weapon, hurt, {
      riders: rider,
      rng: scriptedRng([15, 1, 1, 1]),
    });
    expect(hit.riders).toEqual(["Colossus Slayer"]);
  });
});

describe("spell damage", () => {
  it("Potent Spellcasting (Cleric 7): Wisdom modifier added to Cleric cantrips", () => {
    let cleric = level("cleric", 7, "Oswin");
    cleric = apply(cleric, svc.setChoice, "class:cleric:7#blessed_strikes", [
      "potent-spellcasting",
    ]);
    const oswin = view(cleric);
    const wis = oswin.modifiers.wis;
    const r = castSpell(oswin, spell("sacred-flame"), [oswin], { rng: scriptedRng([1, 3, 3]) });
    // Sacred Flame at level 7: 2d8 (3 + 3) + Wisdom.
    expect(r.targets[0]?.instances).toEqual([{ amount: 6 + wis, type: "radiant" }]);
  });

  it("Potent Cantrip (Evoker 3): a missed cantrip still deals half damage", () => {
    const ilse = view(level("wizard", 3, "Ilse"));
    const target = { ...ilse, armor_class: 30 };
    const r = castSpell(ilse, spell("fire-bolt"), [target], { rng: scriptedRng([2, 9]) });
    expect(r.targets[0]?.attack?.hit).toBe(false);
    expect(r.targets[0]?.instances).toEqual([{ amount: 4, type: "fire" }]);
  });

  it("Empowered Evocation (Evoker 10): Intelligence on one damage roll of an evocation spell", () => {
    const ilse = view(level("wizard", 10, "Ilse"));
    const int = ilse.modifiers.int;
    const r = castSpell(ilse, spell("fireball"), [ilse], {
      rng: scriptedRng([1, ...Array<number>(8).fill(1)]),
    });
    expect(r.damage?.total).toBe(8 + int);
  });
});
