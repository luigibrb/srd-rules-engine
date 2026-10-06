import { describe, expect, it } from "vitest";
import {
  type AttackResult,
  applyEncounterAction,
  type CharacterBuild,
  type CharacterState,
  type CombatantSpellcasting,
  computePlaySheet,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  scriptedRng,
} from "../src/index";
import { autocomplete, catalog, classBuild, levelUpIn } from "./helpers";

// SRD 5.2.1 Cunning Strike, Brutal Strike, Relentless Rage, Agonizing Blast, Sacred Weapon.

const level = (classId: string, n: number, name: string) =>
  levelUpIn(autocomplete(classBuild(classId, { name })), classId, n - 1);

function session(builds: Record<string, CharacterBuild>, monsters: string[] = ["ogre"]) {
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
  act(
    [],
    ...keys.map((character) => ({ type: "add_character", character, side: "party" }) as const),
    ...monsters.map((monster) => ({ type: "add_monster", monster, side: "enemies" }) as const),
    ...[...keys, ...monsters].map(
      (id, i) => ({ type: "set_initiative", id, value: 20 - i }) as const,
    ),
    { type: "start" },
  );
  const get = (id: string) => encounter.combatants.find((c) => c.id === id);
  return { act, notes, get, states, encounter: () => encounter, result: () => result };
}
const toggle = (id: string, key: string): EncounterAction => ({
  type: "effects",
  id,
  actions: [{ type: "activate", key }],
});

describe("Cunning Strike", () => {
  const stab = (extra: Partial<EncounterAction>): EncounterAction =>
    ({
      type: "attack",
      id: "rook",
      target: "ogre",
      attack: "Dagger",
      ally_adjacent: true,
      riders: [{ rider: "sneak-attack" }],
      ...extra,
    }) as EncounterAction;

  it("forgoes a Sneak Attack die for Trip; refused without Sneak Attack, a kit, or past the limit", () => {
    const rook = level("rogue", 5, "Rook");
    const s = session({ rook });
    expect(() => s.act([], stab({ riders: [], cunning: ["trip"] }))).toThrow(
      "Cunning Strike is used when you deal Sneak Attack damage: add the sneak-attack rider",
    );
    expect(() => s.act([], stab({ cunning: ["poison"] }))).toThrow(
      "Cunning Strike's Poison needs a Poisoner's Kit on Rook's person",
    );
    expect(() => s.act([], stab({ cunning: ["trip", "withdraw"] }))).toThrow(
      "Rook can use 1 Cunning Strike effect",
    );
    // Hit (18), dagger 1d4, Sneak Attack 3d6 − 1d6 = 2d6, then the ogre's Dexterity save (2).
    s.act([18, 4, 6, 6, 2], stab({ cunning: ["trip"] }));
    const hit = s.result() as AttackResult;
    expect(hit.damage?.parts.find((p) => p.dice === "2d6")).toBeDefined();
    expect(s.get("ogre")?.conditions).toEqual(["prone"]);
    expect(s.notes.some((n) => n.startsWith("Cunning Strike (Trip): Ogre fails"))).toBe(true);
  });

  it("Withdraw: half its Speed without Opportunity Attacks", () => {
    const rook = level("rogue", 5, "Rook");
    const s = session({ rook });
    s.act([18, 4, 6, 6], stab({ cunning: ["withdraw"] }));
    expect(s.get("rook")).toMatchObject({ extra_movement: 15, disengaged: true });
  });
});

describe("Brutal Strike", () => {
  it("needs Reckless Attack; forgoes Advantage for 1d10 and Hamstring Blow (−15 feet)", () => {
    const grom = level("barbarian", 9, "Grom");
    const s = session({ grom });
    const swing = (brutal: string[]): EncounterAction =>
      ({
        type: "attack",
        id: "grom",
        target: "ogre",
        attack: "Greataxe",
        brutal,
      }) as EncounterAction;
    expect(() => s.act([], swing(["hamstring"]))).toThrow(
      "Brutal Strike needs Reckless Attack this turn",
    );
    s.act([], toggle("grom", "barbarian:reckless-attack"));
    expect(() => s.act([], swing(["staggering"]))).toThrow(
      "Staggering Blow and Sundering Blow come with Improved Brutal Strike (level 13)",
    );
    s.act([18, 6, 5], swing(["hamstring"]));
    const hit = s.result() as AttackResult;
    expect(hit.roll.mode).toBe("normal");
    expect(hit.damage?.parts.map((p) => p.dice)).toEqual(["1d12", "1d10"]);
    expect(s.encounter().marks).toEqual([
      expect.objectContaining({ kind: "hamstrung", on: "ogre", by: "grom" }),
    ]);
    s.act([], { type: "next_turn" });
    expect(() => s.act([], { type: "move", id: "ogre", feet: 30 })).toThrow(
      "Ogre can move 25 more feet this turn",
    );
  });
});

describe("Relentless Rage", () => {
  it("dropping to 0 while raging: a DC 10 Constitution save keeps it at twice its level", () => {
    const grom = level("barbarian", 11, "Grom");
    const s = session({ grom });
    s.act([], toggle("grom", "barbarian:rage"));
    const hp = computePlaySheet(grom, s.states.grom as CharacterState, catalog).play.hp.current;
    s.act([15], { type: "effects", id: "grom", actions: [{ type: "damage", amount: hp }] });
    expect(s.notes.some((n) => n.startsWith("Relentless Rage: Grom succeeds"))).toBe(true);
    expect(computePlaySheet(grom, s.states.grom as CharacterState, catalog).play.hp.current).toBe(
      22,
    );
    // The next time, DC 15.
    s.act([1], { type: "effects", id: "grom", actions: [{ type: "damage", amount: 22 }] });
    expect(s.notes.some((n) => /^Relentless Rage: Grom fails \(\d+ vs DC 15\)/.test(n))).toBe(true);
  });
});

describe("Agonizing Blast and Sacred Weapon", () => {
  it("Agonizing Blast adds Charisma to the chosen cantrip only", () => {
    const wren = level("warlock", 2, "Wren");
    const sheet = computePlaySheet(wren, createState(wren, catalog), catalog);
    expect(sheet.spell_damage).toContainEqual(
      expect.objectContaining({ name: "Agonizing Blast", spell: "chill-touch", cantrip: true }),
    );
    expect((sheet.spellcasting[0] as unknown as CombatantSpellcasting | undefined)?.ability).toBe(
      "cha",
    );
  });

  it("Sacred Weapon adds Charisma (minimum +1) to weapon attack rolls while on", () => {
    const vera = level("paladin", 3, "Vera");
    const before = computePlaySheet(vera, createState(vera, catalog), catalog);
    const s = session({ vera });
    s.act([], toggle("vera", "paladin:sacred-weapon"));
    const after = computePlaySheet(vera, s.states.vera as CharacterState, catalog);
    const sword = (sheet: typeof before) => sheet.attacks.find((a) => a.weapon)?.attack_bonus ?? 0;
    expect(sword(after) - sword(before)).toBe(Math.max(1, before.modifiers.cha));
    expect(s.states.vera?.uses_spent).toMatchObject({ "paladin:channel-divinity": 1 });
  });
});
