import { describe, expect, it } from "vitest";
import {
  applyEncounterAction,
  combatantOptions,
  createEncounter,
  type Encounter,
  type EncounterAction,
  parseEncounter,
  scriptedRng,
} from "../src/index";
import { findPath, segmentsMeet, stepBlocked, stepCost, type Terrain } from "../src/rules/grid";
import { catalog } from "./helpers";

// SRD 5.2.1 "Playing on a Grid" (entering a square, corners), "Difficult Terrain", "Moving
// around Other Creatures". Walls sit on grid lines between corners (flagged reading).

const terrain = (t: Partial<Terrain> = {}): Terrain => ({
  walls: [],
  blocked: new Set(),
  difficult: new Set(),
  ...t,
});

describe("rules/grid", () => {
  it("segments that cross or touch meet", () => {
    const p = (x: number, y: number) => ({ x, y });
    expect(segmentsMeet(p(0, 0), p(2, 2), p(0, 2), p(2, 0))).toBe(true);
    expect(segmentsMeet(p(0.5, 0.5), p(1.5, 1.5), p(1, 1), p(1, 3))).toBe(true); // a corner
    expect(segmentsMeet(p(0.5, 0.5), p(1.5, 0.5), p(1, 1), p(1, 3))).toBe(false);
  });

  it("walls, blocked squares and their corners stop a step", () => {
    const wall = terrain({ walls: [{ from: { x: 1, y: 0 }, to: { x: 1, y: 3 } }] });
    expect(stepBlocked(wall, { x: 0, y: 1 }, { x: 1, y: 1 })).toBe(
      "a wall stands between 0,1 and 1,1",
    );
    // The wall ends at corner 1,3: a diagonal through that corner is blocked, one below isn't.
    expect(stepBlocked(wall, { x: 0, y: 2 }, { x: 1, y: 3 })).not.toBeNull();
    expect(stepBlocked(wall, { x: 0, y: 3 }, { x: 1, y: 4 })).toBeNull();
    const pillar = terrain({ blocked: new Set(["1,0"]) });
    expect(stepBlocked(pillar, { x: 0, y: 0 }, { x: 1, y: 0 })).toBe("1,0 is blocked");
    expect(stepBlocked(pillar, { x: 0, y: 1 }, { x: 1, y: 0 })).toBe("1,0 is blocked");
    expect(stepBlocked(pillar, { x: 0, y: 0 }, { x: 1, y: 1 })).toMatch(/cuts a blocked corner/);
    // A Large creature moves all four squares.
    expect(stepBlocked(pillar, { x: -1, y: 1 }, { x: 0, y: 0 }, 2)).toBe("1,0 is blocked");
  });

  it("Difficult Terrain doubles a step's cost; a Large creature pays for any square it enters", () => {
    const mud = terrain({ difficult: new Set(["2,1"]) });
    expect(stepCost(mud, { x: 0, y: 0 }, { x: 1, y: 0 })).toBe(5);
    expect(stepCost(mud, { x: 1, y: 1 }, { x: 2, y: 1 })).toBe(10);
    expect(stepCost(mud, { x: 0, y: 0 }, { x: 1, y: 0 }, 2)).toBe(10);
  });

  it("the cheapest path goes around, the same way every time", () => {
    const wall = terrain({ walls: [{ from: { x: 2, y: -2 }, to: { x: 2, y: 3 } }] });
    const a = findPath(wall, { x: 0, y: 0 }, { x: 4, y: 0 });
    // Down to row 3, past the wall's end (its corner can't be cut), and back up: 7 steps.
    expect(a?.cost).toBe(35);
    expect(a?.path.at(-1)).toEqual({ x: 4, y: 0 });
    expect(findPath(wall, { x: 0, y: 0 }, { x: 4, y: 0 })).toEqual(a);
    expect(findPath(wall, { x: 0, y: 0 }, { x: 4, y: 0 }, { maxCost: 30 })).toBeNull();
  });
});

