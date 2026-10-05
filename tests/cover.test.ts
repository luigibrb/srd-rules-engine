import { describe, expect, it } from "vitest";
import {
  type AttackResult,
  applyEncounterAction,
  combatantOptions,
  createEncounter,
  type Encounter,
  type EncounterAction,
  type SpellCastResult,
  scriptedRng,
} from "../src/index";
import { coverDegree, lineClear, obstacles, spaceCorners, type Wall } from "../src/rules/grid";
import { zoneArea } from "../src/services/encounter";
import { catalog } from "./helpers";

// SRD 5.2.1 "Cover" (Half +2, Three-Quarters +5, Total: can't be targeted; another creature gives
// Half Cover; only against effects from the other side), "Area of Effect" (a location every line
// from the point of origin to is blocked isn't in the area), spells' "A Clear Path to the
// Target". How cover is found on a grid is the DMG-style reading flagged in ARCHITECTURE.md.

const p = (x: number, y: number) => ({ x, y });
const wall = (x1: number, y1: number, x2: number, y2: number): Wall => ({
  from: p(x1, y1),
  to: p(x2, y2),
});

describe("lines and cover on the grid", () => {
  it("a line is blocked by crossing a wall or passing a joint, not by grazing one", () => {
    const L = [wall(2, 0, 2, 2), wall(2, 2, 4, 2)];
    expect(lineClear(p(0, 1), p(3, 1), L)).toBe(false); // crosses
    expect(lineClear(p(1, 3), p(3, 1), L)).toBe(false); // through the L's corner, into it
    expect(lineClear(p(1, 1), p(3, 3), L)).toBe(true); // past the corner, outside it
    expect(lineClear(p(2, -1), p(2, 3), [wall(2, 0, 2, 2)])).toBe(true); // along its face
    expect(lineClear(p(0, 0), p(4, 0), [wall(2, -2, 2, 0)])).toBe(true); // past its free end
    // Two blocked squares touching at a corner: no line between them.
    expect(lineClear(p(0, 2), p(2, 0), obstacles([], ["0,0", "1,1"]))).toBe(false);
  });

  it("degrees: none, Half, Three-Quarters, Total; a creature in between gives Half", () => {
    const attacker = spaceCorners({ position: p(0, 0), size: 1 });
    const target = { position: p(4, 0), size: 1 };
    const degree = (walls: Wall[], blocked: string[] = []) =>
      coverDegree(attacker, target, obstacles(walls, blocked)).degree;
    expect(degree([])).toBe("none");
    expect(degree([], ["3,0"])).toBe("half"); // a pillar
    expect(degree([wall(3, -3, 3, 1)])).toBe("half"); // a wall up to the target's row
    expect(degree([wall(4, -2, 4, 2)], ["3,0"])).toBe("three_quarters");
    expect(degree([wall(3, -3, 3, 4)])).toBe("total");
    // A slit as wide as a square doesn't hide it.
    expect(degree([wall(3, -3, 3, 0), wall(3, 1, 3, 4)])).toBe("none");
    expect(coverDegree(attacker, target, [], [{ position: p(2, 0), size: 1 }])).toEqual({
      degree: "half",
      by: 0,
    });
  });
});

