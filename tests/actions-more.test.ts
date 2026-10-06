import { describe, expect, it } from "vitest";
import {
  type AttackResult,
  applyEncounterAction,
  type CharacterBuild,
  type CharacterState,
  type CheckResult,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  scriptedRng,
} from "../src/index";
import { autocomplete, catalog, classBuild, fighterBuild } from "./helpers";

// SRD 5.2.1 "Hide", "Search", "Ready", "Study", "Influence", "Utilize" [Action].

function session(
  builds: Record<string, CharacterBuild>,
  monsters: { monster: string; at?: [number, number] }[],
  at: Record<string, [number, number]> = {},
) {
  const states: Record<string, CharacterState> = Object.fromEntries(
    Object.entries(builds).map(([k, b]) => [k, createState(b, catalog)]),
  );
  let encounter: Encounter = createEncounter();
  const notes: string[] = [];
  let result: unknown = null;
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
      result = r.result;
    }
  };
  const keys = Object.keys(builds);
  const ids = [...keys, ...monsters.map((m) => m.monster)];
  act(
    [],
    ...keys.map((character) => ({ type: "add_character", character, side: "party" }) as const),
    ...monsters.map((m) => ({ type: "add_monster", monster: m.monster, side: "enemies" }) as const),
    ...keys.flatMap((id) =>
      at[id] ? [{ type: "place", id, x: at[id][0], y: at[id][1] } as const] : [],
    ),
    ...monsters.flatMap((m) =>
      m.at ? [{ type: "place", id: m.monster, x: m.at[0], y: m.at[1] } as const] : [],
    ),
    ...ids.map((id, i) => ({ type: "set_initiative", id, value: 20 - i }) as const),
    { type: "start" },
  );
  const get = (id: string) => encounter.combatants.find((c) => c.id === id);
  return { act, notes, get, states, encounter: () => encounter, result: () => result };
}
const next = { type: "next_turn" } as const;

describe("Hide and Search", () => {
  it("a DC 15 Stealth check: hidden and Invisible, found by Perception, ended by an attack", () => {
    const s = session({ brakka: fighterBuild() }, [{ monster: "goblin-warrior" }]);
    s.act([3], { type: "hide", id: "brakka" });
    expect(s.notes.at(-1)).toMatch(/Stealth check: \d+ vs DC 15: failure/);
    expect(s.get("brakka")?.hidden).toBeNull();
    s.act([], next, next);
    s.act([16], { type: "hide", id: "brakka" });
    const total = (s.result() as CheckResult).total;
    expect(s.get("brakka")?.hidden).toBe(total);
    expect(s.states.brakka?.conditions).toEqual(["invisible"]);
    expect(s.notes).toContain(`Brakka is hidden (Invisible; Perception DC ${total} to find it).`);
    // The goblin searches and misses it, then attacks with Disadvantage (it can't see Brakka).
    s.act([1], next, { type: "search", id: "goblin-warrior" });
    expect(s.notes.at(-1)).toBe("Goblin Warrior doesn't find Brakka.");
    s.act([], next);
    // Brakka attacks from hiding: Advantage, then it's no longer hidden.
    s.act([15, 15, 3, 3], {
      type: "attack",
      id: "brakka",
      target: "goblin-warrior",
      attack: "Greatsword",
    });
    expect((s.result() as AttackResult).roll.mode).toBe("advantage");
    expect(s.get("brakka")?.hidden).toBeNull();
    expect(s.states.brakka?.conditions).toEqual([]);
  });

  it("with positions, hiding needs Three-Quarters Cover from every enemy (or obscurement)", () => {
    const s = session({ brakka: fighterBuild() }, [{ monster: "goblin-warrior", at: [5, 0] }], {
      brakka: [0, 0],
    });
    expect(() => s.act([16], { type: "hide", id: "brakka" })).toThrow(
      "Goblin Warrior can see Brakka: hiding needs Three-Quarters or Total Cover from every enemy, or being Heavily Obscured (obscured: true)",
    );
    s.act([], { type: "add_wall", from: { x: 2, y: -5 }, to: { x: 2, y: 5 } });
    s.act([15], { type: "hide", id: "brakka" });
    expect(s.get("brakka")?.hidden).not.toBeNull();
    // Found: a Search that beats its total.
    s.act([], next);
    s.act([20], { type: "search", id: "goblin-warrior", target: "brakka" });
    expect(s.get("brakka")?.hidden).toBeNull();
    expect(s.notes.some((n) => n.includes("Goblin Warrior finds it"))).toBe(true);
  });
});

