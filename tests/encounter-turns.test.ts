import { describe, expect, it } from "vitest";
import {
  applyEncounterAction,
  type CharacterBuild,
  type CharacterState,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  type EncounterResult,
} from "../src/index";
import * as svc from "../src/services/builder";
import { apply, autocomplete, catalog, classBuild, fighterBuild } from "./helpers";

/**
 * An encounter with characters whose states are kept up to date. `act(rolls, ...actions)` runs
 * actions with exactly those dice (scriptedRng throws if more are rolled).
 */
function session(builds: Record<string, CharacterBuild>) {
  const states: Record<string, CharacterState> = Object.fromEntries(
    Object.entries(builds).map(([key, build]) => [key, createState(build, catalog)]),
  );
  let encounter: Encounter = createEncounter();
  const notes: string[] = [];
  let last: EncounterResult | null = null;
  const act = (rolls: number[], ...actions: EncounterAction[]) => {
    let i = 0;
    const rng = {
      int: () => {
        if (i >= rolls.length) throw new Error(`more dice rolled than the ${rolls.length} given`);
        return rolls[i++] as number;
      },
    };
    for (const action of actions) {
      const characters = Object.fromEntries(
        Object.entries(builds).map(([key, build]) => [
          key,
          { build, state: states[key] as CharacterState },
        ]),
      );
      last = applyEncounterAction(encounter, action, { catalog, characters, rng });
      encounter = last.encounter;
      Object.assign(states, last.states);
      notes.push(...last.notes);
    }
    if (i !== rolls.length) throw new Error(`${rolls.length - i} dice given but not rolled`);
    return last as EncounterResult;
  };
  const combatant = (id: string) => encounter.combatants.find((c) => c.id === id);
  return {
    act,
    states,
    notes,
    combatant,
    get encounter() {
      return encounter;
    },
  };
}

/** Add combatants in Initiative order (20, 19, …) and start. */
function begin(s: ReturnType<typeof session>, ...adds: EncounterAction[]) {
  s.act([], ...adds);
  const ids = s.encounter.combatants.map((c) => c.id);
  s.act([], ...ids.map((id, i) => ({ type: "set_initiative", id, value: 20 - i }) as const), {
    type: "start",
  });
}
const next = { type: "next_turn" } as const;

describe("timed effects", () => {
  const brakkaAndGoblin = () => {
    const s = session({ brakka: fighterBuild() });
    begin(
      s,
      { type: "add_character", character: "brakka" },
      { type: "add_monster", monster: "goblin-warrior" },
    );
    return s;
  };

  it("'until the end of its next turn' ends when the target's turn ends", () => {
    const s = brakkaAndGoblin();
    s.act([], {
      type: "effects",
      id: "goblin-warrior",
      actions: [{ type: "add_condition", condition: "prone" }],
      source: "brakka",
      until: { at: "end", of: "goblin-warrior" },
      label: "Shove",
    });
    expect(s.combatant("goblin-warrior")?.conditions).toEqual(["prone"]);
    s.act([], next); // the goblin's turn starts: still Prone
    expect(s.combatant("goblin-warrior")?.conditions).toEqual(["prone"]);
    s.act([], next); // …and ends
    expect(s.combatant("goblin-warrior")?.conditions).toEqual([]);
    expect(s.notes).toContain("Prone on Goblin Warrior ends (Shove: its duration is over).");
    expect(s.encounter.effects).toEqual([]);
  });

  it("'until the end of your next turn', set on your turn, lasts through the next one", () => {
    const s = brakkaAndGoblin();
    s.act([], {
      type: "effects",
      id: "goblin-warrior",
      actions: [{ type: "add_condition", condition: "frightened" }],
      source: "brakka",
      until: { at: "end" },
    });
    s.act([], next, next); // Brakka's turn ends (not counted), the goblin's; Brakka's next starts
    expect(s.combatant("goblin-warrior")?.conditions).toEqual(["frightened"]);
    s.act([], next); // Brakka's next turn ends
    expect(s.combatant("goblin-warrior")?.conditions).toEqual([]);
  });

  it("N rounds end at the start of the source's turn", () => {
    const s = brakkaAndGoblin();
    s.act([], {
      type: "effects",
      id: "goblin-warrior",
      actions: [{ type: "add_condition", condition: "blinded" }],
      source: "brakka",
      rounds: 2,
    });
    s.act([], next, next); // round 2 starts: 1 left
    expect(s.combatant("goblin-warrior")?.conditions).toEqual(["blinded"]);
    s.act([], next, next); // round 3 starts
    expect(s.combatant("goblin-warrior")?.conditions).toEqual([]);
  });

  it("an effect can be ended early", () => {
    const s = brakkaAndGoblin();
    s.act([], {
      type: "effects",
      id: "goblin-warrior",
      actions: [{ type: "add_condition", condition: "restrained" }],
      source: "brakka",
      rounds: 10,
    });
    s.act([], { type: "end_effect", effect: "effect-1" });
    expect(s.combatant("goblin-warrior")?.conditions).toEqual([]);
  });
});

