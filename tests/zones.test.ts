import { describe, expect, it } from "vitest";
import {
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
import { apply, autocomplete, catalog, classBuild } from "./helpers";

// Spell areas that last (SRD 5.2.1 "Spells"): Moonbeam, Spirit Guardians, Web, Grease. Creatures
// save when the area appears, when they enter it (or it moves onto them), and when they start or
// end their turn there.

/** Characters and monsters, in Initiative order as listed (20, 19, …), fight started. */
function session(
  builds: Record<string, CharacterBuild>,
  monsters: { monster: string; side?: string }[],
) {
  const states: Record<string, CharacterState> = Object.fromEntries(
    Object.entries(builds).map(([k, b]) => [k, createState(b, catalog)]),
  );
  let encounter: Encounter = createEncounter();
  const notes: string[] = [];
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
    }
  };
  const seen = new Map<string, number>();
  const ids = [
    ...Object.keys(builds),
    ...monsters.map(({ monster }) => {
      const n = (seen.get(monster) ?? 0) + 1;
      seen.set(monster, n);
      return n === 1 ? monster : `${monster}-${n}`;
    }),
  ];
  act(
    [],
    ...Object.keys(builds).map((character) => ({ type: "add_character", character }) as const),
    ...monsters.map((m) => ({ type: "add_monster", ...m }) as const),
    ...ids.map((id, i) => ({ type: "set_initiative", id, value: 20 - i }) as const),
    { type: "start" },
  );
  const get = (id: string) => encounter.combatants.find((c) => c.id === id);
  return { act, notes, get, states, encounter: () => encounter };
}
const next = { type: "next_turn" } as const;
const place = (id: string, x: number, y: number) => ({ type: "place", id, x, y }) as const;
const move = (id: string, x: number, y: number) => ({ type: "move", id, to: { x, y } }) as const;

describe("Moonbeam", () => {
  /** The druid's Moonbeam (DC 13, 2d10 Radiant) on the ogre; the second ogre is outside. */
  const moonbeam = () => {
    const s = session({}, [
      { monster: "druid", side: "party" },
      { monster: "ogre", side: "enemies" },
      { monster: "ogre", side: "enemies" },
    ]);
    s.act([], place("druid", 0, 0), place("ogre", 5, 0), place("ogre-2", 8, 0));
    s.act([2, 5, 5], {
      type: "cast",
      id: "druid",
      spell: "moonbeam",
      area: { point: { x: 6, y: 0 } },
    });
    return s;
  };

  it("the creatures in it save when it appears, and it lasts", () => {
    const s = moonbeam();
    expect(s.get("ogre")?.hp).toBe(68 - 10);
    expect(s.get("ogre-2")?.hp).toBe(68);
    expect(s.notes.at(-1)).toBe(
      "Moonbeam lasts (zone-1): creatures save when they enter it or end their turn there.",
    );
    expect(s.encounter().zones).toEqual([
      expect.objectContaining({
        id: "zone-1",
        label: "Moonbeam",
        by: "druid",
        point: { x: 6, y: 0 },
        save: { ability: "con", on_success: "half", dc: 13 },
        damage: [{ dice: "2d10", bonus: 0, type: "radiant" }],
        concentration: true,
        ends: { at: "start", of: "druid", count: 10, skip_current: false },
        saved: ["ogre"],
      }),
    ]);
  });

  it("a creature saves when it ends its turn there, and when it enters it, once per turn", () => {
    const s = moonbeam();
    s.act([2, 1, 1], next, next); // the ogre's turn ends in the beam
    expect(s.notes).toContain("Moonbeam: Ogre ends its turn in it (Constitution DC 13).");
    expect(s.get("ogre")?.hp).toBe(68 - 10 - 2);
    s.act([2, 3, 3], move("ogre-2", 6, -2)); // the second ogre's turn
    expect(s.notes).toContain("Moonbeam: Ogre 2 enters it (Constitution DC 13).");
    expect(s.get("ogre-2")?.hp).toBe(68 - 6);
    s.act([], move("ogre-2", 8, -2), move("ogre-2", 6, -2));
    expect(s.get("ogre-2")?.hp).toBe(68 - 6);
    expect(() =>
      s.act([], { type: "zone_save", zone: "zone-1", targets: ["ogre-2"] }),
    ).not.toThrow();
    expect(s.notes.at(-1)).toBe("Ogre 2 has already saved against Moonbeam this turn.");
  });

  it("moving it makes the creatures it moves onto save", () => {
    const s = moonbeam();
    s.act([20, 4, 4], { type: "move_zone", zone: "zone-1", point: { x: 9, y: 0 } });
    expect(s.notes).toContain("Moonbeam moves to 9,0.");
    expect(s.notes).toContain("Moonbeam: Ogre 2 enters it (Constitution DC 13).");
    expect(s.get("ogre-2")?.hp).toBe(68 - 4); // half of 8
  });

  it("it ends with the druid's Concentration", () => {
    const s = moonbeam();
    s.act([1], { type: "effects", id: "druid", actions: [{ type: "damage", amount: 1 }] });
    expect(s.notes).toContain("Moonbeam ends (Concentration ended).");
    expect(s.encounter().zones).toEqual([]);
  });
});