describe("Ready", () => {
  it("an attack readied with a trigger, taken later with the reaction", () => {
    const s = session({ brakka: fighterBuild() }, [{ monster: "goblin-warrior" }]);
    const swing: EncounterAction = {
      type: "attack",
      id: "brakka",
      target: "goblin-warrior",
      attack: "Greatsword",
    };
    s.act([], { type: "ready", id: "brakka", trigger: "the goblin comes close", action: swing });
    expect(s.get("brakka")).toMatchObject({
      used: { action: true },
      readied: { trigger: "the goblin comes close", held: false },
    });
    expect(() => s.act([], { type: "release", id: "goblin-warrior" })).toThrow(
      "Goblin Warrior has nothing readied",
    );
    s.act([15, 3, 3], next, { type: "release", id: "brakka" });
    expect(s.notes).toContain("Brakka takes its readied action (the goblin comes close).");
    expect(s.get("brakka")).toMatchObject({ used: { reaction: true }, readied: null });
    expect(s.get("goblin-warrior")?.hp).toBeLessThan(10);
  });

  it("a readied spell spends its slot and is held with Concentration until it's released or lost", () => {
    const ilse = autocomplete(classBuild("wizard", { name: "Ilse" }));
    const s = session({ ilse }, [{ monster: "goblin-warrior" }]);
    const bolt: EncounterAction = {
      type: "cast",
      id: "ilse",
      spell: "chromatic-orb",
      targets: ["goblin-warrior"],
      damage_type: "fire",
    };
    s.act([], { type: "ready", id: "ilse", trigger: "it attacks", action: bolt });
    expect(s.states.ilse?.spell_slots_spent).toEqual([1]);
    expect(s.states.ilse?.concentration).toBe("Chromatic Orb");
    s.act([15, 3, 3, 3], next, { type: "release", id: "ilse" });
    // The slot was spent when it was readied, not again.
    expect(s.states.ilse?.spell_slots_spent).toEqual([1]);
    expect(s.get("ilse")?.used.reaction).toBe(true);
    // Readied again next turn, then lost when its next turn starts.
    s.act([], next);
    s.act([], { type: "ready", id: "ilse", trigger: "it moves", action: bolt });
    s.act([], next, next);
    expect(s.notes).toContain("Ilse's readied action is lost (its turn started).");
    expect(s.states.ilse?.concentration).toBeNull();
    expect(s.states.ilse?.spell_slots_spent).toEqual([2]);
  });

  it("a readied move: up to its Speed, outside its turn; a minute-long spell can't be readied", () => {
    const s = session({ brakka: fighterBuild() }, [{ monster: "goblin-warrior", at: [5, 0] }], {
      brakka: [0, 0],
    });
    s.act([], { type: "move", id: "brakka", to: { x: 3, y: 0 } });
    s.act([], {
      type: "ready",
      id: "brakka",
      trigger: "the goblin steps next to me",
      action: { type: "move", id: "brakka", to: { x: 0, y: 5 } },
    });
    s.act([], next, { type: "release", id: "brakka" });
    expect(s.get("brakka")?.position).toEqual({ x: 0, y: 5 });
    const ilse = autocomplete(classBuild("wizard", { name: "Ilse" }));
    const t = session({ ilse }, [{ monster: "goblin-warrior" }]);
    expect(() =>
      t.act([], {
        type: "ready",
        id: "ilse",
        trigger: "x",
        action: { type: "cast", id: "ilse", spell: "alarm" },
      }),
    ).toThrow("Alarm takes 1 minute: only a spell cast with an action can be readied");
  });
});

describe("Study, Influence, Utilize", () => {
  it("checks that take the action; Influence's DC from a monster's Intelligence", () => {
    const s = session({ brakka: fighterBuild() }, [{ monster: "goblin-warrior" }]);
    s.act([10], { type: "study", id: "brakka", skill: "history" });
    expect(s.notes.at(-1)).toMatch(/^Brakka's History check: \d+\.$/);
    expect(s.get("brakka")?.used.action).toBe(true);
    s.act([], next, next);
    s.act([10], {
      type: "influence",
      id: "brakka",
      skill: "intimidation",
      target: "goblin-warrior",
    });
    expect(s.notes.at(-1)).toMatch(/Intimidation check: \d+ vs DC 15/);
    s.act([], next, next, { type: "utilize", id: "brakka", what: "pulls the lever" });
    expect(s.notes.at(-1)).toBe("Brakka takes the Utilize action: pulls the lever.");
  });
});
