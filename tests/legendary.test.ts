import { describe, expect, it } from "vitest";
import {
  applyEncounterAction,
  type CharacterBuild,
  type CharacterState,
  combatantFromMonster,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  lookup,
  type MonsterDef,
  rollSavingThrow,
  scriptedRng,
} from "../src/index";
import * as svc from "../src/services/builder";
import { apply, autocomplete, catalog, classBuild, fighterBuild } from "./helpers";

// SRD 5.2.1 stat blocks: "Legendary Action Uses: 3 (4 in Lair). Immediately after another
// creature's turn, the dragon can expend a use to take one of the following actions. The dragon
// regains all expended uses at the start of each of its turns." "Legendary Resistance (3/Day, or
// 4/Day in Lair). If the dragon fails a saving throw, it can choose to succeed instead."

const monster = (id: string) => lookup(catalog.monsters, id) as MonsterDef;
const conditions = catalog.conditions;

describe("legendary data", () => {
  it("the Adult Red Dragon's uses, Legendary Resistance and legendary actions", () => {
    const dragon = monster("adult-red-dragon");
    expect(dragon.legendary_uses).toEqual({ uses: 3, in_lair: 4 });
    expect(dragon.legendary_resistance).toEqual({ uses: 3, in_lair: 4 });
    expect(
      dragon.legendary_actions.map((a) => [a.name, a.once_per_round, a.attacks, a.uses]),
    ).toEqual([
      ["Commanding Presence", true, [], null],
      ["Fiery Rays", true, [], null],
      ["Pounce", false, ["Rend"], null],
    ]);
  });

  it("a legendary saving throw effect is only a legendary action", () => {
    const lich = combatantFromMonster(monster("lich"));
    expect(lich.save_actions.map((a) => a.name)).not.toContain("Disrupt Life");
    expect(lich.legendary_actions.find((a) => a.name === "Disrupt Life")?.save).toMatchObject({
      ability: "con",
      dc: 20,
    });
  });
});

describe("Legendary Resistance", () => {
  it("turns a failed save into a success while uses are left", () => {
    const dragon = combatantFromMonster(monster("adult-red-dragon"), {}, { conditions });
    expect(dragon.legendary_resistance).toBe(3);
    const save = rollSavingThrow(dragon, "wis", 30, { rng: scriptedRng([2]) });
    expect(save).toMatchObject({ success: true, legendary_resistance: true });
    const spent = combatantFromMonster(monster("adult-red-dragon"), {
      legendary_resistance_used: 3,
    });
    expect(rollSavingThrow(spent, "wis", 30, { rng: scriptedRng([2]) }).success).toBe(false);
  });

  it("works on automatic failures too, and can be left to the GM", () => {
    const paralyzed = combatantFromMonster(
      monster("adult-red-dragon"),
      { conditions: ["paralyzed"] },
      { conditions },
    );
    const save = rollSavingThrow(paralyzed, "dex", 30, { rng: scriptedRng([]) });
    expect(save).toMatchObject({
      success: true,
      automatic_failure: "Paralyzed",
      legendary_resistance: true,
    });
    const manual = combatantFromMonster(monster("adult-red-dragon"), {
      auto_legendary_resistance: false,
    });
    expect(manual.legendary_resistance).toBe(0);
  });

  it("the lair adds uses", () => {
    const inLair = combatantFromMonster(monster("adult-red-dragon"), { in_lair: true });
    expect(inLair.legendary_resistance).toBe(4);
  });
});

