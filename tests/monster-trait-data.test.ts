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
  resolve,
  type SpellCastResult,
  scriptedRng,
} from "../src/index";
import * as svc from "../src/services/builder";
import { autocomplete, catalog, classBuild, fighterBuild } from "./helpers";

// SRD 5.2.1 monster traits read as data: Bloodied Fury, Agile, Lightning Absorption, Swarm,
// Magic Resistance ("Advantage on saving throws against spells and other magical effects") and
// Pack Tactics ("Advantage on an attack roll against a
// creature if at least one of the …'s allies is within 5 feet of the creature and the ally doesn't
// have the Incapacitated condition").

function session(builds: Record<string, CharacterBuild>, monsters: string[]) {
  const states: Record<string, CharacterState> = Object.fromEntries(
    Object.entries(builds).map(([k, b]) => [k, createState(b, catalog)]),
  );
  let e: Encounter = createEncounter();
  let last: ReturnType<typeof applyEncounterAction> | null = null;
  const act = (rolls: number[], ...actions: EncounterAction[]) => {
    for (const action of actions) {
      last = applyEncounterAction(e, action, {
        catalog,
        characters: Object.fromEntries(
          Object.entries(builds).map(([k, build]) => [
            k,
            { build, state: states[k] as CharacterState },
          ]),
        ),
        rng: scriptedRng(rolls),
      });
      e = last.encounter;
      Object.assign(states, last.states);
    }
  };
  const ids = monsters.map((m, i) => (monsters.indexOf(m) === i ? m : `${m}-${i + 1}`));
  act(
    [],
    ...Object.keys(builds).map((character) => ({ type: "add_character", character }) as const),
    ...monsters.map((monster) => ({ type: "add_monster", monster, side: "enemies" }) as const),
    ...ids.map((id, i) => ({ type: "set_initiative", id, value: 20 - i }) as const),
    ...Object.keys(builds).map((id, i) => ({ type: "set_initiative", id, value: 5 - i }) as const),
    { type: "start" },
  );
  const notes: string[] = [];
  return {
    act: (rolls: number[], ...actions: EncounterAction[]) => {
      act(rolls, ...actions);
      notes.push(...(last?.notes ?? []));
    },
    result: () => last?.result,
    notes: () => notes,
    get: (id: string) => e.combatants.find((c) => c.id === id),
  };
}

describe("Magic Resistance", () => {
  it("an Imp saves against Burning Hands with Advantage", () => {
    let ilse = autocomplete(classBuild("wizard", { name: "Ilse" }));
    const res = resolve(ilse, catalog);
    const prepared = res.choices.find((c) => c.key === "class:wizard#prepared");
    if (!prepared) throw new Error("no prepared spells");
    const others = res.selected(prepared).filter((x) => x !== "burning-hands");
    ilse = autocomplete(
      svc.setChoice(ilse, catalog, prepared.key, [
        "burning-hands",
        ...others.slice(0, res.required(prepared) - 1),
      ]).build,
    );
    const s = session({ ilse }, ["imp"]);
    s.act([], { type: "next_turn" }); // Ilse's turn
    s.act([2, 15, 3, 3, 3], { type: "cast", id: "ilse", spell: "burning-hands", targets: ["imp"] });
    const save = (s.result() as SpellCastResult).targets[0]?.save;
    expect(save).toMatchObject({
      roll: { mode: "advantage" },
      reasons: ["Advantage: Imp's Magic Resistance"],
    });
  });
});

describe("Pack Tactics", () => {
  const bite: EncounterAction = { type: "attack", id: "wolf", target: "brakka", attack: "Bite" };
  it("a wolf has Advantage when another wolf is next to its target", () => {
    const s = session({ brakka: fighterBuild() }, ["wolf", "wolf"]);
    s.act(
      [],
      { type: "place", id: "brakka", x: 5, y: 5 },
      { type: "place", id: "wolf", x: 4, y: 5 },
      { type: "place", id: "wolf-2", x: 6, y: 5 },
    );
    s.act([10, 12, 3, 3], bite);
    expect((s.result() as AttackResult).roll.mode).toBe("advantage");
    expect((s.result() as AttackResult).reasons).toContain("Advantage: Wolf's Pack Tactics");
  });

  it("not when the other wolf is away", () => {
    const s = session({ brakka: fighterBuild() }, ["wolf", "wolf"]);
    s.act(
      [],
      { type: "place", id: "brakka", x: 5, y: 5 },
      { type: "place", id: "wolf", x: 4, y: 5 },
      { type: "place", id: "wolf-2", x: 12, y: 5 },
    );
    s.act([10, 3, 3], bite);
    expect((s.result() as AttackResult).roll.mode).toBe("normal");
  });
});

describe("more traits", () => {
  const brakka = () => fighterBuild();
  it("Bloodied Fury: a Bloodied boar has Advantage", () => {
    const s = session({ brakka: brakka() }, ["boar"]);
    s.act([], {
      type: "effects",
      id: "boar",
      actions: [{ type: "damage", amount: 7, damage_type: "slashing" }],
    });
    s.act([10, 12, 3], { type: "attack", id: "boar", target: "brakka", attack: "Gore" });
    expect((s.result() as AttackResult).reasons).toContain("Advantage: Boar's Bloodied Fury");
  });

  it("Agile: leaving a deer's reach provokes no Opportunity Attack", () => {
    const s = session({ brakka: brakka() }, ["deer"]);
    expect(() =>
      s.act([10, 3], {
        type: "attack",
        id: "brakka",
        target: "deer",
        attack: "Greatsword",
        opportunity: true,
      }),
    ).toThrow("Deer doesn't provoke Opportunity Attacks (its traits)");
  });

  it("Lightning Absorption: lightning heals a flesh golem instead", () => {
    const s = session({ brakka: brakka() }, ["flesh-golem"]);
    s.act([], {
      type: "effects",
      id: "flesh-golem",
      actions: [{ type: "damage", amount: 20, damage_type: "slashing" }],
    });
    s.act([], {
      type: "effects",
      id: "flesh-golem",
      actions: [{ type: "damage", amount: 12, damage_type: "lightning" }],
    });
    expect(s.notes()).toContain(
      "Flesh Golem absorbs the lightning damage: it regains 12 Hit Points.",
    );
    expect(s.get("flesh-golem")?.hp).toBe(127 - 8);
  });

  it("Swarm: no healing and no Temporary Hit Points", () => {
    const s = session({ brakka: brakka() }, ["swarm-of-rats"]);
    s.act([], {
      type: "effects",
      id: "swarm-of-rats",
      actions: [{ type: "damage", amount: 5, damage_type: "fire" }],
    });
    s.act([], { type: "effects", id: "swarm-of-rats", actions: [{ type: "heal", amount: 5 }] });
    expect(s.get("swarm-of-rats")?.hp).toBe(9);
  });
});
