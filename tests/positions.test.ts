import { describe, expect, it } from "vitest";
import {
  type AttackResult,
  applyEncounterAction,
  type CharacterBuild,
  type CharacterState,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  gridDistance,
  scriptedRng,
} from "../src/index";
import { autocomplete, catalog, classBuild, fighterBuild } from "./helpers";

// SRD 5.2.1 "Playing on a Grid" (5-foot squares, diagonals count as one), "Creature Size and
// Space", "Reach", "Range", "Ranged Attacks in Close Combat", "Cover", "Opportunity Attacks".

describe("gridDistance", () => {
  it("counts squares to the nearest square of the other space", () => {
    expect(gridDistance({ x: 0, y: 0 }, 1, { x: 1, y: 0 }, 1)).toBe(5);
    expect(gridDistance({ x: 0, y: 0 }, 1, { x: 1, y: 1 }, 1)).toBe(5);
    expect(gridDistance({ x: 0, y: 0 }, 1, { x: 3, y: 4 }, 1)).toBe(20);
    // A Large creature (2×2 at 0,0) and a Medium one at (3,0): one empty square between.
    expect(gridDistance({ x: 0, y: 0 }, 2, { x: 3, y: 0 }, 1)).toBe(10);
    expect(gridDistance({ x: 0, y: 0 }, 2, { x: 1, y: 1 }, 1)).toBe(0);
  });
});

/** Characters and monsters placed on the grid; characters act first, in the order given. */
function session(
  builds: Record<string, CharacterBuild>,
  monsters: { monster: string; at: [number, number] }[],
  at: Record<string, [number, number]>,
) {
  const states: Record<string, CharacterState> = Object.fromEntries(
    Object.entries(builds).map(([k, b]) => [k, createState(b, catalog)]),
  );
  let encounter: Encounter = createEncounter();
  const notes: string[] = [];
  let result: unknown = null;
  const act = (rolls: number[], ...actions: EncounterAction[]) => {
    const rng = scriptedRng(rolls);
    for (const action of actions) {
      const characters = Object.fromEntries(
        Object.entries(builds).map(([k, build]) => [
          k,
          { build, state: states[k] as CharacterState },
        ]),
      );
      const r = applyEncounterAction(encounter, action, { catalog, characters, rng });
      encounter = r.encounter;
      Object.assign(states, r.states);
      notes.push(...r.notes);
      result = r.result;
    }
  };
  const keys = Object.keys(builds);
  // Monster ids as `add_monster` numbers them: goblin-warrior, goblin-warrior-2…
  const seen = new Map<string, number>();
  const ids = [
    ...keys,
    ...monsters.map(({ monster }) => {
      const n = (seen.get(monster) ?? 0) + 1;
      seen.set(monster, n);
      return n === 1 ? monster : `${monster}-${n}`;
    }),
  ];
  act(
    [],
    ...keys.map((character) => ({ type: "add_character", character, side: "party" }) as const),
    ...monsters.map((m) => ({ type: "add_monster", monster: m.monster, side: "enemies" }) as const),
    ...keys.map((id) => ({ type: "place", id, x: at[id]?.[0] ?? 0, y: at[id]?.[1] ?? 0 }) as const),
    ...monsters.map(
      (m, i) =>
        ({ type: "place", id: ids[keys.length + i] as string, x: m.at[0], y: m.at[1] }) as const,
    ),
    ...ids.map((id, i) => ({ type: "set_initiative", id, value: 20 - i }) as const),
    { type: "start" },
  );
  const get = (id: string) => encounter.combatants.find((c) => c.id === id);
  return { act, notes, get, attack: () => result as AttackResult };
}
const swing = (target: string, attack = "Greatsword", extra: Partial<EncounterAction> = {}) =>
  ({ type: "attack", id: "brakka", target, attack, ...extra }) as EncounterAction;