/** Monsters (`at`), Initiative in the order given; `act` applies actions with scripted dice. */
function fight(monsters: { monster: string; at: [number, number]; side?: string }[]) {
  let encounter: Encounter = createEncounter();
  const notes: string[] = [];
  const act = (rolls: number[], ...actions: EncounterAction[]) => {
    for (const action of actions) {
      const r = applyEncounterAction(encounter, action, { catalog, rng: scriptedRng(rolls) });
      encounter = r.encounter;
      notes.push(...r.notes);
    }
  };
  const seen = new Map<string, number>();
  const ids = monsters.map(({ monster }) => {
    const n = (seen.get(monster) ?? 0) + 1;
    seen.set(monster, n);
    return n === 1 ? monster : `${monster}-${n}`;
  });
  act(
    [],
    ...monsters.map(
      (m) => ({ type: "add_monster", monster: m.monster, side: m.side ?? "enemies" }) as const,
    ),
    ...monsters.map(
      (m, i) => ({ type: "place", id: ids[i] as string, x: m.at[0], y: m.at[1] }) as const,
    ),
    ...ids.map((id, i) => ({ type: "set_initiative", id, value: 20 - i }) as const),
    { type: "start" },
  );
  const get = (id: string) => encounter.combatants.find((c) => c.id === id);
  return { act, notes, get, encounter: () => encounter };
}
const move = (id: string, x: number, y: number) => ({ type: "move", id, to: { x, y } }) as const;
const square = (x: number, y: number) => ({ x, y });

