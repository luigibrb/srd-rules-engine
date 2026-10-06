import { describe, expect, it } from "vitest";
import {
  applyEncounterAction,
  type CharacterBuild,
  type CharacterState,
  computePlaySheet,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  mapCover,
  previewMove,
  resolve,
  scriptedRng,
} from "../src/index";
import * as svc from "../src/services/builder";
import { autocomplete, catalog, classBuild, levelUpIn } from "./helpers";

// SRD 5.2.1 wall spells: Blade Barrier, Wall of Fire, Wall of Force, Wall of Ice, Wall of Stone,
// Wall of Thorns, placed from point to point (straight walls; rings are text).

/** A character of `classId` at level `n` with `spell` prepared (in place of another pick). */
function caster(classId: string, n: number, spell: string): CharacterBuild {
  let b = levelUpIn(autocomplete(classBuild(classId, { name: "Ilse" })), classId, n - 1);
  if (computePlaySheet(b, createState(b, catalog), catalog).spells.some((x) => x.id === spell)) {
    return b;
  }
  const res = resolve(b, catalog);
  const choice = res.choices.find(
    (c) => c.definition.kind === "spell" && res.options(c).some((o) => o.id === spell),
  );
  if (!choice) throw new Error(`no choice offers ${spell}`);
  const picked = res.selected(choice);
  b = svc.setChoice(b, catalog, choice.key, [...picked.slice(0, -1), spell]).build;
  return b;
}

function session(
  builds: Record<string, CharacterBuild>,
  monsters: { monster: string; at: [number, number]; side?: string }[],
  at: Record<string, [number, number]>,
) {
  const states: Record<string, CharacterState> = Object.fromEntries(
    Object.entries(builds).map(([k, b]) => [k, createState(b, catalog)]),
  );
  let encounter: Encounter = createEncounter();
  const notes: string[] = [];
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
    }
  };
  const keys = Object.keys(builds);
  const seen = new Map<string, number>();
  const ids = monsters.map(({ monster }) => {
    const k = (seen.get(monster) ?? 0) + 1;
    seen.set(monster, k);
    return k === 1 ? monster : `${monster}-${k}`;
  });
  act(
    [],
    ...keys.map((character) => ({ type: "add_character", character, side: "party" }) as const),
    ...monsters.map(
      (m) => ({ type: "add_monster", monster: m.monster, side: m.side ?? "enemies" }) as const,
    ),
    ...keys.map((id) => ({ type: "place", id, x: at[id]?.[0] ?? 0, y: at[id]?.[1] ?? 0 }) as const),
    ...monsters.map(
      (m, i) => ({ type: "place", id: ids[i] as string, x: m.at[0], y: m.at[1] }) as const,
    ),
    ...[...keys, ...ids].map((id, i) => ({ type: "set_initiative", id, value: 20 - i }) as const),
    { type: "start" },
  );
  const get = (id: string) => encounter.combatants.find((c) => c.id === id);
  return { act, notes, get, states, ctx, encounter: () => encounter };
}
const p = (x: number, y: number) => ({ x, y });
const next = { type: "next_turn" } as const;

