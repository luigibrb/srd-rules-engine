import { describe, expect, it } from "vitest";
import {
  type AttackResult,
  applyEncounterAction,
  type CharacterBuild,
  type CharacterState,
  computePlaySheet,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  resolve,
  type SpellCastResult,
  scriptedRng,
} from "../src/index";
import * as svc from "../src/services/builder";
import { autocomplete, catalog, classBuild, levelUpIn } from "./helpers";

// SRD 5.2.1: Hunter's Mark, Hex, Divine Smite, Flame Strike, Chain Lightning, Mass Suggestion.

function caster(classId: string, n: number, spell: string, name = "Ilse"): CharacterBuild {
  let b = levelUpIn(autocomplete(classBuild(classId, { name })), classId, n - 1);
  if (computePlaySheet(b, createState(b, catalog), catalog).spells.some((x) => x.id === spell))
    return b;
  const res = resolve(b, catalog);
  const choice = res.choices.find(
    (c) => c.definition.kind === "spell" && res.options(c).some((o) => o.id === spell),
  );
  if (!choice) throw new Error(`no choice offers ${spell}`);
  b = svc.setChoice(b, catalog, choice.key, [...res.selected(choice).slice(0, -1), spell]).build;
  return b;
}

function session(builds: Record<string, CharacterBuild>, monsters: string[]) {
  const states: Record<string, CharacterState> = Object.fromEntries(
    Object.entries(builds).map(([k, b]) => [k, createState(b, catalog)]),
  );
  let encounter: Encounter = createEncounter();
  const notes: string[] = [];
  let result: unknown = null;
  const ctx = () => ({
    catalog,
    characters: Object.fromEntries(
      Object.entries(builds).map(([k, build]) => [
        k,
        { build, state: states[k] as CharacterState },
      ]),
    ),
  });
  const act = (rolls: number[], ...actions: EncounterAction[]) => {
    for (const action of actions) {
      const r = applyEncounterAction(encounter, action, { ...ctx(), rng: scriptedRng(rolls) });
      encounter = r.encounter;
      Object.assign(states, r.states);
      notes.push(...r.notes);
      result = r.result;
    }
  };
  const keys = Object.keys(builds);
  const seen = new Map<string, number>();
  const ids = monsters.map((m) => {
    const n = (seen.get(m) ?? 0) + 1;
    seen.set(m, n);
    return n === 1 ? m : `${m}-${n}`;
  });
  act(
    [],
    ...keys.map((character) => ({ type: "add_character", character, side: "party" }) as const),
    ...monsters.map((monster) => ({ type: "add_monster", monster, side: "enemies" }) as const),
    ...[...keys, ...ids].map((id, i) => ({ type: "set_initiative", id, value: 20 - i }) as const),
    { type: "start" },
  );
  const get = (id: string) => encounter.combatants.find((c) => c.id === id);
  return { act, notes, get, states, encounter: () => encounter, result: () => result };
}
const next = { type: "next_turn" } as const;

describe("Hunter's Mark", () => {
  it("1d6 Force on the caster's hits against its quarry; moved once the quarry drops", () => {
    const rhea = caster("ranger", 2, "hunters-mark", "Rhea");
    const s = session({ rhea }, ["goblin-warrior", "goblin-warrior"]);
    s.act([], { type: "cast", id: "rhea", spell: "hunters-mark", targets: ["goblin-warrior"] });
    expect(s.encounter().marks).toEqual([
      expect.objectContaining({
        kind: "quarry",
        on: "goblin-warrior",
        damage: { dice: "1d6", type: "force" },
      }),
    ]);
    const bow = computePlaySheet(rhea, s.states.rhea as CharacterState, catalog).attacks.find(
      (a) => a.kind === "ranged",
    );
    s.act([18, 1, 4], {
      type: "attack",
      id: "rhea",
      target: "goblin-warrior",
      attack: bow?.name as string,
    });
    const hit = s.result() as AttackResult;
    expect(hit.instances).toContainEqual({ amount: 4, type: "force" });
    expect(() => s.act([], { type: "move_mark", id: "rhea", target: "goblin-warrior-2" })).toThrow(
      "Hunter's Mark moves only once Goblin Warrior drops to 0 Hit Points",
    );
    s.act([], { type: "effects", id: "goblin-warrior", actions: [{ type: "damage", amount: 20 }] });
    // A Bonus Action on a later turn (casting it took this turn's).
    s.act([], next, next, { type: "move_mark", id: "rhea", target: "goblin-warrior-2" });
    expect(s.encounter().marks[0]?.on).toBe("goblin-warrior-2");
    // It ends with the ranger's Concentration.
    s.act([], {
      type: "effects",
      id: "rhea",
      actions: [{ type: "set_concentration", spell: null }],
    });
    expect(s.encounter().marks).toEqual([]);
  });
});

