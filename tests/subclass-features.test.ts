import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyEncounterAction,
  type CharacterBuild,
  type CharacterState,
  computePlaySheet,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  resolve,
  type SpellCastResult,
  scriptedRng,
} from "../src/index";
import * as svc from "../src/services/builder";
import { autocomplete, catalog, classBuild, levelUpIn } from "./helpers";

// SRD 5.2.1 subclass features used in turns: Wholeness of Body and Open Hand Technique (Warrior of
// the Open Hand), Survivor (Champion), Sculpt Spells (Evoker), Dark One's Blessing and Fiendish
// Resilience (Fiend Patron).

const level = (classId: string, n: number, name: string) =>
  levelUpIn(autocomplete(classBuild(classId, { name })), classId, n - 1);

function session(builds: Record<string, CharacterBuild>, monsters: string[] = ["goblin-warrior"]) {
  const states: Record<string, CharacterState> = Object.fromEntries(
    Object.entries(builds).map(([k, b]) => [k, createState(b, catalog)]),
  );
  let e: Encounter = createEncounter();
  let last: ReturnType<typeof applyEncounterAction> | null = null;
  const notes: string[] = [];
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
      notes.push(...last.notes);
    }
  };
  const keys = Object.keys(builds);
  const ids = monsters.map((m, i) => (monsters.indexOf(m) === i ? m : `${m}-${i + 1}`));
  act(
    [],
    ...keys.map((character) => ({ type: "add_character", character }) as const),
    ...monsters.map((monster) => ({ type: "add_monster", monster, side: "enemies" }) as const),
    ...keys.map((id, i) => ({ type: "set_initiative", id, value: 20 - i }) as const),
    ...ids.map((id, i) => ({ type: "set_initiative", id, value: 10 - i }) as const),
    { type: "start" },
  );
  const play = (k: string) =>
    computePlaySheet(builds[k] as CharacterBuild, states[k] as CharacterState, catalog).play;
  return {
    act,
    notes,
    states,
    play,
    get: (id: string) => e.combatants.find((c) => c.id === id),
    result: () => last?.result,
  };
}
const hurt = (id: string, amount: number): EncounterAction => ({
  type: "effects",
  id,
  actions: [{ type: "damage", amount, damage_type: "slashing" }],
});

describe("Warrior of the Open Hand", () => {
  it("Wholeness of Body: a Bonus Action heals the Martial Arts die + Wisdom", () => {
    const kai = level("monk", 6, "Kai");
    const s = session({ kai });
    s.act([], hurt("kai", 20));
    const before = s.play("kai").hp.current;
    s.act([5], { type: "feature", id: "kai", feature: "Wholeness of Body" });
    const wis = computePlaySheet(kai, s.states.kai as CharacterState, catalog).modifiers.wis;
    expect(s.play("kai").hp.current).toBe(before + 5 + wis);
    expect(s.get("kai")?.used.bonus_action).toBe(true);
  });

  it("Open Hand Technique: Topple on a Flurry of Blows hit; refused on another attack", () => {
    const kai = level("monk", 3, "Kai");
    const s = session({ kai });
    const strike = (extra: Partial<EncounterAction>) =>
      ({
        type: "attack",
        id: "kai",
        target: "goblin-warrior",
        attack: "Unarmed Strike",
        ...extra,
      }) as EncounterAction;
    expect(() => s.act([18, 1], strike({ technique: "topple" }))).toThrow(
      "Open Hand Technique is used with a Flurry of Blows attack (`granted`)",
    );
    s.act([], { type: "feature", id: "kai", feature: "Flurry of Blows" });
    // A hit (18), 1 damage, then the goblin's Dexterity save (2).
    s.act([18, 1, 2], strike({ granted: true, technique: "topple" }));
    expect(s.get("goblin-warrior")?.conditions).toContain("prone");
    s.act([18, 18, 1], strike({ granted: true, technique: "addle" })); // Prone: Advantage
    expect(s.notes).toContain(
      "Goblin Warrior can't make Opportunity Attacks until the start of its next turn (Open Hand Technique).",
    );
  });
});

describe("Champion: Survivor", () => {
  it("Heroic Rally: 5 + Con at the start of its turn while Bloodied", () => {
    const brakka = level("fighter", 18, "Brakka");
    const s = session({ brakka });
    const max = s.play("brakka").hp.max;
    s.act([], hurt("brakka", Math.ceil(max / 2) + 1), { type: "next_turn" }, { type: "next_turn" });
    expect(s.notes.some((n) => n.startsWith("Heroic Rally: Brakka regains"))).toBe(true);
  });

  it("Defy Death: Advantage on Death Saving Throws, and an 18 counts as a 20", () => {
    const brakka = level("fighter", 18, "Brakka");
    let state = createState(brakka, catalog);
    state = { ...state, hp: { current: 0, temp: 0 } };
    const r = applyAction(
      brakka,
      state,
      catalog,
      { type: "death_save" },
      { rng: scriptedRng([4, 18]) },
    );
    expect(r.state.hp.current).toBe(1);
  });
});

describe("Evoker: Sculpt Spells", () => {
  it("chosen creatures succeed on an Evocation spell's save and take no damage", () => {
    let ilse = level("wizard", 6, "Ilse");
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
    const s = session({ ilse }, ["goblin-warrior", "goblin-warrior"]);
    const targets = ["goblin-warrior", "goblin-warrior-2"];
    s.act([2, 3, 3, 3], {
      type: "cast",
      id: "ilse",
      spell: "burning-hands",
      targets,
      sculpt: ["goblin-warrior"],
    });
    const r = s.result() as SpellCastResult;
    expect(r.targets[0]?.save?.automatic_success).toBeTruthy();
    expect(r.targets[0]?.instances).toEqual([]);
    expect(() =>
      s.act(
        [],
        { type: "next_turn" },
        { type: "cast", id: "ilse", spell: "burning-hands", targets, sculpt: targets.concat("x") },
      ),
    ).toThrow();
  });
});

describe("Fiend Patron", () => {
  it("Dark One's Blessing: Temporary Hit Points when the warlock drops an enemy", () => {
    const vex = level("warlock", 3, "Vex");
    const s = session({ vex });
    s.act([], hurt("goblin-warrior", 9));
    // Eldritch Blast: 18 hits, 1d10 rolls 5.
    s.act([18, 5], {
      type: "cast",
      id: "vex",
      spell: "eldritch-blast",
      targets: ["goblin-warrior"],
    });
    const cha = computePlaySheet(vex, s.states.vex as CharacterState, catalog).modifiers.cha;
    expect(s.notes).toContain(`Dark One's Blessing: Vex gains ${cha + 3} Temporary Hit Points.`);
    expect(s.play("vex").hp.temp).toBe(cha + 3);
  });

  it("Fiendish Resilience: a damage type chosen after a rest gives Resistance", () => {
    let vex = level("warlock", 10, "Vex");
    const key = resolve(vex, catalog).choices.find((c) =>
      c.key.endsWith("#fiendish_resilience"),
    )?.key;
    expect(key).toBeDefined();
    vex = svc.setChoice(vex, catalog, key as string, ["fire"]).build;
    expect(computePlaySheet(vex, createState(vex, catalog), catalog).resistances).toContain("fire");
  });
});
