import { describe, expect, it } from "vitest";
import {
  type AttackResult,
  applyAction,
  applyEncounterAction,
  type CharacterBuild,
  type CharacterState,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  scriptedRng,
} from "../src/index";
import * as svc from "../src/services/builder";
import { apply, catalog, fighterBuild } from "./helpers";

// SRD 5.2.1 "Equipment" > "Mastery Properties". Brakka: Str 17 (+3), PB 2.

/** Brakka with these weapon masteries (and the weapons), against two goblins (AC 15, 10 HP). */
function fight(masteries: string[] = ["greatsword", "flail", "javelin"]) {
  const build: CharacterBuild = apply(
    fighterBuild(),
    svc.setChoice,
    "class:fighter#weapon_mastery",
    masteries,
  );
  let state: CharacterState = createState(build, catalog);
  for (const item of masteries) {
    state = applyAction(build, state, catalog, { type: "add_item", item }).state;
  }
  let encounter: Encounter = createEncounter();
  const notes: string[] = [];
  let result: unknown = null;
  const act = (rolls: number[], ...actions: EncounterAction[]) => {
    const rng = scriptedRng(rolls);
    for (const action of actions) {
      const characters = { brakka: { build, state } };
      const r = applyEncounterAction(encounter, action, { catalog, characters, rng });
      encounter = r.encounter;
      state = r.states.brakka ?? state;
      notes.push(...r.notes);
      result = r.result;
    }
  };
  act(
    [],
    { type: "add_character", character: "brakka", side: "party" },
    { type: "add_monster", monster: "goblin-warrior", side: "enemies" },
    { type: "add_monster", monster: "goblin-warrior", side: "enemies" },
    { type: "set_initiative", id: "brakka", value: 20 },
    { type: "set_initiative", id: "goblin-warrior", value: 10 },
    { type: "set_initiative", id: "goblin-warrior-2", value: 9 },
    { type: "start" },
  );
  const get = (id: string) => encounter.combatants.find((c) => c.id === id);
  return {
    act,
    notes,
    get,
    encounter: () => encounter,
    attack: () => result as AttackResult,
  };
}
const next = { type: "next_turn" } as const;
const hit = (attack: string, target = "goblin-warrior") =>
  ({ type: "attack", id: "brakka", target, attack }) as const;

describe("Weapon Mastery in encounters", () => {
  it("Graze: a miss deals the ability modifier (not with mastery: false)", () => {
    const s = fight();
    s.act([2], hit("Greatsword")); // 2 + 5 = 7 misses AC 15
    expect(s.notes.at(-1)).toBe("Graze: Goblin Warrior takes 3 slashing damage.");
    expect(s.get("goblin-warrior")?.hp).toBe(7);
    const t = fight();
    t.act([2], { ...hit("Greatsword"), mastery: false });
    expect(t.get("goblin-warrior")?.hp).toBe(10);
  });

  it("Sap: Disadvantage on the target's next attack roll, before Brakka's next turn", () => {
    const s = fight();
    s.act([15, 4], hit("Flail"));
    expect(s.notes.at(-1)).toBe("Sap: Goblin Warrior's next attack roll has Disadvantage.");
    s.act([], next);
    s.act([15, 3], { type: "attack", id: "goblin-warrior", target: "brakka", attack: "Scimitar" });
    expect(s.attack().roll.mode).toBe("disadvantage");
    expect(s.attack().reasons).toEqual(["Disadvantage: Sap (Brakka's hit)"]);
    expect(s.encounter().masteries).toEqual([]);
    const t = fight();
    t.act([15, 4], hit("Flail"), next, next, next); // Brakka's next turn
    expect(t.encounter().masteries).toEqual([]);
  });

  it("Slow: a hit that deals damage takes 10 feet off its Speed", () => {
    const s = fight();
    s.act([15, 1], hit("Javelin"), next);
    expect(() => s.act([], { type: "move", id: "goblin-warrior", feet: 25 })).toThrow(
      "Goblin Warrior can move 20 more feet this turn",
    );
  });

  it("Vex and Nick: Advantage on the next attack, the Light extra attack in the Attack action", () => {
    const s = fight(["shortsword", "scimitar", "maul"]);
    s.act([15, 1], hit("Shortsword"));
    expect(s.notes.at(-1)).toBe(
      "Vex: Brakka's next attack roll against Goblin Warrior has Advantage.",
    );
    s.act([5, 16, 2], { ...hit("Scimitar"), light_extra: true });
    expect(s.notes).toContain("Nick: Brakka's extra attack is part of the Attack action.");
    expect(s.attack()).toMatchObject({ hit: true, roll: { mode: "advantage" } });
    expect(s.attack().reasons).toEqual(["Advantage: Vex (Brakka's last hit on Goblin Warrior)"]);
    expect(s.attack().instances).toEqual([{ amount: 2, type: "slashing" }]);
    expect(s.get("brakka")?.used.bonus_action).toBe(false);
  });

  it("Topple: a Constitution save (DC 8 + modifier + PB) or Prone", () => {
    const s = fight(["shortsword", "scimitar", "maul"]);
    s.act([15, 1, 1, 5], hit("Maul"));
    expect(s.notes.at(-1)).toBe("Topple: Goblin Warrior fails (5 vs DC 13).");
    expect(s.get("goblin-warrior")?.conditions).toEqual(["prone"]);
  });

  it("Cleave: one attack against a second creature, without the ability modifier", () => {
    const s = fight(["greataxe", "warhammer", "dagger"]);
    const cleave = { ...hit("Greataxe", "goblin-warrior-2"), cleave: true } as const;
    expect(() => s.act([], cleave)).toThrow(
      "Brakka hasn't hit a creature with a Cleave weapon this turn",
    );
    s.act([15, 5], hit("Greataxe"));
    expect(s.notes.at(-1)).toBe(
      "Cleave: Brakka can attack a second creature within 5 feet of Goblin Warrior with Greataxe.",
    );
    expect(() => s.act([], { ...cleave, target: "goblin-warrior" })).toThrow(
      "The Cleave attack is against a second creature",
    );
    s.act([15, 6], cleave);
    expect(s.attack().instances).toEqual([{ amount: 6, type: "slashing" }]);
    expect(() => s.act([], cleave)).toThrow("Brakka has already made its Cleave attack this turn");
  });

  it("Push: noted, for a Large or smaller target", () => {
    const s = fight(["greataxe", "warhammer", "dagger"]);
    s.act([15, 1], hit("Warhammer"));
    expect(s.notes.at(-1)).toBe(
      "Push: Brakka can push Goblin Warrior up to 10 feet straight away.",
    );
  });
});
