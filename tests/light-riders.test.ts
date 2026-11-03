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
  scriptedRng,
} from "../src/index";
import * as svc from "../src/services/builder";
import { autocomplete, catalog, classBuild, fighterBuild } from "./helpers";

// Spells that light a creature up (SRD 5.2.1 "Spells"): Faerie Fire ("Each creature in the Cube is
// also outlined if it fails a Dexterity saving throw … can't benefit from the Invisible condition.
// Attack rolls against an affected creature or object have Advantage") and Starry Wisp ("until the
// end of your next turn, it … can't benefit from the Invisible condition").

/** Fern, a level 1 druid with Starry Wisp and Faerie Fire. */
function fern(): CharacterBuild {
  let b = autocomplete(classBuild("druid", { name: "Fern" }));
  const set = (kind: string, ids: string[]) => {
    const res = resolve(b, catalog);
    const choice = res.choices.find((c) => c.key === `class:druid#${kind}`);
    if (!choice) throw new Error(`no ${kind}`);
    const others = res.selected(choice).filter((x) => !ids.includes(x));
    b = svc.setChoice(b, catalog, choice.key, [
      ...ids,
      ...others.slice(0, Math.max(0, res.required(choice) - ids.length)),
    ]).build;
    b = autocomplete(b);
  };
  set("cantrips", ["starry-wisp"]);
  set("prepared", ["faerie-fire"]);
  return b;
}

function session() {
  const builds: Record<string, CharacterBuild> = { fern: fern(), brakka: fighterBuild() };
  const states: Record<string, CharacterState> = Object.fromEntries(
    Object.entries(builds).map(([k, b]) => [k, createState(b, catalog)]),
  );
  let encounter: Encounter = createEncounter();
  let last: ReturnType<typeof applyEncounterAction> | null = null;
  const notes: string[] = [];
  const act = (rolls: number[], ...actions: EncounterAction[]) => {
    for (const action of actions) {
      last = applyEncounterAction(encounter, action, {
        catalog,
        characters: Object.fromEntries(
          Object.entries(builds).map(([k, build]) => [
            k,
            { build, state: states[k] as CharacterState },
          ]),
        ),
        rng: scriptedRng(rolls),
      });
      encounter = last.encounter;
      Object.assign(states, last.states);
      notes.push(...last.notes);
    }
  };
  act(
    [],
    { type: "add_character", character: "fern" },
    { type: "add_character", character: "brakka" },
    { type: "add_monster", monster: "goblin-warrior", side: "enemies" },
    { type: "set_initiative", id: "fern", value: 20 },
    { type: "set_initiative", id: "brakka", value: 15 },
    { type: "set_initiative", id: "goblin-warrior", value: 10 },
    { type: "start" },
    // The goblin is Invisible: attack rolls against it have Disadvantage.
    {
      type: "effects",
      id: "goblin-warrior",
      actions: [{ type: "add_condition", condition: "invisible" }],
    },
  );
  return {
    act,
    notes,
    states,
    encounter: () => encounter,
    result: () => last?.result,
  };
}

const swing: EncounterAction = {
  type: "attack",
  id: "brakka",
  target: "goblin-warrior",
  attack: "Greatsword",
};
const next = { type: "next_turn" } as const;

describe("Faerie Fire", () => {
  const lit = () => {
    const s = session();
    // The goblin's Dexterity save rolls 2: it fails.
    s.act([2], { type: "cast", id: "fern", spell: "faerie-fire", targets: ["goblin-warrior"] });
    return s;
  };

  it("a failed save outlines the creature: Advantage against it, and it isn't Invisible to attacks", () => {
    const s = lit();
    expect(s.notes).toContain("Faerie Fire: attack rolls against Goblin Warrior have Advantage.");
    expect(s.notes).toContain(
      "Goblin Warrior can't benefit from the Invisible condition (Faerie Fire).",
    );
    s.act([5, 16, 1, 1], next, swing);
    expect(s.result()).toMatchObject({ roll: { mode: "advantage" } });
    expect((s.result() as AttackResult).reasons).toEqual([
      "Advantage: Faerie Fire on Goblin Warrior",
    ]);
    // Not used up: the next attack roll has it too.
    expect(s.encounter().marks).toHaveLength(2);
  });

  it("lasts while the druid concentrates on it", () => {
    const s = lit();
    s.act([], next, next, next, next); // Brakka, the goblin, Fern, Brakka
    expect(s.encounter().marks).toHaveLength(2);
    s.act([], {
      type: "effects",
      id: "fern",
      actions: [{ type: "set_concentration", spell: null }],
    });
    expect(s.encounter().marks).toEqual([]);
  });

  it("a successful save leaves the creature as it was", () => {
    const s = session();
    s.act([19], { type: "cast", id: "fern", spell: "faerie-fire", targets: ["goblin-warrior"] });
    expect(s.encounter().marks).toEqual([]);
    s.act([16, 5, 1, 1], next, swing);
    expect(s.result()).toMatchObject({ roll: { mode: "disadvantage" } });
  });
});

describe("Starry Wisp", () => {
  it("a hit: the target can't benefit from the Invisible condition until the end of Fern's next turn", () => {
    const s = session();
    // Disadvantage against the Invisible goblin: 18 and 15, a 15 + 5 hit.
    s.act([18, 15, 3], {
      type: "cast",
      id: "fern",
      spell: "starry-wisp",
      targets: ["goblin-warrior"],
    });
    expect(s.notes).toContain(
      "Goblin Warrior can't benefit from the Invisible condition (Starry Wisp).",
    );
    // No Disadvantage on Brakka's attack roll (a 3: it misses).
    s.act([3, 18], next, swing);
    expect(s.result()).toMatchObject({ hit: false, roll: { mode: "normal" } });
    s.act([], next, next); // the goblin's turn, Fern's
    expect(s.encounter().marks).toHaveLength(1);
    s.act([], next); // Fern's turn ends
    expect(s.encounter().marks).toEqual([]);
  });
});