describe("Concentration", () => {
  // A wizard with Sleep prepared.
  let ilse = classBuild("wizard", { name: "Ilse" });
  ilse = autocomplete(ilse);
  const book = (ilse.choices["class:wizard#spellbook"] ?? []).filter((x) => x !== "sleep");
  ilse = apply(ilse, svc.setChoice, "class:wizard#spellbook", ["sleep", ...book.slice(0, 5)]);
  ilse = autocomplete(ilse);
  const prepared = (ilse.choices["class:wizard#prepared"] ?? []).filter((x) => x !== "sleep");
  ilse = apply(ilse, svc.setChoice, "class:wizard#prepared", ["sleep", ...prepared.slice(0, 3)]);

  const sleepOnGoblin = () => {
    const s = session({ ilse });
    begin(
      s,
      { type: "add_character", character: "ilse" },
      { type: "add_monster", monster: "goblin-warrior" },
    );
    s.act([2], { type: "cast", id: "ilse", spell: "sleep", targets: ["goblin-warrior"] });
    return s;
  };

  it("a Concentration spell's condition lasts while the caster concentrates", () => {
    const s = sleepOnGoblin();
    expect(s.states.ilse?.concentration).toBe("Sleep");
    expect(s.states.ilse?.spell_slots_spent).toEqual([1]);
    expect(s.combatant("ilse")?.used.action).toBe(true);
    expect(s.encounter.effects).toEqual([
      expect.objectContaining({
        target: "goblin-warrior",
        condition: "incapacitated",
        label: "Sleep",
        concentration: true,
        ends: expect.objectContaining({ at: "start", of: "ilse", count: 10 }),
      }),
    ]);
    s.act([], next);
    expect(() => s.act([], { type: "use", id: "goblin-warrior", what: "action" })).toThrow(
      "Goblin Warrior is Incapacitated",
    );
  });

  it("damage calls for a Concentration save; failing it ends the spell's effects", () => {
    const s = sleepOnGoblin();
    s.act([15], { type: "effects", id: "ilse", actions: [{ type: "damage", amount: 3 }] });
    expect(s.notes.at(-1)).toMatch(/^Ilse keeps Concentration on Sleep \(\d+ vs DC 10\)\.$/);
    s.act([1], { type: "effects", id: "ilse", actions: [{ type: "damage", amount: 1 }] });
    expect(s.states.ilse?.concentration).toBeNull();
    expect(s.combatant("goblin-warrior")?.conditions).toEqual([]);
    expect(s.notes).toContain("Incapacitated on Goblin Warrior ends (Sleep: Concentration ended).");
  });

  it("a caster can only cast the spells it has prepared", () => {
    const s = sleepOnGoblin();
    expect(() => s.act([], { type: "cast", id: "ilse", spell: "fireball", targets: [] })).toThrow(
      "Ilse can't cast Fireball",
    );
  });
});

