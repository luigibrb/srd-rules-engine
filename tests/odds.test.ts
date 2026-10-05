import { describe, expect, it } from "vitest";
import {
  applyEncounterAction,
  attackOdds,
  averageDamage,
  type CharacterBuild,
  type CharacterState,
  combatantOptions,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  failOdds,
  type OptionEntry,
  scriptedRng,
} from "../src/index";
import { autocomplete, catalog, classBuild, fighterBuild } from "./helpers";

// Odds for a UI: d20 arithmetic (SRD: natural 20 hits, natural 1 misses on attack rolls; no such
// rule for saves), dice averages, and options that show them.

describe("rules/odds", () => {
  it("attack rolls: hits, Critical Hits, Advantage and Disadvantage", () => {
    expect(attackOdds({ bonus: 5, ac: 15 })).toEqual({ hit: 0.55, critical: 0.05 });
    expect(attackOdds({ bonus: 20, ac: 10 }).hit).toBe(0.95); // a natural 1 misses
    expect(attackOdds({ bonus: -5, ac: 30 }).hit).toBe(0.05); // a natural 20 hits
    expect(attackOdds({ bonus: 5, ac: 15, critical_on: 19 }).critical).toBe(0.1);
    expect(attackOdds({ bonus: 5, ac: 15, mode: "advantage" }).hit).toBeCloseTo(1 - 0.45 ** 2);
    expect(attackOdds({ bonus: 5, ac: 15, mode: "disadvantage" }).hit).toBeCloseTo(0.55 ** 2);
    expect(attackOdds({ bonus: 5, ac: 15, auto_critical: true })).toEqual({
      hit: 0.55,
      critical: 0.55,
    });
  });

  it("saves fail below the DC, with no natural 1 or 20 rule", () => {
    expect(failOdds({ bonus: 2, dc: 13 })).toBe(0.5);
    expect(failOdds({ bonus: 20, dc: 13 })).toBe(0);
    expect(failOdds({ bonus: 2, dc: 13, mode: "advantage" })).toBeCloseTo(0.25);
    expect(failOdds({ bonus: 2, dc: 13, automatic_failure: true })).toBe(1);
  });

  it("average damage, with crits and defenses", () => {
    const sword = [{ dice: "2d6", bonus: 3, type: "slashing" }];
    expect(averageDamage(sword)).toBe(10);
    expect(averageDamage(sword, { critical: true })).toBe(17);
    expect(averageDamage(sword, { defenses: { resistances: ["slashing"] } })).toBe(5);
    expect(averageDamage(sword, { defenses: { immunities: ["slashing"] } })).toBe(0);
  });
});

function session(builds: Record<string, CharacterBuild>, monsters: string[]) {
  const states: Record<string, CharacterState> = Object.fromEntries(
    Object.entries(builds).map(([k, b]) => [k, createState(b, catalog)]),
  );
  let encounter: Encounter = createEncounter();
  const ctx = () => ({
    catalog,
    characters: Object.fromEntries(
      Object.entries(builds).map(([k, build]) => [
        k,
        { build, state: states[k] as CharacterState },
      ]),
    ),
  });
  const act = (...actions: EncounterAction[]) => {
    for (const action of actions) {
      const r = applyEncounterAction(encounter, action, { ...ctx(), rng: scriptedRng([]) });
      encounter = r.encounter;
      Object.assign(states, r.states);
    }
  };
  const keys = Object.keys(builds);
  act(
    ...keys.map((character) => ({ type: "add_character", character }) as const),
    ...monsters.map((monster) => ({ type: "add_monster", monster, side: "enemies" }) as const),
    ...[...keys, ...monsters].map(
      (id, i) => ({ type: "set_initiative", id, value: 20 - i }) as const,
    ),
    { type: "start" },
  );
  return { act, options: (id: string) => combatantOptions(encounter, id, ctx()) };
}
const find = (entries: readonly OptionEntry[], label: string) =>
  entries.find((x) => x.label.startsWith(label)) as OptionEntry;

describe("odds in options", () => {
  it("a weapon attack: hit, crit and average damage; Advantage against a Prone target", () => {
    const s = session({ brakka: fighterBuild() }, ["goblin-warrior"]);
    // Greatsword +5 vs AC 15: hits on 10+; 2d6 + 3 = 10 (17 on a crit).
    expect(find(s.options("brakka").attacks, "Greatsword").odds).toEqual({
      target: "goblin-warrior",
      hit: 0.55,
      critical: 0.05,
      fail_save: null,
      average_damage: 0.5 * 10 + 0.05 * 17,
    });
    s.act({
      type: "effects",
      id: "goblin-warrior",
      actions: [{ type: "add_condition", condition: "prone" }],
    });
    expect(find(s.options("brakka").attacks, "Greatsword").odds?.hit).toBeCloseTo(1 - 0.45 ** 2);
    // A Grapple: the goblin saves with its better of Strength and Dexterity (+2) against DC 13.
    expect(find(s.options("brakka").standard, "Grapple").odds).toMatchObject({ fail_save: 0.5 });
  });

  it("a spell attack", () => {
    const ilse = autocomplete(classBuild("wizard", { name: "Ilse" }));
    const s = session({ ilse }, ["goblin-warrior"]);
    const touch = find(s.options("ilse").spells, "Chill Touch");
    // Spell attack +4 (Int 15, PB 2) vs AC 15: hits on 11+.
    expect(touch.odds).toMatchObject({ target: "goblin-warrior", hit: 0.5, critical: 0.05 });
    // 1d10 necrotic: 5.5 on a hit, 11 on a crit.
    expect(touch.odds?.average_damage).toBeCloseTo(0.45 * 5.5 + 0.05 * 11);
    expect(find(s.options("ilse").standard, "Dash").odds).toBeNull();
  });
});