/** Monsters placed on the grid, Initiative in the order given. */
function fight(monsters: { monster: string; at: [number, number]; side?: string }[]) {
  let encounter: Encounter = createEncounter();
  const notes: string[] = [];
  let result: unknown = null;
  const act = (rolls: number[], ...actions: EncounterAction[]) => {
    for (const action of actions) {
      const r = applyEncounterAction(encounter, action, { catalog, rng: scriptedRng(rolls) });
      encounter = r.encounter;
      notes.push(...r.notes);
      result = r.result;
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
  return { act, notes, encounter: () => encounter, result: () => result };
}
const shoot = (cover?: "half" | "three_quarters" | "total") =>
  ({
    type: "attack",
    id: "goblin-warrior",
    target: "guard",
    attack: "Shortbow",
    ...(cover ? { cover } : {}),
  }) as const;

describe("cover in encounters", () => {
  it("worked out for attacks: +2 or +5 AC, noted; Total Cover can't be targeted", () => {
    const half = fight([
      { monster: "goblin-warrior", at: [0, 0] },
      { monster: "guard", at: [4, 0], side: "party" },
    ]);
    half.act([], { type: "set_terrain", squares: [p(3, 0)], kind: "blocked" });
    half.act([10, 1], shoot());
    expect(half.notes).toContain("Guard has Half Cover (behind an obstacle).");
    expect((half.result() as AttackResult).target_ac).toBe(16 + 2);

    const most = fight([
      { monster: "goblin-warrior", at: [0, 0] },
      { monster: "guard", at: [4, 0], side: "party" },
    ]);
    most.act(
      [],
      { type: "set_terrain", squares: [p(3, 0)], kind: "blocked" },
      { type: "add_wall", from: p(4, -2), to: p(4, 2) },
    );
    most.act([10, 1], shoot());
    expect(most.notes).toContain("Guard has Three-Quarters Cover (behind an obstacle).");
    expect((most.result() as AttackResult).target_ac).toBe(16 + 5);

    const hidden = fight([
      { monster: "goblin-warrior", at: [0, 0] },
      { monster: "guard", at: [4, 0], side: "party" },
    ]);
    hidden.act([], { type: "add_wall", from: p(3, -3), to: p(3, 4) });
    expect(() => hidden.act([10, 1], shoot())).toThrow(
      "Guard has Total Cover: it can't be targeted",
    );
    // Cover given by the caller wins (the GM's call).
    hidden.act([10, 1], shoot("half"));
    expect((hidden.result() as AttackResult).target_ac).toBe(16 + 2);
  });

  it("another creature in the way gives Half Cover", () => {
    const s = fight([
      { monster: "goblin-warrior", at: [0, 0] },
      { monster: "guard", at: [4, 0], side: "party" },
      { monster: "goblin-warrior", at: [2, 0] },
    ]);
    s.act([10, 1], shoot());
    expect(s.notes).toContain("Guard has Half Cover (behind Goblin Warrior 2).");
  });

  it("a Fireball doesn't go through a wall; a creature in between gives Half Cover on the save", () => {
    const s = fight([
      { monster: "mage", at: [12, 12] },
      { monster: "goblin-warrior", at: [2, 5], side: "party" }, // behind the wall
      { monster: "goblin-warrior", at: [5, 5], side: "party" },
      { monster: "goblin-warrior", at: [7, 7], side: "party" }, // behind goblin 3 from the point
      { monster: "goblin-warrior", at: [6, 6], side: "party" },
    ]);
    s.act([], { type: "add_wall", from: p(4, 0), to: p(4, 10) });
    const fireball = {
      type: "cast",
      id: "mage",
      spell: "fireball",
      area: { point: p(6, 6) },
    } as const;
    s.act(Array(40).fill(10), fireball);
    expect(s.notes).toContain(
      "Fireball's Sphere covers Goblin Warrior 2, Goblin Warrior 3, Goblin Warrior 4.",
    );
    expect(s.notes).toContain("Goblin Warrior 3 has Half Cover (behind Goblin Warrior 4).");
    const saves = (s.result() as SpellCastResult).targets.map((t) => t.save?.total);
    // Goblin Warrior 3 adds 2 to its Dexterity save (d20 10 + 2, + 2).
    expect(saves).toEqual([12, 14, 12]);
  });

  it("a zone's squares stop at a wall, and leave out blocked squares", () => {
    const s = fight([{ monster: "drider", at: [0, 0] }]);
    s.act(
      [],
      { type: "add_wall", from: p(6, -10), to: p(6, 10) },
      { type: "set_terrain", squares: [p(7, 0)], kind: "blocked" },
    );
    // Web's 20-foot Cube covers 4,0 to 7,3; its point of origin is its center, on the wall.
    s.act([], { type: "cast", id: "drider", spell: "web", area: { point: p(4, 0) } });
    const zone = s.encounter().zones[0] as NonNullable<Encounter["zones"][number]>;
    const squares = [...(zoneArea(s.encounter(), { catalog }, zone) ?? [])].sort();
    expect(squares).toHaveLength(15);
    expect(squares).not.toContain("7,0");
    s.act([], { type: "end_zone", zone: zone.id });
    s.act([], { type: "remove_wall", from: p(6, -10), to: p(6, 10) });
    s.act([], { type: "add_wall", from: p(5, -10), to: p(5, 10) });
    s.act(Array(10).fill(6), { type: "next_turn" });
    s.act([], { type: "cast", id: "drider", spell: "web", area: { point: p(4, 0) } });
    const behind = s.encounter().zones[0] as NonNullable<Encounter["zones"][number]>;
    // Now the wall is between the center (6,2) and the column x = 4.
    const left = [...(zoneArea(s.encounter(), { catalog }, behind) ?? [])].filter((k) =>
      k.startsWith("4,"),
    );
    expect(left).toEqual([]);
  });

  it("options don't offer a target behind Total Cover", () => {
    const s = fight([
      { monster: "goblin-warrior", at: [0, 0] },
      { monster: "guard", at: [4, 0], side: "party" },
      { monster: "guard", at: [0, 4], side: "party" },
    ]);
    s.act([], { type: "add_wall", from: p(3, -3), to: p(3, 3) });
    const o = combatantOptions(s.encounter(), "goblin-warrior", { catalog });
    const bow = o.attacks.find((x) => x.label.startsWith("Shortbow"));
    expect(bow?.targets?.ids).toEqual(["guard-2"]);
    s.act([], { type: "add_wall", from: p(-3, 3), to: p(3, 3) });
    const none = combatantOptions(s.encounter(), "goblin-warrior", { catalog });
    expect(none.attacks.find((x) => x.label.startsWith("Shortbow"))).toMatchObject({
      available: false,
      reason: "Guard has Total Cover: it can't be targeted",
      targets: { ids: [] },
    });
  });
});