describe("Spirit Guardians", () => {
  const guardians = () =>
    session({}, [
      { monster: "priest", side: "party" },
      { monster: "ogre", side: "enemies" },
      { monster: "ogre", side: "enemies" },
    ]);

  it("the caster picks the damage type and the creatures it spares; no save when it appears", () => {
    const s = guardians();
    s.act([], place("priest", 0, 0), place("ogre", 2, 0), place("ogre-2", 9, 0));
    const cast = { type: "cast", id: "priest", spell: "spirit-guardians", area: {} } as const;
    expect(() => s.act([], cast)).toThrow(
      "Spirit Guardians: choose its damage type (radiant or necrotic)",
    );
    s.act([], { ...cast, damage_type: "radiant", unaffected: ["ogre-2"] });
    expect(s.get("ogre")?.hp).toBe(68);
    expect(s.encounter().zones[0]).toMatchObject({
      point: null,
      unaffected: ["ogre-2"],
      damage: [{ dice: "3d8", type: "radiant" }],
    });
  });

  it("it moves with the caster onto creatures, who save", () => {
    const s = guardians();
    s.act([], place("priest", 0, 0), place("ogre", 5, 0), place("ogre-2", 1, 2));
    s.act([], {
      type: "cast",
      id: "priest",
      spell: "spirit-guardians",
      area: {},
      damage_type: "necrotic",
      unaffected: ["ogre-2"],
    });
    s.act([2, 4, 4, 4], move("priest", 2, 0)); // the Emanation reaches the ogre 15 feet away
    expect(s.notes).toContain("Spirit Guardians: Ogre enters it (Wisdom DC 13).");
    expect(s.get("ogre")?.hp).toBe(68 - 12);
    expect(s.get("ogre-2")?.hp).toBe(68);
  });
});

describe("Web", () => {
  it("Restrained on a failed save when a creature starts its turn there; an Athletics check escapes", () => {
    const s = session({}, [{ monster: "drider" }, { monster: "ogre" }]);
    s.act([], place("drider", 0, 0), place("ogre", 5, 0));
    s.act([], { type: "cast", id: "drider", spell: "web", area: { point: { x: 4, y: 0 } } });
    expect(s.get("ogre")?.conditions).toEqual([]);
    s.act([2], next);
    expect(s.notes).toContain("Web: Ogre starts its turn in it (Dexterity DC 14).");
    expect(s.get("ogre")?.conditions).toEqual(["restrained"]);
    expect(s.encounter().effects[0]).toMatchObject({
      condition: "restrained",
      label: "Web",
      escape_dc: 14,
      escape_skill: "athletics",
    });
    expect(() => s.act([], { type: "escape", id: "ogre", skill: "acrobatics" })).toThrow(
      "Escaping Web takes an Athletics check",
    );
    s.act([12], { type: "escape", id: "ogre" });
    expect(s.notes.at(-2)).toMatch(/^Ogre tries to escape \(athletics 16 vs DC 14\): escapes\.$/);
    expect(s.get("ogre")?.conditions).toEqual([]);
  });
});

describe("Grease", () => {
  // A wizard with Grease: save DC 12.
  let ilse = autocomplete(classBuild("wizard", { name: "Ilse" }));
  ilse = apply(ilse, svc.setChoice, "class:wizard#spellbook", [
    "grease",
    "magic-missile",
    "shield",
    "sleep",
    "burning-hands",
    "ice-knife",
  ]);
  ilse = autocomplete(ilse);
  ilse = apply(ilse, svc.setChoice, "class:wizard#prepared", [
    "grease",
    "magic-missile",
    "shield",
    "sleep",
  ]);

  it("without positions the caller names who saves, as often as the spell allows", () => {
    const s = session({ ilse }, [{ monster: "ogre" }]);
    s.act([2], { type: "cast", id: "ilse", spell: "grease", targets: ["ogre"] });
    expect(s.get("ogre")?.conditions).toEqual(["prone"]);
    expect(s.encounter().zones[0]).toMatchObject({
      label: "Grease",
      point: null,
      once_per_turn: false,
      concentration: false,
      ends: { at: "start", of: "ilse", count: 10 },
    });
    s.act([20], { type: "zone_save", zone: "zone-1", targets: ["ogre"] });
    expect(s.notes.at(-1)).toMatch(/^Ogre: succeeds/);
    s.act([], { type: "end_zone", zone: "zone-1" });
    expect(s.notes.at(-1)).toBe("Grease ends (ended).");
  });
});