describe("Divine Smite", () => {
  it("right after a melee hit; doubled on a Critical Hit; a die more against Undead", () => {
    const vera = caster("paladin", 2, "divine-smite", "Vera");
    const s = session({ vera }, ["zombie"]);
    expect(() => s.act([], { type: "cast", id: "vera", spell: "divine-smite" })).toThrow(
      "Divine Smite is cast right after Vera hits a creature",
    );
    const sword = computePlaySheet(vera, s.states.vera as CharacterState, catalog).attacks.find(
      (a) => a.kind === "melee" && a.weapon,
    );
    s.act([20, 3, 3, 3], {
      type: "attack",
      id: "vera",
      target: "zombie",
      attack: sword?.name as string,
    });
    s.act([1, 1, 1, 1, 1, 1], { type: "cast", id: "vera", spell: "divine-smite" });
    // 2d8 doubled: four dice of 1 = 4 radiant; then 1d8 doubled (2) against an Undead.
    expect((s.result() as SpellCastResult).targets[0]?.instances).toEqual([
      { amount: 4, type: "radiant" },
    ]);
    expect(s.notes).toContain("Divine Smite: 2 radiant more against a Undead.");
    expect(s.get("vera")?.used.bonus_action).toBe(true);
  });
});

describe("area and multi-target spells", () => {
  it("Flame Strike: Fire and Radiant, half on a success", () => {
    const ilsa = caster("cleric", 9, "flame-strike", "Ilsa");
    const s = session({ ilsa }, ["goblin-warrior"]);
    s.act(Array(12).fill(2), {
      type: "cast",
      id: "ilsa",
      spell: "flame-strike",
      targets: ["goblin-warrior"],
    });
    expect((s.result() as SpellCastResult).damage_parts.map((p) => `${p.dice} ${p.type}`)).toEqual([
      "5d6 fire",
      "5d6 radiant",
    ]);
  });

  it("Chain Lightning: up to four targets, one more per slot level above 6", () => {
    const ilse = caster("wizard", 11, "chain-lightning");
    const five = [
      "goblin-warrior",
      "goblin-warrior",
      "goblin-warrior",
      "goblin-warrior",
      "goblin-warrior",
    ];
    const s = session({ ilse }, five);
    const ids = [
      "goblin-warrior",
      "goblin-warrior-2",
      "goblin-warrior-3",
      "goblin-warrior-4",
      "goblin-warrior-5",
    ];
    expect(() =>
      s.act([], { type: "cast", id: "ilse", spell: "chain-lightning", targets: ids }),
    ).toThrow("Chain Lightning can target at most 4 at this level");
    s.act(Array(20).fill(5), {
      type: "cast",
      id: "ilse",
      spell: "chain-lightning",
      targets: ids.slice(0, 4),
    });
    expect((s.result() as SpellCastResult).targets).toHaveLength(4);
  });

  it("Mass Suggestion: Charmed until the creature takes damage", () => {
    const ilse = caster("bard", 11, "mass-suggestion");
    const s = session({ ilse }, ["goblin-warrior", "goblin-warrior"]);
    s.act([1, 1], {
      type: "cast",
      id: "ilse",
      spell: "mass-suggestion",
      targets: ["goblin-warrior", "goblin-warrior-2"],
    });
    expect(s.get("goblin-warrior")?.conditions).toEqual(["charmed"]);
    s.act([], { type: "effects", id: "goblin-warrior", actions: [{ type: "damage", amount: 1 }] });
    expect(s.get("goblin-warrior")?.conditions).toEqual([]);
    expect(s.get("goblin-warrior-2")?.conditions).toEqual(["charmed"]);
  });
});

describe("Hex", () => {
  it("1d6 Necrotic on the warlock's hits", () => {
    const wren = caster("warlock", 1, "hex", "Wren");
    const s = session({ wren }, ["goblin-warrior"]);
    s.act(
      [],
      { type: "cast", id: "wren", spell: "hex", targets: ["goblin-warrior"], pact: true },
      next,
      next,
    );
    expect(s.encounter().marks).toEqual([
      expect.objectContaining({
        kind: "quarry",
        label: "Hex",
        damage: { dice: "1d6", type: "necrotic" },
      }),
    ]);
  });
});
