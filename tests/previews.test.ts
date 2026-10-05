import { describe, expect, it } from "vitest";
import { createHandler } from "../src/http/index";
import {
  applyEncounterAction,
  createEncounter,
  type Encounter,
  type EncounterAction,
  parseEncounter,
  previewArea,
  previewMove,
  reachableSquares,
  scriptedRng,
} from "../src/index";
import { catalog } from "./helpers";

// Previews for a map UI: where a combatant can go, what a move or an area would do. They must
// agree with what the engine then does.

const p = (x: number, y: number) => ({ x, y });

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

describe("reachableSquares", () => {
  it("every square it can end on, with its cost; walls, terrain and creatures count", () => {
    const s = fight([
      { monster: "goblin-warrior", at: [0, 0] },
      { monster: "guard", at: [1, 0], side: "party" },
    ]);
    s.act(
      [],
      { type: "set_terrain", squares: [p(0, 1)], kind: "difficult" },
      { type: "set_terrain", squares: [p(-1, 0)], kind: "blocked" },
    );
    const r = reachableSquares(s.encounter(), "goblin-warrior", { catalog });
    expect(r.movement).toBe(30);
    const at = (x: number, y: number) => r.squares.find((q) => q.x === x && q.y === y)?.cost;
    expect(at(1, 1)).toBe(5);
    expect(at(0, 1)).toBe(10); // Difficult Terrain
    expect(at(1, 0)).toBeUndefined(); // the guard's space
    expect(at(-1, 0)).toBeUndefined(); // blocked
    expect(at(6, 6)).toBe(30);
    expect(at(7, 0)).toBeUndefined();
    // Every square listed is one the engine moves to for that cost.
    for (const q of r.squares.filter((_, i) => i % 7 === 0)) {
      const moved = applyEncounterAction(
        s.encounter(),
        { type: "move", id: "goblin-warrior", to: { x: q.x, y: q.y } },
        { catalog, rng: scriptedRng([]) },
      ).encounter.combatants[0];
      expect(moved?.moved, `${q.x},${q.y}`).toBe(q.cost);
    }
  });
});

describe("previewMove", () => {
  it("the path and its cost, the zones on the way and the Opportunity Attacks", () => {
    const s = fight([
      { monster: "druid", at: [0, 5], side: "party" },
      { monster: "goblin-warrior", at: [0, 0] },
      { monster: "guard", at: [1, 1], side: "party" },
    ]);
    s.act([], { type: "cast", id: "druid", spell: "moonbeam", area: { point: p(4, 1) } });
    s.act([], { type: "next_turn" });
    const preview = previewMove(s.encounter(), { id: "goblin-warrior", to: p(5, 0) }, { catalog });
    expect(preview).toMatchObject({
      ok: true,
      reasons: [],
      cost: 25,
      movement_left: 5,
      opportunity_attacks: ["guard"],
    });
    expect(preview.path.at(-1)).toEqual(p(5, 0));
    expect(preview.zones).toEqual([
      {
        zone: "zone-1",
        label: "Moonbeam",
        creature: "goblin-warrior",
        at: p(3, 0),
        kind: "enters",
        feet: null,
      },
    ]);
    const far = previewMove(s.encounter(), { id: "goblin-warrior", to: p(9, 0) }, { catalog });
    expect(far).toMatchObject({
      ok: false,
      reasons: ["Goblin Warrior can move 30 more feet this turn"],
    });
  });

  it("feet moved in a zone that hurts for it (Spike Growth)", () => {
    const s = fight([
      { monster: "druid", at: [0, 0], side: "party" },
      { monster: "goblin-warrior", at: [10, 0] },
    ]);
    s.act([], { type: "next_turn" });
    // The zone Spike Growth leaves (a 20-foot Sphere at 7,1), as the encounter records it.
    const encounter = parseEncounter({
      ...s.encounter(),
      zones: [
        {
          id: "zone-1",
          spell: "spike-growth",
          label: "Spike Growth",
          by: "druid",
          area: { shape: "sphere", size: 20 },
          point: p(7, 1),
          save: null,
          damage: [{ dice: "2d4", bonus: 0, type: "piercing" }],
          triggers: ["move"],
          difficult: true,
        },
      ],
    });
    const preview = previewMove(encounter, { id: "goblin-warrior", to: p(8, 0) }, { catalog });
    expect(preview.zones).toEqual([
      expect.objectContaining({ label: "Spike Growth", kind: "moves_in", feet: 10 }),
    ]);
    expect(preview.cost).toBe(20);
  });
});