describe("walls between squares: Wall of Stone, Wall of Ice", () => {
  it("block movement and lines while the caster concentrates", () => {
    const s = session(
      { ilse: caster("druid", 9, "wall-of-stone") },
      [{ monster: "goblin-warrior", at: [6, 0] }],
      { ilse: [0, 0] },
    );
    expect(() =>
      s.act([], { type: "cast", id: "ilse", spell: "wall-of-stone", targets: [] }),
    ).toThrow("Wall of Stone is a wall: place it with `wall: {from, to}`");
    expect(() =>
      s.act([], {
        type: "cast",
        id: "ilse",
        spell: "wall-of-stone",
        wall: { from: p(4, -15), to: p(4, 15) },
      }),
    ).toThrow("Wall of Stone is at most 100 feet long (this one: 150)");
    s.act([], {
      type: "cast",
      id: "ilse",
      spell: "wall-of-stone",
      wall: { from: p(4, -5), to: p(4, 5) },
    });
    expect(s.notes).toContain("Wall of Stone lasts (zone-1).");
    expect(s.encounter().zones[0]?.segments).toEqual([{ from: p(4, -5), to: p(4, 5) }]);
    // Total Cover behind it; the goblin goes around (or can't, within its Speed).
    const corners = [p(0, 0), p(1, 0), p(0, 1), p(1, 1)];
    expect(
      mapCover(s.encounter(), s.ctx(), corners, s.get("goblin-warrior") as never, ["ilse"]).degree,
    ).toBe("total");
    s.act([], next);
    expect(
      previewMove(s.encounter(), { id: "goblin-warrior", to: p(2, 0) }, s.ctx()),
    ).toMatchObject({
      ok: false,
      reasons: [
        expect.stringMatching(/^Goblin Warrior can't reach 2,0 \(needs \d+ ft, 30 left\)$/),
      ],
    });
    // Concentration ends: so does the wall.
    s.act([], {
      type: "effects",
      id: "ilse",
      actions: [{ type: "set_concentration", spell: null }],
    });
    expect(s.encounter().zones).toEqual([]);
  });

  it("an ice devil's Wall of Ice", () => {
    const s = session(
      {},
      [
        { monster: "ice-devil", at: [0, 0] },
        { monster: "goblin-warrior", at: [6, 0], side: "party" },
      ],
      {},
    );
    s.act([], {
      type: "cast",
      id: "ice-devil",
      spell: "wall-of-ice",
      wall: { from: p(4, -2), to: p(4, 3) },
    });
    expect(s.encounter().zones[0]).toMatchObject({
      label: "Wall of Ice",
      segments: [{ from: p(4, -2), to: p(4, 3) }],
    });
  });
});

describe("walls of squares: Blade Barrier, Wall of Thorns, Wall of Fire", () => {
  it("Blade Barrier: a save when it appears, Three-Quarters Cover through it, Difficult Terrain", () => {
    const s = session(
      { ilse: caster("cleric", 11, "blade-barrier") },
      [
        { monster: "goblin-warrior", at: [4, 0] },
        { monster: "goblin-warrior", at: [8, 0] },
      ],
      { ilse: [0, 0] },
    );
    // 6d10 Force (all 10s), then the goblin's save: 10 + 2 vs DC 14.
    s.act(Array(10).fill(10), {
      type: "cast",
      id: "ilse",
      spell: "blade-barrier",
      wall: { from: p(4, -2), to: p(4, 3) },
    });
    expect(s.notes.some((n) => n.startsWith("Goblin Warrior: fails"))).toBe(true);
    expect(s.get("goblin-warrior")?.defeated).toBe(true); // 6d10 Force
    const zone = s.encounter().zones[0];
    expect(zone).toMatchObject({ difficult: true, cover: "three_quarters" });
    const corners = [p(0, 0), p(1, 0), p(0, 1), p(1, 1)];
    expect(
      mapCover(s.encounter(), s.ctx(), corners, s.get("goblin-warrior-2") as never, ["ilse"])
        .degree,
    ).toBe("three_quarters");
  });

  it("Wall of Thorns: 20 feet a square to move through; Slashing on entering", () => {
    const s = session(
      { ilse: caster("druid", 11, "wall-of-thorns") },
      [{ monster: "ogre", at: [6, 0] }],
      { ilse: [0, 0] },
    );
    s.act([], {
      type: "cast",
      id: "ilse",
      spell: "wall-of-thorns",
      wall: { from: p(5, 3), to: p(5, -3) },
    });
    s.act([], next);
    const preview = previewMove(s.encounter(), { id: "ogre", path: [p(5, 0), p(4, 0)] }, s.ctx());
    // The ogre is Large: its first step puts two squares in the wall (20 feet), the next 5.
    expect(preview.cost).toBe(25);
    expect(preview.zones.map((z) => z.label)).toEqual(["Wall of Thorns"]);
    s.act(Array(20).fill(1), { type: "move", id: "ogre", path: [p(5, 0), p(4, 0)] });
    expect(s.notes.some((n) => /Ogre: fails .*slashing/.test(n))).toBe(true);
  });

  it("Wall of Fire: its damaging side, no save after it appears", () => {
    const s = session(
      {},
      [
        { monster: "efreeti", at: [0, 0] },
        { monster: "goblin-warrior", at: [8, 1], side: "party" },
      ],
      {},
    );
    expect(() =>
      s.act([], {
        type: "cast",
        id: "efreeti",
        spell: "wall-of-fire",
        wall: { from: p(6, 0), to: p(6, 5) },
      }),
    ).toThrow("Wall of Fire: choose its damaging side (`side`: left or right)");
    // From 6,0 down to 6,5: its left side is toward +x (the goblin).
    s.act([], {
      type: "cast",
      id: "efreeti",
      spell: "wall-of-fire",
      wall: { from: p(6, 0), to: p(6, 5), side: "left" },
    });
    const zone = s.encounter().zones[0];
    expect(zone?.wall_squares).toHaveLength(6);
    expect(zone?.squares).toHaveLength(18);
    s.act(Array(10).fill(3), next, next);
    // The goblin ends its turn within 10 feet of that side: 8d8 (cast at level 7) fire, no save.
    expect(s.notes).toContain("Wall of Fire: Goblin Warrior ends its turn in it: 24 fire.");
  });
});

describe("a wall's character resources", () => {
  it("spends the slot like any spell", () => {
    const b = caster("druid", 9, "wall-of-stone");
    const s = session({ ilse: b }, [], { ilse: [0, 0] });
    s.act([], {
      type: "cast",
      id: "ilse",
      spell: "wall-of-stone",
      wall: { from: p(3, 0), to: p(3, 4) },
    });
    expect(
      computePlaySheet(b, s.states.ilse as CharacterState, catalog).play.spell_slots[4]?.spent,
    ).toBe(1);
  });
});