describe("attacks in turns", () => {
  it("the Attack action: one attack at level 1, more with Extra Attack or Multiattack", () => {
    const s = session({ brakka: fighterBuild() });
    begin(
      s,
      { type: "add_character", character: "brakka" },
      { type: "add_monster", monster: "ogre" },
      { type: "add_monster", monster: "adult-red-dragon" },
    );
    const hit = s.act([15, 3, 4], {
      type: "attack",
      id: "brakka",
      target: "ogre",
      attack: "Greatsword",
    });
    expect(hit.result).toMatchObject({ hit: true, instances: [{ amount: 10, type: "slashing" }] });
    expect(s.combatant("ogre")?.hp).toBe(58);
    expect(() =>
      s.act([], { type: "attack", id: "brakka", target: "ogre", attack: "Greatsword" }),
    ).toThrow("Brakka has no attacks left this turn");
    s.act([], next, next); // the dragon's turn: Multiattack, three Rend attacks
    const rend = {
      type: "attack",
      id: "adult-red-dragon",
      target: "brakka",
      attack: "Rend",
    } as const;
    s.act([2, 2, 2], rend, rend, rend); // 2 + 14 = 16: three misses against AC 17
    expect(() => s.act([], rend)).toThrow("Adult Red Dragon has no attacks left this turn");
  });

  it("an Opportunity Attack uses the reaction, once until its next turn", () => {
    const s = session({ brakka: fighterBuild() });
    begin(
      s,
      { type: "add_character", character: "brakka" },
      { type: "add_monster", monster: "goblin-warrior" },
    );
    const opportunity = {
      type: "attack",
      id: "goblin-warrior",
      target: "brakka",
      attack: "Scimitar",
      reaction: true,
    } as const;
    s.act([2], opportunity); // on Brakka's turn: a miss
    expect(() => s.act([], opportunity)).toThrow("Goblin Warrior has already used its reaction");
  });
});

describe("once-per-turn riders", () => {
  it("Sneak Attack: once per turn, again on another creature's turn", () => {
    const pip = autocomplete(classBuild("rogue", { name: "Pip" }));
    const s = session({ pip });
    begin(s, { type: "add_character", character: "pip" }, { type: "add_monster", monster: "ogre" });
    const sneak: Extract<EncounterAction, { type: "attack" }> = {
      type: "attack",
      id: "pip",
      target: "ogre",
      attack: "Dagger",
      mode: "advantage",
      riders: [{ rider: "sneak-attack" }],
    };
    const first = s.act([18, 3, 2, 5], sneak);
    expect(first.result).toMatchObject({ hit: true, riders: ["Sneak Attack"] });
    expect(() => s.act([], { ...sneak, reaction: true })).toThrow(
      "Pip has already used sneak-attack this turn",
    );
    s.act([], next); // the ogre's turn: a new turn
    const again = s.act([18, 3, 2, 5], { ...sneak, reaction: true });
    expect(again.result).toMatchObject({ riders: ["Sneak Attack"] });
  });
});

describe("recharge", () => {
  it("a breath weapon is expended, then recharges on the d6 at the start of the turn", () => {
    const s = session({});
    begin(
      s,
      { type: "add_monster", monster: "adult-red-dragon" },
      { type: "add_monster", monster: "ogre" },
    );
    const breath: EncounterAction = {
      type: "save_action",
      id: "adult-red-dragon",
      ability: "Fire Breath",
      targets: ["ogre"],
    };
    s.act([1, ...Array(17).fill(1)], breath); // the ogre fails: 17 Fire damage
    expect(s.combatant("ogre")?.hp).toBe(51);
    expect(s.combatant("adult-red-dragon")?.expended).toEqual(["Fire Breath"]);
    s.act([4], next, next); // the dragon's turn: a 4, no recharge
    expect(s.notes).toContain("Adult Red Dragon's Fire Breath doesn't recharge (4).");
    expect(() => s.act([], breath)).toThrow("Adult Red Dragon's Fire Breath hasn't recharged");
    s.act([6], next, next);
    expect(s.combatant("adult-red-dragon")?.expended).toEqual([]);
  });
});

describe("Rage lasts while extended", () => {
  const ulla = autocomplete(classBuild("barbarian", { name: "Ulla" }));
  const raging = () => {
    const s = session({ ulla });
    begin(
      s,
      { type: "add_character", character: "ulla" },
      { type: "add_monster", monster: "ogre" },
    );
    s.act([], {
      type: "effects",
      id: "ulla",
      actions: [{ type: "activate", key: "barbarian:rage" }],
    });
    s.act([], next, next); // the turn it started doesn't count; round 2, Ulla's turn
    return s;
  };

  it("ends at the end of a turn without an attack, a save forced or a Bonus Action", () => {
    const s = raging();
    expect(s.states.ulla?.active).toEqual(["barbarian:rage"]);
    s.act([], next);
    expect(s.states.ulla?.active).toEqual([]);
    expect(s.notes).toContain("Rage ends: it wasn't extended this turn.");
  });

  it("an attack roll extends it", () => {
    const s = raging();
    s.act([15, 6], { type: "attack", id: "ulla", target: "ogre", attack: "Greataxe" });
    s.act([], next);
    expect(s.states.ulla?.active).toEqual(["barbarian:rage"]);
  });
});