describe("legendary actions in an encounter", () => {
  type Chars = Record<string, CharacterBuild>;
  /** An encounter with characters whose states follow along; dice are scripted. */
  function session(builds: Chars) {
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
    const get = (id: string) => encounter.combatants.find((c) => c.id === id);
    return { act, notes, get, states };
  }
  const next = { type: "next_turn" } as const;
  /** Brakka (Initiative 20), then the monsters (10, 9, …). */
  function fight(...monsters: EncounterAction[]) {
    const s = session({ brakka: fighterBuild() });
    s.act([], { type: "add_character", character: "brakka" }, ...monsters);
    const ids = ["brakka", ...monsters.map((m) => (m as { monster: string }).monster)];
    s.act(
      [],
      ...ids.map((id, i) => ({ type: "set_initiative", id, value: i ? 11 - i : 20 }) as const),
      { type: "start" },
    );
    return s;
  }
  const pounce = {
    type: "legendary",
    id: "adult-red-dragon",
    action: "Pounce",
    target: "brakka",
  } as const;

  it("after another creature's turn, not on its own", () => {
    const s = fight({ type: "add_monster", monster: "adult-red-dragon" });
    s.act([2], pounce); // Brakka's turn: a Rend attack, 2 + 14 = 16 misses AC 17
    expect(s.notes).toContain(
      "Adult Red Dragon takes a legendary action: Pounce (2 left this round).",
    );
    expect(s.notes).toContain("Adult Red Dragon misses Brakka with Rend (16 vs AC 17).");
    s.act([], next); // the dragon's turn
    expect(() => s.act([], pounce)).toThrow("not on its own");
  });

  it("3 uses per round (4 in its lair), once-per-round actions, back at its turn", () => {
    const s = fight({ type: "add_monster", monster: "adult-red-dragon" });
    s.act([2, 2, 2], pounce, pounce, pounce);
    expect(() => s.act([], pounce)).toThrow("no legendary action uses left");
    s.act([], next); // the dragon's turn: uses come back
    expect(s.get("adult-red-dragon")?.legendary_used).toBe(0);
    s.act([], next); // Brakka's turn again
    const rays = { type: "legendary", id: "adult-red-dragon", action: "Fiery Rays" } as const;
    s.act([], rays);
    expect(s.notes.at(-1)).toBe("Fiery Rays: its effect is in the stat block's text.");
    expect(() => s.act([], rays)).toThrow(
      "can't take Fiery Rays again until the start of its next turn",
    );
    const lair = fight({ type: "add_monster", monster: "adult-red-dragon", in_lair: true });
    lair.act([2, 2, 2, 2], pounce, pounce, pounce, pounce);
    expect(() => lair.act([], pounce)).toThrow("no legendary action uses left");
  });

  it("a choice of attacks, another action it uses, and its own saving throw effect", () => {
    const s = fight(
      { type: "add_monster", monster: "mummy-lord" },
      { type: "add_monster", monster: "lich" },
      { type: "add_monster", monster: "ogre" },
    );
    const strike = {
      type: "legendary",
      id: "mummy-lord",
      action: "Necrotic Strike",
      target: "brakka",
    } as const;
    expect(() => s.act([], strike)).toThrow(
      "Necrotic Strike: choose the attack (Rotting Fist or Channel Negative Energy)",
    );
    s.act([2], { ...strike, attack: "Rotting Fist" });
    expect(s.notes.at(-1)).toMatch(/^Mummy Lord misses Brakka with Rotting Fist/);
    // Glare uses Dreadful Glare, a Wisdom save (its 6d6 is rolled once for all targets).
    s.act([20, 1, 1, 1, 1, 1, 1], {
      type: "legendary",
      id: "mummy-lord",
      action: "Glare",
      targets: ["ogre"],
    });
    expect(s.notes.at(-1)).toMatch(/^Ogre: succeeds/);
    // Disrupt Life: the lich's own Constitution save, 9d6 Necrotic.
    s.act([1, ...Array(9).fill(2)], {
      type: "legendary",
      id: "lich",
      action: "Disrupt Life",
      targets: ["ogre"],
    });
    expect(s.get("ogre")?.hp).toBe(68 - 18);
  });

  it("Legendary Resistance is spent and counted in the encounter", () => {
    let ilse = autocomplete(classBuild("wizard", { name: "Ilse" }));
    const book = (ilse.choices["class:wizard#spellbook"] ?? []).filter((x) => x !== "sleep");
    ilse = apply(ilse, svc.setChoice, "class:wizard#spellbook", ["sleep", ...book.slice(0, 5)]);
    ilse = autocomplete(ilse);
    const prepared = (ilse.choices["class:wizard#prepared"] ?? []).filter((x) => x !== "sleep");
    ilse = apply(ilse, svc.setChoice, "class:wizard#prepared", ["sleep", ...prepared.slice(0, 3)]);
    const s = session({ ilse });
    s.act(
      [],
      { type: "add_character", character: "ilse" },
      { type: "add_monster", monster: "adult-red-dragon" },
      { type: "set_initiative", id: "ilse", value: 20 },
      { type: "set_initiative", id: "adult-red-dragon", value: 10 },
      { type: "start" },
    );
    s.act([1], { type: "cast", id: "ilse", spell: "sleep", targets: ["adult-red-dragon"] });
    expect(s.notes).toContain(
      "Adult Red Dragon uses Legendary Resistance to succeed instead (2 left today).",
    );
    expect(s.get("adult-red-dragon")).toMatchObject({
      legendary_resistance_used: 1,
      conditions: [],
    });
  });
});
