import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyEncounterAction,
  type CharacterBuild,
  type CharacterState,
  combatantFromCharacter,
  combatantFromMonster,
  computePlaySheet,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  lookup,
  type MonsterDef,
  type PlayAction,
  rollAbilityCheck,
  scriptedRng,
} from "../src/index";
import { autocomplete, catalog, classBuild, fighterBuild } from "./helpers";

const fighter = fighterBuild(); // Brakka: Str 17, Perception proficient (Skillful)
const state = (build: CharacterBuild, ...actions: PlayAction[]) => {
  let s: CharacterState = createState(build, catalog);
  for (const a of actions) s = applyAction(build, s, catalog, a).state;
  return s;
};

describe("the sheet's ability check bonuses", () => {
  it("are the modifiers, less 2 per Exhaustion level", () => {
    const sheet = computePlaySheet(fighter, state(fighter), catalog);
    expect(sheet.ability_checks.str).toBe(3);
    const tired = computePlaySheet(
      fighter,
      state(fighter, { type: "set_exhaustion", level: 1 }),
      catalog,
    );
    expect(tired.ability_checks.str).toBe(1);
  });
});

describe("rollAbilityCheck", () => {
  const brakka = (...actions: PlayAction[]) =>
    combatantFromCharacter(fighter, state(fighter, ...actions), catalog);

  it("a skill check uses the skill's bonus; an ability check the ability's", () => {
    const sheet = computePlaySheet(fighter, state(fighter), catalog);
    const perception = sheet.skills.find((s) => s.skill === "perception")?.modifier as number;
    const r = rollAbilityCheck(brakka(), { skill: "perception" }, 15, { rng: scriptedRng([10]) });
    expect(r).toMatchObject({
      ability: "wis",
      skill: "perception",
      bonus: perception,
      total: 10 + perception,
    });
    expect(r.success).toBe(10 + perception >= 15);
    const str = rollAbilityCheck(brakka(), { ability: "str" }, null, { rng: scriptedRng([10]) });
    expect(str).toMatchObject({ bonus: 3, total: 13, success: null });
  });

  it("Rage gives Advantage on Strength checks; Poisoned gives Disadvantage; together they cancel", () => {
    const ulla = autocomplete(classBuild("barbarian", { name: "Ulla" }));
    const raging = state(ulla, { type: "activate", key: "barbarian:rage" });
    const athletics = rollAbilityCheck(
      combatantFromCharacter(ulla, raging, catalog),
      { skill: "athletics" },
      null,
      { rng: scriptedRng([4, 17]) },
    );
    expect(athletics.roll).toMatchObject({ rolls: [4, 17], mode: "advantage" });
    const sick = rollAbilityCheck(
      brakka({ type: "add_condition", condition: "poisoned" }),
      {
        ability: "dex",
      },
      null,
      { rng: scriptedRng([17, 4]) },
    );
    expect(sick.roll.mode).toBe("disadvantage");
    expect(sick.reasons).toEqual(["Disadvantage: Brakka is Poisoned"]);
    const both = state(
      ulla,
      { type: "activate", key: "barbarian:rage" },
      {
        type: "add_condition",
        condition: "poisoned",
      },
    );
    const cancel = rollAbilityCheck(
      combatantFromCharacter(ulla, both, catalog),
      { ability: "str" },
      null,
      { rng: scriptedRng([9]) },
    );
    expect(cancel.roll.mode).toBe("normal");
  });

  it("a monster uses its listed skills, else the ability modifier", () => {
    const goblin = combatantFromMonster(lookup(catalog.monsters, "goblin-warrior") as MonsterDef);
    const stealth = rollAbilityCheck(goblin, { skill: "stealth" }, null, {
      rng: scriptedRng([10]),
    });
    expect(stealth.bonus).toBe(6);
    const acrobatics = rollAbilityCheck(goblin, { skill: "acrobatics" }, null, {
      rng: scriptedRng([10]),
    });
    expect(acrobatics.bonus).toBe(2);
  });
});

describe("in an encounter", () => {
  const run = (start: Encounter, rolls: number[], ...actions: EncounterAction[]) => {
    const rng = scriptedRng(rolls);
    let encounter = start;
    let brakka = createState(fighter, catalog);
    const notes: string[] = [];
    for (const action of actions) {
      const characters = { brakka: { build: fighter, state: brakka } };
      const r = applyEncounterAction(encounter, action, { catalog, characters, rng });
      encounter = r.encounter;
      brakka = r.states.brakka ?? brakka;
      notes.push(...r.notes);
    }
    return { encounter, brakka, notes };
  };
  const setup: EncounterAction[] = [
    { type: "add_character", character: "brakka" },
    { type: "add_monster", monster: "goblin-warrior" },
    { type: "set_initiative", id: "brakka", value: 20 },
    { type: "set_initiative", id: "goblin-warrior", value: 10 },
    { type: "start" },
  ];

  it("a check is rolled and noted", () => {
    const { notes } = run(createEncounter(), [12], ...setup, {
      type: "check",
      id: "goblin-warrior",
      skill: "stealth",
      dc: 15,
    });
    expect(notes.at(-1)).toBe("Goblin Warrior's Stealth check: 18 vs DC 15: success.");
  });

  it("a dying character rolls its Death Saving Throw at the start of its turn", () => {
    const { brakka, notes } = run(
      createEncounter(),
      [15],
      ...setup,
      { type: "effects", id: "brakka", actions: [{ type: "damage", amount: 12 }] },
      { type: "next_turn" },
      { type: "next_turn" },
    );
    expect(brakka.death_saves).toEqual({ successes: 1, failures: 0 });
    expect(notes.slice(-2)).toEqual([
      "Round 2: Brakka's turn.",
      "Death Saving Throw: 15 (1 successes, 0 failures).",
    ]);
  });
});
