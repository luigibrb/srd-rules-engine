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
  encounterCombatant,
  type PlayAction,
  scriptedRng,
} from "../src/index";
import * as svc from "../src/services/builder";
import { apply, catalog, fighterBuild } from "./helpers";

// SRD 5.2.1 "Rules Glossary": Dodge, Help, Disengage, Unarmed Strike (Grapple, Shove), Grappling,
// Prone, Opportunity Attacks; "Equipment": the Light property.

/** Brakka (Str 17, Dex 14, PB 2) with a Shortsword and a Dagger, against goblins. */
function session(build: CharacterBuild = fighterBuild(), ...setup: PlayAction[]) {
  let state: CharacterState = createState(build, catalog);
  for (const a of [
    { type: "add_item", item: "shortsword" } as const,
    { type: "add_item", item: "dagger" } as const,
    ...setup,
  ]) {
    state = applyAction(build, state, catalog, a).state;
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
  const get = (id: string) => encounter.combatants.find((c) => c.id === id);
  const view = (id: string) =>
    encounterCombatant(encounter, id, { catalog, characters: { brakka: { build, state } } });
  return {
    act,
    notes,
    get,
    view,
    encounter: () => encounter,
    state: () => state,
    result: () => result,
  };
}

/** Brakka (party, Initiative 20), then the monsters (enemies, 10, 9, …): Brakka's turn. */
function fight(build?: CharacterBuild, ...monsters: string[]) {
  const s = session(build);
  const ids = ["brakka", ...monsters.map((m, i) => (monsters.indexOf(m) < i ? `${m}-2` : m))];
  s.act(
    [],
    { type: "add_character", character: "brakka", side: "party" },
    ...monsters.map((monster) => ({ type: "add_monster", monster, side: "enemies" }) as const),
    ...ids.map((id, i) => ({ type: "set_initiative", id, value: i ? 11 - i : 20 }) as const),
    { type: "start" },
  );
  return s;
}
const next = { type: "next_turn" } as const;
const goblin = "goblin-warrior";

describe("Dodge", () => {
  it("attack rolls against it have Disadvantage until the start of its next turn", () => {
    const s = fight(undefined, goblin);
    s.act([], next, { type: "dodge", id: goblin }, next); // Brakka's turn again
    expect(s.notes).toContain(
      "Goblin Warrior Dodges: until the start of its next turn, attack rolls against it have Disadvantage and it has Advantage on Dexterity saving throws.",
    );
    expect(s.view(goblin).advantages).toContain("save.dex");
    s.act([18, 3, 1], { type: "attack", id: "brakka", target: goblin, attack: "Shortsword" });
    const attack = s.result() as AttackResult;
    expect(attack.roll).toMatchObject({ rolls: [18, 3], mode: "disadvantage" });
    expect(attack.reasons).toEqual(["Disadvantage: Goblin Warrior is Dodging (within 5 ft)"]);
    s.act([], next); // the goblin's turn: Dodge ends
    expect(s.get(goblin)?.dodging).toBe(false);
    expect(s.view(goblin).advantages).not.toContain("save.dex");
  });

  it("is lost while Incapacitated; it takes the action (or a Bonus Action)", () => {
    const s = fight(undefined, goblin);
    s.act([], next, { type: "dodge", id: goblin });
    s.act([], {
      type: "effects",
      id: goblin,
      actions: [{ type: "add_condition", condition: "stunned" }],
    });
    expect(s.view(goblin).advantages).not.toContain("save.dex");
    const t = fight(undefined, goblin);
    t.act([], { type: "dodge", id: "brakka" });
    expect(() => t.act([], { type: "dodge", id: "brakka" })).toThrow(
      "Brakka has already used its action this turn",
    );
    t.act([], { type: "disengage", id: "brakka", bonus_action: true });
    expect(t.get("brakka")?.used).toMatchObject({ action: true, bonus_action: true });
  });
});

describe("Disengage and Opportunity Attacks", () => {
  it("a Disengaged creature's movement doesn't provoke them, for the rest of its turn", () => {
    const s = fight(undefined, goblin);
    s.act([], next, { type: "disengage", id: goblin, bonus_action: true });
    const opportunity = {
      type: "attack",
      id: "brakka",
      target: goblin,
      attack: "Shortsword",
      opportunity: true,
    } as const;
    expect(() => s.act([], opportunity)).toThrow(
      "Goblin Warrior Disengaged: its movement doesn't provoke Opportunity Attacks",
    );
    s.act([], next); // Brakka's turn: the goblin's Disengage is over
    s.act([], next); // the goblin's turn again, without Disengage
    s.act([2], opportunity);
    expect(s.get("brakka")?.used.reaction).toBe(true);
    expect(() =>
      s.act([], { ...opportunity, attack: "Dagger", id: "brakka", target: goblin }),
    ).toThrow("Brakka has already used its reaction");
  });

  it("is a melee attack", () => {
    const s = fight(undefined, goblin);
    s.act([], next);
    expect(() =>
      s.act([], {
        type: "attack",
        id: goblin,
        target: "brakka",
        attack: "Shortbow",
        opportunity: true,
      }),
    ).toThrow("An Opportunity Attack is a melee attack");
  });
});

describe("Help", () => {
  it("gives Advantage to an ally's next attack roll against the enemy, once", () => {
    const s = fight(undefined, goblin, goblin);
    s.act([], next, { type: "help", id: goblin, target: "brakka" });
    s.act([], next); // the second goblin's turn
    s.act([10, 12, 1], {
      type: "attack",
      id: "goblin-warrior-2",
      target: "brakka",
      attack: "Scimitar",
    });
    const attack = s.result() as AttackResult;
    expect(attack.roll.mode).toBe("advantage");
    expect(attack.reasons).toEqual(["Advantage: Goblin Warrior Helps against Brakka"]);
    expect(s.encounter().helps).toEqual([]);
  });

  it("the helper doesn't benefit, and it expires at the start of the helper's next turn", () => {
    const s = fight(undefined, goblin, goblin);
    s.act([], next, { type: "help", id: goblin, target: "brakka" });
    expect(s.encounter().helps).toEqual([{ by: goblin, on: "brakka", skill: null }]);
    s.act([], next, next, next); // the goblin's next turn
    expect(s.encounter().helps).toEqual([]);
    expect(() => s.act([], { type: "help", id: goblin, target: "goblin-warrior-2" })).toThrow(
      "Goblin Warrior 2 is on Goblin Warrior's side",
    );
  });

  it("with a skill it's proficient in: Advantage on the ally's next check with it", () => {
    const s = fight(undefined, goblin, goblin);
    s.act([], next);
    expect(() =>
      s.act([], { type: "help", id: goblin, target: "goblin-warrior-2", skill: "arcana" }),
    ).toThrow("Goblin Warrior isn't proficient in arcana");
    expect(() =>
      s.act([], { type: "help", id: goblin, target: "brakka", skill: "stealth" }),
    ).toThrow("Brakka isn't Goblin Warrior's ally");
    s.act([], { type: "help", id: goblin, target: "goblin-warrior-2", skill: "stealth" });
    s.act([4, 15], { type: "check", id: "goblin-warrior-2", skill: "stealth" });
    expect(s.notes.at(-1)).toBe(
      "Goblin Warrior 2's Stealth check: 21; Advantage: Goblin Warrior Helps.",
    );
    expect(s.encounter().helps).toEqual([]);
  });
});

describe("Grapple and Shove", () => {
  const grapple = { type: "unarmed", id: "brakka", target: goblin, option: "grapple" } as const;

  it("a failed save (the better of Str and Dex) against 8 + Str + PB: Grappled by Brakka", () => {
    const s = fight(undefined, goblin);
    s.act([5], grapple); // Dex save: 5 + 2 = 7 vs DC 13
    expect(s.notes).toEqual(
      expect.arrayContaining([
        "Brakka tries to grapple Goblin Warrior: Goblin Warrior fails a Dexterity saving throw (7 vs DC 13).",
        "Goblin Warrior is Grappled by Brakka (escape DC 13).",
      ]),
    );
    expect(s.get(goblin)?.conditions).toEqual(["grappled"]);
    expect(s.encounter().effects).toMatchObject([
      { target: goblin, condition: "grappled", source: "brakka", escape_dc: 13 },
    ]);
    // It takes one attack of the Attack action.
    expect(s.get("brakka")?.used.action).toBe(true);
    // The grappled goblin attacks its grappler without Disadvantage.
    s.act([], next);
    s.act([10], { type: "attack", id: goblin, target: "brakka", attack: "Scimitar" });
    expect((s.result() as AttackResult).roll.mode).toBe("normal");
  });

  it("the grappled creature escapes with an Athletics or Acrobatics check", () => {
    const s = fight(undefined, goblin);
    s.act([5], grapple, next);
    s.act([12], { type: "escape", id: goblin }); // Acrobatics (Dex +2): 14 vs 13
    expect(s.notes.slice(-2)).toEqual([
      "Goblin Warrior tries to escape (Acrobatics 14 vs DC 13): escapes.",
      "Grappled on Goblin Warrior ends (Grapple: escaped).",
    ]);
    expect(s.get(goblin)?.conditions).toEqual([]);
    expect(s.get(goblin)?.used.action).toBe(true);
  });

  it("ends when the grappler is Incapacitated", () => {
    const s = fight(undefined, goblin);
    s.act([5], grapple);
    s.act([], {
      type: "effects",
      id: "brakka",
      actions: [{ type: "add_condition", condition: "incapacitated" }],
    });
    expect(s.notes.at(-1)).toBe(
      "Grappled on Goblin Warrior ends (Grapple: Brakka is Incapacitated).",
    );
    expect(s.get(goblin)?.conditions).toEqual([]);
  });

  it("the target can't be more than one size larger; a success leaves it free", () => {
    const s = fight(undefined, "hill-giant", goblin);
    expect(() => s.act([], { ...grapple, target: "hill-giant" })).toThrow(
      "Hill Giant is too large for Brakka to grapple",
    );
    s.act([15], grapple);
    expect(s.get(goblin)?.conditions).toEqual([]);
  });

  it("a shove knocks Prone or pushes; standing up costs half the Speed", () => {
    const s = fight(undefined, goblin);
    const shove = { type: "unarmed", id: "brakka", target: goblin, option: "shove" } as const;
    expect(() => s.act([], shove)).toThrow("A shove pushes or knocks Prone");
    s.act([3], { ...shove, shove: "prone" });
    expect(s.get(goblin)?.conditions).toEqual(["prone"]);
    s.act([], next, { type: "stand", id: goblin });
    expect(s.notes.at(-1)).toBe("Goblin Warrior stands up (15 feet of movement).");
    expect(s.get(goblin)).toMatchObject({ conditions: [], moved: 15 });
    const t = fight(undefined, goblin);
    t.act([3], { ...shove, shove: "push" });
    expect(t.notes.at(-1)).toBe("Goblin Warrior is pushed 5 feet away from Brakka.");
  });
});

describe("two-weapon fighting (the Light property)", () => {
  const shortsword = {
    type: "attack",
    id: "brakka",
    target: goblin,
    attack: "Shortsword",
  } as const;
  const extra = {
    type: "attack",
    id: "brakka",
    target: goblin,
    attack: "Dagger",
    light_extra: true,
  } as const;

  it("an extra attack as a Bonus Action with another Light weapon, no ability modifier", () => {
    const s = fight(undefined, goblin);
    expect(() => s.act([], extra)).toThrow(
      "Brakka hasn't attacked with a Light weapon in the Attack action this turn",
    );
    s.act([1], shortsword);
    expect(() => s.act([], { ...extra, attack: "Shortsword" })).toThrow(
      "The extra attack must be made with a different Light weapon than Shortsword",
    );
    s.act([15, 3], extra); // 15 + 5 hits AC 15: 1d4 = 3, no Strength modifier
    expect((s.result() as AttackResult).instances).toEqual([{ amount: 3, type: "piercing" }]);
    expect(s.get("brakka")?.used.bonus_action).toBe(true);
    expect(() => s.act([], extra)).toThrow("Brakka has already used its bonus action this turn");
  });

  it("Two-Weapon Fighting adds the modifier", () => {
    const twf = apply(fighterBuild(), svc.setChoice, "class:fighter#fighting_style", [
      "two-weapon-fighting",
    ]);
    const s = fight(twf, goblin);
    s.act([1], shortsword);
    s.act([15, 3], extra);
    expect((s.result() as AttackResult).instances).toEqual([{ amount: 6, type: "piercing" }]);
  });
});
