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
import { apply, autocomplete, catalog, classBuild, levelUpIn } from "./helpers";

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
    ...Object.keys(builds).map(
      (character) => ({ type: "add_character", character, side: "party" }) as const,
    ),
    ...monsters.map((m) => ({ type: "add_monster", side: "enemies", ...m }) as const),
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

/** A level 5 druid (spell save DC 13) with these spells prepared. */
function druid(spells: string[]): CharacterBuild {
  const b = levelUpIn(autocomplete(classBuild("druid", { name: "Wren" })), "druid", 4);
  const others = (b.choices["class:druid#prepared"] ?? []).filter((x) => !spells.includes(x));
  return apply(b, svc.setChoice, "class:druid#prepared", [
    ...spells,
    ...others.slice(spells.length),
  ]);
}

describe("moving through zones", () => {
  it("a creature that passes through Moonbeam saves on the way", () => {
    const s = session({}, [{ monster: "druid", side: "party" }, { monster: "goblin-warrior" }]);
    s.act([], place("druid", 0, 0), place("goblin-warrior", 8, 0));
    s.act([], { type: "cast", id: "druid", spell: "moonbeam", area: { point: { x: 6, y: 0 } } });
    s.act([20, 1, 1], next, move("goblin-warrior", 3, 0));
    expect(s.notes).toContain("Moonbeam: Goblin Warrior enters it (Constitution DC 13).");
    expect(s.get("goblin-warrior")).toMatchObject({ hp: 9, position: { x: 3, y: 0 }, moved: 25 });
  });

  it("Web stops a creature it restrains on the way", () => {
    const s = session({}, [{ monster: "drider" }, { monster: "goblin-warrior", side: "party" }]);
    s.act([], place("drider", 0, 0), place("goblin-warrior", 9, 1));
    s.act([], { type: "cast", id: "drider", spell: "web", area: { point: { x: 4, y: 0 } } });
    // The webs are Difficult Terrain: 5 feet to 8,1, then 10 a square (30 feet reach 6,1).
    expect(() => s.act([], next, move("goblin-warrior", 5, 1))).toThrow(
      "Goblin Warrior can move 30 more feet this turn",
    );
    s.act([2], move("goblin-warrior", 6, 1));
    expect(s.get("goblin-warrior")?.conditions).toEqual(["restrained"]);
    expect(s.notes).toContain("Goblin Warrior stops at 7,1.");
    expect(s.get("goblin-warrior")).toMatchObject({ position: { x: 7, y: 1 }, moved: 15 });
  });

  it("a path is followed square by square; a gap in it is refused", () => {
    const s = session({}, [{ monster: "goblin-warrior" }]);
    s.act([], place("goblin-warrior", 0, 0));
    expect(() =>
      s.act([], {
        type: "move",
        id: "goblin-warrior",
        path: [
          { x: 1, y: 0 },
          { x: 3, y: 0 },
        ],
      }),
    ).toThrow("The path jumps from 1,0 to 3,0: give every square");
    s.act([], {
      type: "move",
      id: "goblin-warrior",
      path: [
        { x: 1, y: 1 },
        { x: 2, y: 1 },
        { x: 2, y: 0 },
      ],
    });
    expect(s.get("goblin-warrior")).toMatchObject({ position: { x: 2, y: 0 }, moved: 15 });
  });
});

describe("Spike Growth", () => {
  it("2d4 Piercing for every 5 feet moved into or within it, no save", () => {
    const s = session({ wren: druid(["spike-growth"]) }, [{ monster: "goblin-warrior" }]);
    s.act([], place("wren", 0, 0), place("goblin-warrior", 12, 0));
    s.act([], { type: "cast", id: "wren", spell: "spike-growth", area: { point: { x: 6, y: 0 } } });
    expect(s.notes.at(-1)).toBe(
      "Spike Growth lasts (zone-1): creatures take its damage for every 5 feet they move in it.",
    );
    s.act([1, 1, 1, 1], next, move("goblin-warrior", 8, 0)); // 9,0 and 8,0 are in it
    expect(s.notes).toContain("Spike Growth: Goblin Warrior moves 10 feet in it: 4 piercing.");
    expect(s.get("goblin-warrior")?.hp).toBe(6);
  });
});