describe("moving on the map", () => {
  it("Difficult Terrain costs 10 feet a square", () => {
    const s = fight([{ monster: "goblin-warrior", at: [0, 0] }]);
    s.act([], { type: "set_terrain", squares: [square(1, 0), square(2, 0)], kind: "difficult" });
    s.act([], move("goblin-warrior", 3, 0));
    expect(s.get("goblin-warrior")).toMatchObject({ position: { x: 3, y: 0 }, moved: 25 });
    expect(() => s.act([], move("goblin-warrior", 3, 2))).toThrow(
      "Goblin Warrior can move 5 more feet this turn",
    );
    s.act([], { type: "set_terrain", squares: [square(1, 0)], kind: "clear" });
    expect(s.encounter().map.difficult).toEqual([square(2, 0)]);
  });

  it("around a pillar; walled in, refused with the cost; blocked squares can't be ended in", () => {
    const s = fight([{ monster: "goblin-warrior", at: [0, 1] }]);
    s.act([], {
      type: "set_terrain",
      squares: [square(1, 0), square(1, 1), square(1, 2)],
      kind: "blocked",
    });
    s.act([], move("goblin-warrior", 2, 1));
    // Around the 3-square pillar, whose corners can't be cut: 6 squares.
    expect(s.get("goblin-warrior")).toMatchObject({ position: { x: 2, y: 1 }, moved: 30 });
    expect(() => s.act([], { type: "place", id: "goblin-warrior", x: 1, y: 1 })).toThrow(
      "1,1 is blocked",
    );
    // Walls all around 2,1: no way out.
    const box = [
      [square(2, 1), square(3, 1)],
      [square(3, 1), square(3, 2)],
      [square(3, 2), square(2, 2)],
      [square(2, 2), square(2, 1)],
    ] as const;
    for (const [from, to] of box) s.act([], { type: "add_wall", from, to });
    s.act([], { type: "next_turn" });
    expect(() => s.act([], move("goblin-warrior", 5, 1))).toThrow(
      "Goblin Warrior can't reach 5,1: something blocks every path",
    );
    s.act([], { type: "remove_wall", from: square(3, 1), to: square(3, 2) });
    expect(() => s.act([], move("goblin-warrior", 9, 9))).toThrowError(
      "Goblin Warrior can't reach 9,9 (needs 45 ft, 30 left)",
    );
    s.act([], move("goblin-warrior", 5, 1));
    expect(s.get("goblin-warrior")?.position).toEqual(square(5, 1));
  });

  it("a given path can't go through a wall", () => {
    const s = fight([{ monster: "goblin-warrior", at: [0, 0] }]);
    s.act([], { type: "add_wall", from: square(1, -1), to: square(1, 2) });
    expect(() =>
      s.act([], { type: "move", id: "goblin-warrior", path: [square(1, 0), square(2, 0)] }),
    ).toThrow("Goblin Warrior can't move to 1,0: a wall stands between 0,0 and 1,0");
    expect(() => s.act([], { type: "add_wall", from: square(1, 2), to: square(1, -1) })).toThrow(
      "That wall is already there",
    );
  });

  it("an ally's space is passed through; an enemy's blocks unless two sizes apart (Difficult)", () => {
    const s = fight([
      { monster: "goblin-warrior", at: [0, 0] },
      { monster: "goblin-warrior", at: [1, 0] }, // an ally
      { monster: "guard", at: [3, 0], side: "party" }, // an enemy, Medium
      { monster: "goblin-warrior", at: [0, 3] },
    ]);
    s.act([], { type: "move", id: "goblin-warrior", path: [square(1, 0), square(2, 0)] });
    expect(s.get("goblin-warrior")).toMatchObject({ position: square(2, 0), moved: 10 });
    expect(() =>
      s.act([], { type: "move", id: "goblin-warrior", path: [square(3, 0), square(4, 0)] }),
    ).toThrow("Goblin Warrior can't move to 3,0: a creature is in the way at 3,0");
    // `to` goes around the guard instead.
    s.act([], move("goblin-warrior", 4, 0));
    expect(s.get("goblin-warrior")).toMatchObject({ position: square(4, 0), moved: 20 });
  });

  it("a Huge creature passes through a Small one's space, as Difficult Terrain", () => {
    const s = fight([
      { monster: "adult-red-dragon", at: [0, 0] },
      { monster: "goblin-warrior", at: [3, 1], side: "party" },
    ]);
    expect(() => s.act([], move("adult-red-dragon", 1, 0))).toThrow(
      "Goblin Warrior is in that space",
    );
    // Four steps; the first enters the goblin's square: 10 + 5 + 5 + 5.
    s.act([], move("adult-red-dragon", 4, 0));
    expect(s.get("adult-red-dragon")).toMatchObject({ position: square(4, 0), moved: 25 });
  });

  it("zones that are Difficult Terrain: Web", () => {
    const s = fight([
      { monster: "drider", at: [0, 0] },
      { monster: "goblin-warrior", at: [9, 1], side: "party" },
    ]);
    s.act([], { type: "cast", id: "drider", spell: "web", area: { point: square(4, 0) } });
    expect(s.encounter().zones[0]?.difficult).toBe(true);
    s.act([20], { type: "next_turn" }, move("goblin-warrior", 6, 1));
    // 8,1 is outside the webs (5 feet); 7,1 and 6,1 are in them (10 feet each).
    expect(s.get("goblin-warrior")).toMatchObject({ position: square(6, 1), moved: 25 });
  });

  it("an Opportunity Attack when it leaves reach on the way, not only at the end", () => {
    const s = fight([
      { monster: "goblin-warrior", at: [0, 0] },
      { monster: "guard", at: [2, 1], side: "party" },
    ]);
    // Past the guard: in its reach at 1,0 and 2,0, out of it at 4,0; the end is out of reach too.
    s.act([], move("goblin-warrior", 5, 0));
    expect(s.notes).toContain(
      "Goblin Warrior leaves Guard's reach: Guard can make an Opportunity Attack.",
    );
  });

  it("old encounters load with an empty map; options say how far is left", () => {
    const old = parseEncounter({ version: 1, combatants: [] });
    expect(old.map).toEqual({ walls: [], difficult: [], blocked: [] });
    const s = fight([{ monster: "goblin-warrior", at: [0, 0] }]);
    s.act([], { type: "set_terrain", squares: [square(1, 0)], kind: "difficult" });
    s.act([], move("goblin-warrior", 1, 0));
    const o = combatantOptions(s.encounter(), "goblin-warrior", { catalog });
    expect(o.economy.movement).toBe(20);
  });
});