describe("attacks on the grid", () => {
  it("a melee attack needs the target within reach; within 5 feet is measured", () => {
    const s = session({ brakka: fighterBuild() }, [{ monster: "goblin-warrior", at: [2, 0] }], {});
    expect(() => s.act([], swing("goblin-warrior"))).toThrow(
      "Goblin Warrior is 10 feet away: out of Greatsword's reach (5 ft)",
    );
    s.act([], { type: "place", id: "goblin-warrior", x: 1, y: 1 });
    s.act([], {
      type: "effects",
      id: "goblin-warrior",
      actions: [{ type: "add_condition", condition: "prone" }],
    });
    s.act([3, 15, 1, 1], swing("goblin-warrior"));
    expect(s.attack().reasons).toEqual(["Advantage: Goblin Warrior is Prone (within 5 ft)"]);
  });

  it("a ranged attack: Disadvantage beyond normal range and next to an enemy, none past long range", () => {
    const far = session(
      { brakka: fighterBuild() },
      [{ monster: "goblin-warrior", at: [20, 0] }],
      {},
    );
    far.act([], { type: "next_turn" }); // the goblin's turn: Shortbow 80/320 ft
    const shoot: EncounterAction = {
      type: "attack",
      id: "goblin-warrior",
      target: "brakka",
      attack: "Shortbow",
    };
    far.act([3, 15], shoot);
    expect(far.attack().reasons).toEqual(["Disadvantage: Brakka is beyond normal range (80 ft)"]);
    far.act(
      [],
      { type: "place", id: "goblin-warrior", x: 70, y: 0 },
      { type: "next_turn" },
      { type: "next_turn" },
    );
    expect(() => far.act([], { ...shoot, type: "attack" })).toThrow(
      "beyond Shortbow's range (320 ft)",
    );
    const close = session(
      { brakka: fighterBuild() },
      [{ monster: "goblin-warrior", at: [1, 0] }],
      {},
    );
    close.act([], { type: "next_turn" });
    close.act([3, 15], shoot);
    expect(close.attack().reasons).toEqual(["Disadvantage: Brakka is within 5 ft"]);
  });

  it("a thrown weapon uses its range; cover raises AC; Total Cover can't be targeted", () => {
    const s = session({ brakka: fighterBuild() }, [{ monster: "goblin-warrior", at: [8, 0] }], {});
    // Javelin, Thrown (30/120): 40 feet is beyond normal range.
    s.act([3, 15, 1], swing("goblin-warrior", "Javelin", { thrown: true, cover: "half" }));
    expect(s.attack()).toMatchObject({ target_ac: 17 });
    expect(s.attack().reasons).toEqual([
      "Disadvantage: Goblin Warrior is beyond normal range (30 ft)",
    ]);
    s.act([], { type: "next_turn" }, { type: "next_turn" }); // Brakka's next turn
    expect(() => s.act([], swing("goblin-warrior", "Greatsword", { thrown: true }))).toThrow(
      "Greatsword can't be thrown",
    );
    expect(() =>
      s.act([], swing("goblin-warrior", "Javelin", { thrown: true, cover: "total" })),
    ).toThrow("Goblin Warrior has Total Cover");
  });

  it("Sneak Attack: an ally next to the target is seen on the grid", () => {
    const pip = autocomplete(classBuild("rogue", { name: "Pip" }));
    const s = session(
      { pip, brakka: fighterBuild() },
      [{ monster: "goblin-warrior", at: [5, 0] }],
      { pip: [0, 0], brakka: [6, 0] },
    );
    s.act([], { type: "place", id: "pip", x: 4, y: 0 });
    s.act([15, 1, 1, 1], {
      type: "attack",
      id: "pip",
      target: "goblin-warrior",
      attack: "Dagger",
      riders: [{ rider: "sneak-attack" }],
    });
    expect(s.attack().riders).toEqual(["Sneak Attack"]);
  });
});

describe("movement and spells on the grid", () => {
  it("moving to a square costs its distance; leaving reach is noted; spaces can't be shared", () => {
    const s = session({ brakka: fighterBuild() }, [{ monster: "goblin-warrior", at: [1, 0] }], {});
    expect(() => s.act([], { type: "move", id: "brakka", to: { x: 1, y: 0 } })).toThrow(
      "Goblin Warrior is in that space",
    );
    s.act([], { type: "move", id: "brakka", to: { x: -3, y: 0 } });
    expect(s.get("brakka")).toMatchObject({ moved: 15, position: { x: -3, y: 0 } });
    expect(s.notes).toContain(
      "Brakka leaves Goblin Warrior's reach: Goblin Warrior can make an Opportunity Attack.",
    );
    expect(() => s.act([], { type: "move", id: "brakka", to: { x: -10, y: 0 } })).toThrow(
      "Brakka can move 15 more feet this turn",
    );
  });

  it("a spell's range is checked; cover adds to Dexterity saves", () => {
    const s = session(
      {},
      [
        { monster: "mage", at: [0, 0] },
        { monster: "goblin-warrior", at: [40, 0] },
      ],
      {},
    );
    const fireball: EncounterAction = {
      type: "cast",
      id: "mage",
      spell: "fireball",
      targets: ["goblin-warrior"],
    };
    expect(() => s.act([], fireball)).toThrow(
      "Goblin Warrior is 200 feet away: out of Fireball's range (150 feet)",
    );
    s.act([], { type: "place", id: "goblin-warrior", x: 10, y: 0 });
    s.act([9, ...Array<number>(9).fill(1)], {
      ...fireball,
      type: "cast",
      cover: { "goblin-warrior": "three_quarters" },
    });
    // Dexterity save +2, +5 for Three-Quarters Cover: 9 + 7 = 16 vs DC 14.
    expect(s.notes).toContain("Goblin Warrior: succeeds (16 vs DC 14): 4 fire.");
  });
});
