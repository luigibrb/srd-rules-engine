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
  type EncounterResult,
  type SpellCastResult,
  scriptedRng,
} from "../src/index";
import * as svc from "../src/services/builder";
import { apply, autocomplete, catalog, classBuild, fighterBuild } from "./helpers";

// Darts, follow-up saves, hit riders and timed conditions of spells in an encounter (SRD 5.2.1
// "Spells"): Magic Missile, Ice Knife, Guiding Bolt, Ray of Sickness.

/** Ilse, a level 1 wizard: spell attack +4, save DC 12. */
function wizard(): CharacterBuild {
  const spells = ["magic-missile", "ice-knife", "ray-of-sickness", "sleep"];
  let b = autocomplete(classBuild("wizard", { name: "Ilse" }));
  b = apply(b, svc.setChoice, "class:wizard#spellbook", [...spells, "shield", "burning-hands"]);
  b = autocomplete(b);
  b = apply(b, svc.setChoice, "class:wizard#prepared", spells);
  return autocomplete(b);
}

/** Mira, a level 1 cleric with Guiding Bolt: spell attack +4. */
function cleric(): CharacterBuild {
  let b = autocomplete(classBuild("cleric", { name: "Mira" }));
  const others = (b.choices["class:cleric#prepared"] ?? []).filter((x) => x !== "guiding-bolt");
  b = apply(b, svc.setChoice, "class:cleric#prepared", ["guiding-bolt", ...others.slice(1)]);
  return autocomplete(b);
}