describe("Stinking Cloud and Sleet Storm", () => {
  it("Stinking Cloud: Poisoned and no action or Bonus Action for the turn", () => {
    let wizard = levelUpIn(autocomplete(classBuild("wizard", { name: "Ilse" })), "wizard", 4);
    wizard = apply(wizard, svc.setChoice, "class:wizard:5#spellbook", ["stinking-cloud", "fly"]);
    const prepared = wizard.choices["class:wizard#prepared"] ?? [];
    wizard = apply(wizard, svc.setChoice, "class:wizard#prepared", [
      "stinking-cloud",
      ...prepared.slice(1),
    ]);
    const s = session({ ilse: wizard }, [{ monster: "ogre" }]);
    s.act([], place("ilse", 0, 0), place("ogre", 6, 0));
    s.act([], {
      type: "cast",
      id: "ilse",
      spell: "stinking-cloud",
      area: { point: { x: 7, y: 1 } },
    });
    s.act([2], next);
    expect(s.notes).toContain("Stinking Cloud: Ogre starts its turn in it (Constitution DC 13).");
    expect(s.notes).toContain("Ogre can't take an action or a Bonus Action this turn.");
    expect(s.get("ogre")).toMatchObject({
      conditions: ["poisoned"],
      used: { action: true, bonus_action: true },
    });
    s.act([], next);
    expect(s.get("ogre")?.conditions).toEqual([]);
  });

  it("Sleet Storm: Prone and Concentration lost", () => {
    const s = session({ wren: druid(["sleet-storm"]) }, [{ monster: "druid", side: "enemies" }]);
    s.act([], place("wren", 0, 0), place("druid", 6, 0));
    s.act([], next, {
      type: "cast",
      id: "druid",
      spell: "moonbeam",
      area: { point: { x: 1, y: 6 } },
    });
    s.act([], next, {
      type: "cast",
      id: "wren",
      spell: "sleet-storm",
      area: { point: { x: 6, y: 0 } },
    });
    s.act([2], next);
    expect(s.get("druid")?.conditions).toEqual(["prone"]);
    expect(s.notes).toContain("Druid loses Concentration on Moonbeam (Sleet Storm).");
    expect(s.notes).toContain("Moonbeam ends (Concentration ended).");
  });
});

describe("Conjure Animals and Flaming Sphere", () => {
  it("Conjure Animals: the caster forces the save, on enemies by default; ask mode asks", () => {
    const s = session({ wren: druid(["conjure-animals"]) }, [
      { monster: "goblin-warrior" },
      { monster: "guard", side: "party" },
    ]);
    s.act([], place("wren", 0, 8), place("goblin-warrior", 5, 0), place("guard", 5, 2), {
      type: "cast",
      id: "wren",
      spell: "conjure-animals",
      area: { point: { x: 2, y: 0 } },
    });
    expect(s.encounter().zones[0]).toMatchObject({
      point: { x: 2, y: 0 },
      space: 2,
      optional: true,
    });
    s.act([2, 5, 5, 5], next, next); // the goblin ends its turn within 10 feet of the pack
    expect(s.notes).toContain(
      "Conjure Animals: Goblin Warrior ends its turn in it (Dexterity DC 13).",
    );
    expect(s.get("goblin-warrior")?.defeated).toBe(true);
    s.act([], next); // the guard, an ally: not forced
    expect(s.notes.some((n) => n.startsWith("Conjure Animals: Guard"))).toBe(false);
    s.act([], { type: "set_decisions", id: "wren", mode: "ask" }, next);
    s.act([], next);
    expect(s.encounter().pending).toMatchObject({
      combatant: "wren",
      kind: "zone_force",
      question:
        "Wren: force Guard (ends its turn in it) to make a Dexterity saving throw against Conjure Animals?",
    });
    s.act([], { type: "decide", use: false });
    expect(s.encounter().pending).toBeNull();
  });

  it("Flaming Sphere: rammed into a creature's space, and at the end of a turn within 5 feet", () => {
    const s = session({ wren: druid(["flaming-sphere"]) }, [{ monster: "ogre" }]);
    s.act([], place("wren", 0, 0), place("ogre", 6, 0));
    s.act([], {
      type: "cast",
      id: "wren",
      spell: "flaming-sphere",
      area: { point: { x: 2, y: 0 } },
    });
    s.act([2, 3, 3], { type: "move_zone", zone: "zone-1", point: { x: 6, y: 0 }, onto: "ogre" });
    expect(s.notes).toContain("Flaming Sphere: Ogre is in its way (Dexterity DC 13).");
    expect(s.get("ogre")?.hp).toBe(68 - 6);
    s.act([20, 4, 4], next, next); // the ogre ends its turn next to the sphere
    expect(s.notes).toContain("Flaming Sphere: Ogre ends its turn in it (Dexterity DC 13).");
    expect(s.get("ogre")?.hp).toBe(68 - 6 - 4);
  });
});