describe("previewArea", () => {
  it("a spell's squares and the creatures in it with their cover; refusals in the engine's words", () => {
    const s = fight([
      { monster: "mage", at: [12, 12] },
      { monster: "goblin-warrior", at: [5, 5], side: "party" },
      { monster: "goblin-warrior", at: [7, 7], side: "party" },
      { monster: "goblin-warrior", at: [6, 6], side: "party" },
      { monster: "goblin-warrior", at: [2, 5], side: "party" },
    ]);
    s.act([], { type: "add_wall", from: p(4, 0), to: p(4, 10) });
    const preview = previewArea(
      s.encounter(),
      { id: "mage", spell: "fireball", area: { point: p(6, 6) } },
      { catalog },
    );
    expect(preview.ok).toBe(true);
    // 8×8 squares (x and y 2–9), the two columns behind the wall left out.
    expect(preview.squares).toHaveLength(6 * 8);
    expect(preview.targets).toEqual([
      { id: "goblin-warrior", cover: "none", by: null },
      { id: "goblin-warrior-2", cover: "half", by: "Goblin Warrior 3" },
      { id: "goblin-warrior-3", cover: "none", by: null },
    ]);
    const far = previewArea(
      s.encounter(),
      { id: "mage", spell: "fireball", area: { point: p(60, 60) } },
      { catalog },
    );
    expect(far).toMatchObject({
      ok: false,
      reasons: [expect.stringMatching(/out of Fireball's range/)],
    });
  });

  it("a breath weapon's Cone, aimed at a square", () => {
    const s = fight([
      { monster: "red-dragon-wyrmling", at: [0, 0] },
      { monster: "guard", at: [2, 0], side: "party" },
    ]);
    const preview = previewArea(
      s.encounter(),
      { id: "red-dragon-wyrmling", ability: "Fire Breath", area: { toward: p(5, 0) } },
      { catalog },
    );
    expect(preview.targets.map((t) => t.id)).toEqual(["guard"]);
    expect(
      previewArea(
        s.encounter(),
        { id: "guard", spell: "fire-bolt", area: { point: p(1, 1) } },
        { catalog },
      ),
    ).toMatchObject({ ok: false, reasons: ["Fire Bolt has no area to place"] });
  });
});

describe("preview routes", () => {
  it("POST /v1/encounters/reachable, /preview-move and /preview-area", async () => {
    const s = fight([{ monster: "goblin-warrior", at: [0, 0] }]);
    const handler = createHandler({ catalog });
    const post = async (path: string, body: unknown) => {
      const res = await handler(
        new Request(`http://test${path}`, { method: "POST", body: JSON.stringify(body) }),
      );
      return { status: res.status, body: await res.json() };
    };
    const encounter = s.encounter();
    const reach = await post("/v1/encounters/reachable", { encounter, id: "goblin-warrior" });
    expect(reach.status).toBe(200);
    expect(reach.body.squares).toHaveLength(168); // 13 × 13 − 1
    const move = await post("/v1/encounters/preview-move", {
      encounter,
      id: "goblin-warrior",
      to: p(2, 2),
    });
    expect(move.body).toMatchObject({ ok: true, cost: 10 });
    const area = await post("/v1/encounters/preview-area", {
      encounter,
      id: "goblin-warrior",
      spell: "fireball",
      area: { point: p(2, 2) },
    });
    expect(area.body.ok).toBe(true);
    const bad = await post("/v1/encounters/preview-area", { encounter, id: "x", area: 3 });
    expect(bad.status).toBe(422);
  });
});