/** Characters and monsters, in Initiative order as listed (20, 19, …), fight started. */
function session(
  builds: Record<string, CharacterBuild>,
  monsters: { monster: string; decisions?: "ask" | "auto" }[],
) {
  const states: Record<string, CharacterState> = Object.fromEntries(
    Object.entries(builds).map(([k, b]) => [k, createState(b, catalog)]),
  );
  let encounter: Encounter = createEncounter();
  const notes: string[] = [];
  let last: EncounterResult | null = null;
  const act = (rolls: number[], ...actions: EncounterAction[]) => {
    const rng = scriptedRng(rolls);
    for (const action of actions) {
      const characters = Object.fromEntries(
        Object.entries(builds).map(([k, build]) => [
          k,
          { build, state: states[k] as CharacterState },
        ]),
      );
      last = applyEncounterAction(encounter, action, { catalog, characters, rng });
      encounter = last.encounter;
      Object.assign(states, last.states);
      notes.push(...last.notes);
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
  return {
    act,
    notes,
    get,
    states,
    encounter: () => encounter,
    result: () => last?.result,
  };
}
const next = { type: "next_turn" } as const;
const goblins = [{ monster: "goblin-warrior" }, { monster: "goblin-warrior" }];
const cast = (id: string, spell: string, targets: string[], more = {}): EncounterAction => ({
  type: "cast",
  id,
  spell,
  targets,
  ...more,
});

describe("Guiding Bolt", () => {
  const bolted = () => {
    const s = session({ mira: cleric(), brakka: fighterBuild() }, goblins);
    s.act([15, 1, 1, 1, 1], cast("mira", "guiding-bolt", ["goblin-warrior"])); // 19 vs AC 15
    return s;
  };

  it("a hit gives the next attack roll against the target Advantage, whoever makes it", () => {
    const s = bolted();
    expect(s.notes.at(-1)).toBe(
      "Guiding Bolt: the next attack roll against Goblin Warrior has Advantage.",
    );
    expect(s.encounter().marks).toEqual([
      {
        kind: "advantage_against",
        label: "Guiding Bolt",
        by: "mira",
        on: "goblin-warrior",
        ends: { at: "end", of: "mira", count: 1, skip_current: true },
        damage: null,
      },
    ]);
    s.act([5, 16, 1, 1], next, {
      type: "attack",
      id: "brakka",
      target: "goblin-warrior",
      attack: "Greatsword",
    });
    expect(s.result()).toMatchObject({ hit: true, roll: { mode: "advantage" } });
    expect((s.result() as AttackResult).reasons).toEqual([
      "Advantage: Guiding Bolt (Mira's hit on Goblin Warrior)",
    ]);
    expect(s.encounter().marks).toEqual([]);
  });

  it("it ends at the end of the caster's next turn", () => {
    const s = bolted();
    s.act([], next, next, next, next); // Brakka, the goblins, Mira again
    expect(s.encounter().marks).toHaveLength(1);
    s.act([], next);
    expect(s.encounter().marks).toEqual([]);
  });

  it("a spell attack roll uses it, once for several rays", () => {
    const s = session({ mira: cleric(), ilse: wizard() }, goblins);
    s.act([15, 1, 1, 1, 1], cast("mira", "guiding-bolt", ["goblin-warrior"]), next);
    s.act([2, 16, 1, 1], cast("ilse", "ray-of-sickness", ["goblin-warrior"]));
    const r = s.result() as SpellCastResult;
    expect(r.targets[0]?.attack).toMatchObject({
      hit: true,
      reasons: ["Advantage: Guiding Bolt (Mira's hit on Goblin Warrior)"],
    });
    expect(s.encounter().marks).toEqual([]);
  });
});

describe("Help, Vex and Sap on spell attack rolls", () => {
  it("Help gives an ally's spell attack Advantage", () => {
    const s = session({ brakka: fighterBuild(), ilse: wizard() }, goblins);
    s.act([], { type: "help", id: "brakka", target: "goblin-warrior" }, next);
    s.act([2, 16, 1, 1], cast("ilse", "ray-of-sickness", ["goblin-warrior"]));
    expect((s.result() as SpellCastResult).targets[0]?.attack?.reasons).toEqual([
      "Advantage: Brakka Helps against Goblin Warrior",
    ]);
    expect(s.encounter().helps).toEqual([]);
  });
});

describe("Ray of Sickness", () => {
  it("Poisoned until the end of the caster's next turn", () => {
    const s = session({ ilse: wizard() }, goblins);
    s.act([15, 1, 1], cast("ilse", "ray-of-sickness", ["goblin-warrior"]));
    expect(s.get("goblin-warrior")?.conditions).toEqual(["poisoned"]);
    expect(s.encounter().effects).toEqual([
      expect.objectContaining({
        condition: "poisoned",
        label: "Ray of Sickness",
        concentration: false,
        ends: { at: "end", of: "ilse", count: 1, skip_current: true },
      }),
    ]);
    s.act([], next, next, next); // the goblins, then Ilse's next turn
    expect(s.get("goblin-warrior")?.conditions).toEqual(["poisoned"]);
    s.act([], next);
    expect(s.get("goblin-warrior")?.conditions).toEqual([]);
    expect(s.notes).toContain(
      "Poisoned on Goblin Warrior ends (Ray of Sickness: its duration is over).",
    );
  });
});

describe("Magic Missile", () => {
  it("darts split among targets, each its own damage", () => {
    const s = session({ ilse: wizard() }, goblins);
    s.act(
      [3],
      cast("ilse", "magic-missile", ["goblin-warrior", "goblin-warrior", "goblin-warrior-2"]),
    );
    expect(s.get("goblin-warrior")?.hp).toBe(2);
    expect(s.get("goblin-warrior-2")?.hp).toBe(6);
    expect(s.notes.filter((n) => n.endsWith(": 4 force."))).toHaveLength(3);
  });
});

describe("Ice Knife", () => {
  it("with positions, the creatures within 5 feet of the target save too", () => {
    const s = session({ ilse: wizard() }, goblins);
    s.act(
      [],
      { type: "place", id: "ilse", x: 0, y: 0 },
      { type: "place", id: "goblin-warrior", x: 4, y: 0 },
      { type: "place", id: "goblin-warrior-2", x: 5, y: 1 },
    );
    s.act([15, 2, 2, 2, 3, 3], cast("ilse", "ice-knife", ["goblin-warrior"]));
    expect(s.notes).toContain("Ice Knife's saving throw (Dexterity DC 12).");
    expect(s.get("goblin-warrior")?.hp).toBe(10 - 2 - 6);
    expect(s.get("goblin-warrior-2")?.hp).toBe(10 - 6);
  });

  it("without positions, `nearby` lists them", () => {
    const s = session({ ilse: wizard() }, goblins);
    s.act(
      [2, 2, 2, 3, 3],
      cast("ilse", "ice-knife", ["goblin-warrior"], { nearby: ["goblin-warrior-2"] }),
    );
    expect(s.get("goblin-warrior")?.hp).toBe(4); // missed, then 6 Cold
    expect(s.get("goblin-warrior-2")?.hp).toBe(4);
    expect(() =>
      s.act(
        [],
        next,
        next,
        next,
        cast("ilse", "ray-of-sickness", ["goblin-warrior"], { nearby: ["goblin-warrior-2"] }),
      ),
    ).toThrow("Ray of Sickness has no saving throw for creatures near its target");
  });

  it("Legendary Resistance on its saving throw is asked, then replayed", () => {
    const s = session({}, [
      { monster: "adult-silver-dragon" },
      { monster: "adult-blue-dragon", decisions: "ask" },
    ]);
    s.act([10, 5, 1], cast("adult-silver-dragon", "ice-knife", ["adult-blue-dragon"]));
    expect(s.encounter().pending).toMatchObject({
      combatant: "adult-blue-dragon",
      kind: "legendary_resistance",
    });
    s.act([3, 3], { type: "decide", use: true });
    expect(s.get("adult-blue-dragon")).toMatchObject({ hp: 212 - 5, legendary_resistance_used: 1 });
  });
});
