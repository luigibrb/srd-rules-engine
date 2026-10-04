import { describe, expect, it } from "vitest";
import {
  applyEncounterAction,
  type CharacterState,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  scriptedRng,
} from "../src/index";
import { areaSquares, distanceToPoint, inArea } from "../src/rules/areas";
import { catalog, fighterBuild } from "./helpers";

// Areas of effect on the grid: the SRD defines the shapes; how they cover squares is this
// engine's reading (a square is in when its center is inside), flagged in ARCHITECTURE.md.

const medium = (x: number, y: number) => ({ position: { x, y }, size: 1 });
const sorted = (s: Set<string>) => [...s].sort();

describe("areaSquares", () => {
  it("a Sphere from a grid intersection: a 20-foot radius covers 8×8 squares", () => {
    const squares = areaSquares({ shape: "sphere", size: 20, width: 5 }, medium(0, 0), {
      point: { x: 10, y: 10 },
    });
    expect(squares.size).toBe(64);
    expect(squares.has("6,6") && squares.has("13,13")).toBe(true);
    expect(squares.has("14,10") || squares.has("5,10")).toBe(false);
  });

  it("a Cone is as wide as it is far from its origin; the origin isn't included", () => {
    const squares = areaSquares({ shape: "cone", size: 15, width: 5 }, medium(0, 0), {
      toward: { x: 5, y: 0 },
    });
    expect(sorted(squares)).toEqual(["1,0", "2,-1", "2,0", "2,1", "3,-1", "3,0", "3,1"]);
  });

  it("a Line has its length and width; a Cube is placed by its corner", () => {
    const line = areaSquares({ shape: "line", size: 30, width: 5 }, medium(0, 0), {
      toward: { x: 10, y: 0 },
    });
    expect(sorted(line)).toEqual(["1,0", "2,0", "3,0", "4,0", "5,0", "6,0"]);
    const cube = areaSquares({ shape: "cube", size: 15, width: 5 }, medium(0, 0), {
      point: { x: 1, y: 0 },
    });
    expect(cube.size).toBe(9);
  });

  it("an Emanation surrounds its origin's space, without it", () => {
    const squares = areaSquares({ shape: "emanation", size: 10, width: 5 }, medium(0, 0), {});
    expect(squares.size).toBe(24);
    expect(squares.has("0,0")).toBe(false);
    // A Large creature counts if any of its squares is in.
    expect(inArea(squares, { position: { x: 2, y: 2 }, size: 2 })).toBe(true);
    expect(inArea(squares, { position: { x: 3, y: 3 }, size: 2 })).toBe(false);
  });

  it("distance from a space to a point", () => {
    expect(distanceToPoint(medium(0, 0), { x: 1, y: 1 })).toBe(0);
    expect(distanceToPoint(medium(0, 0), { x: 31, y: 0 })).toBe(150);
  });
});

describe("in an encounter", () => {
  function fight(
    monsters: { monster: string; at: [number, number] }[],
    brakkaAt: [number, number],
  ) {
    const build = fighterBuild();
    let state: CharacterState = createState(build, catalog);
    let encounter: Encounter = createEncounter();
    const notes: string[] = [];
    const act = (rolls: number[], ...actions: EncounterAction[]) => {
      const rng = scriptedRng(rolls);
      for (const a of actions) {
        const r = applyEncounterAction(encounter, a, {
          catalog,
          characters: { brakka: { build, state } },
          rng,
        });
        encounter = r.encounter;
        state = r.states.brakka ?? state;
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
      { type: "add_character", character: "brakka" },
      ...monsters.map((m) => ({ type: "add_monster", monster: m.monster }) as const),
      { type: "place", id: "brakka", x: brakkaAt[0], y: brakkaAt[1] },
      ...monsters.map(
        (m, i) => ({ type: "place", id: ids[i] as string, x: m.at[0], y: m.at[1] }) as const,
      ),
      ...ids.map((id, i) => ({ type: "set_initiative", id, value: 20 - i }) as const),
      { type: "set_initiative", id: "brakka", value: 1 },
      { type: "start" },
    );
    const get = (id: string) => encounter.combatants.find((c) => c.id === id);
    return { act, notes, get, state: () => state };
  }

  it("Fireball's targets are the creatures in its Sphere; its point must be in range", () => {
    const s = fight(
      [
        { monster: "mage", at: [0, 0] },
        { monster: "goblin-warrior", at: [12, 0] },
        { monster: "goblin-warrior", at: [20, 0] },
      ],
      [13, 1],
    );
    const fireball = (x: number, y: number): EncounterAction => ({
      type: "cast",
      id: "mage",
      spell: "fireball",
      area: { point: { x, y } },
    });
    expect(() => s.act([], fireball(40, 0))).toThrow(
      "That point is 195 feet away: out of Fireball's range (150 ft)",
    );
    s.act([20, 20, ...Array<number>(9).fill(1)], fireball(13, 1));
    expect(s.notes).toContain("Fireball's Sphere covers Brakka, Goblin Warrior.");
    expect(s.get("goblin-warrior-2")?.hp).toBe(10);
  });

  it("a breath weapon's Cone, aimed at a square", () => {
    // The Adult Red Dragon is Huge (3×3 at 0,0); its Fire Breath is a 60-foot Cone.
    const s = fight(
      [
        { monster: "adult-red-dragon", at: [0, 0] },
        { monster: "goblin-warrior", at: [6, 1] },
        { monster: "goblin-warrior", at: [1, 8] },
      ],
      [8, 2],
    );
    s.act([20, 20, ...Array<number>(17).fill(1)], {
      type: "save_action",
      id: "adult-red-dragon",
      ability: "Fire Breath",
      area: { toward: { x: 10, y: 1 } },
    });
    expect(s.notes).toContain("Fire Breath's Cone covers Brakka, Goblin Warrior.");
    expect(s.get("goblin-warrior-2")?.hp).toBe(10);
  });

  it("the dead aren't in an area any more", () => {
    const s = fight(
      [
        { monster: "mage", at: [0, 0] },
        { monster: "goblin-warrior", at: [12, 0] },
      ],
      [13, 1],
    );
    s.act([], { type: "effects", id: "brakka", actions: [{ type: "damage", amount: 30 }] });
    expect(s.state().dead).toBe(true);
    s.act([20, ...Array<number>(9).fill(1)], {
      type: "cast",
      id: "mage",
      spell: "fireball",
      area: { point: { x: 13, y: 1 } },
    });
    expect(s.notes).toContain("Fireball's Sphere covers Goblin Warrior.");
  });

  it("a single-target effect's range is checked", () => {
    const s = fight([{ monster: "quasit", at: [0, 0] }], [6, 0]);
    const scare: EncounterAction = {
      type: "save_action",
      id: "quasit",
      ability: "Scare (1/Day)",
      targets: ["brakka"],
    };
    expect(() => s.act([], scare)).toThrow(
      "Brakka is 30 feet away: out of Scare (1/Day)'s range (20 ft)",
    );
    expect(() =>
      s.act([], {
        ...scare,
        targets: undefined,
        area: { point: { x: 1, y: 1 } },
      } as EncounterAction),
    ).toThrow("Scare (1/Day) has no area: give its targets");
  });
});
