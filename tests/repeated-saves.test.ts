import { describe, expect, it } from "vitest";
import {
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
import { autocomplete, catalog, classBuild, levelUpIn } from "./helpers";

// Spells whose target repeats the save at the end of each of its turns (SRD 5.2.1 "Spells": Hold
// Person, Blindness/Deafness), and a condition the caster picks.

/** Ilse, a level 3 wizard with Hold Person and Blindness/Deafness prepared. */
function ilse(): CharacterBuild {
  let b = levelUpIn(autocomplete(classBuild("wizard", { name: "Ilse" })), "wizard", 2);
  for (const key of ["class:wizard:3#spellbook", "class:wizard#prepared"]) {
    const res = resolve(b, catalog);
    const choice = res.choices.find((c) => c.key === key);
    if (!choice) throw new Error(`no ${key}`);
    const want = ["hold-person", "blindness-deafness"];
    const others = res.selected(choice).filter((x) => !want.includes(x));
    b = svc.setChoice(b, catalog, key, [
      ...want,
      ...others.slice(0, res.required(choice) - 2),
    ]).build;
    b = autocomplete(b);
  }
  return b;
}

function session() {
  const build = ilse();
  let state: CharacterState = createState(build, catalog);
  let e: Encounter = createEncounter();
  const act = (rolls: number[], ...actions: EncounterAction[]) => {
    for (const action of actions) {
      const r = applyEncounterAction(e, action, {
        catalog,
        characters: { ilse: { build, state } },
        rng: scriptedRng(rolls),
      });
      e = r.encounter;
      state = r.states.ilse ?? state;
    }
  };
  act(
    [],
    { type: "add_character", character: "ilse" },
    { type: "add_monster", monster: "bandit", side: "enemies" },
    { type: "set_initiative", id: "ilse", value: 20 },
    { type: "set_initiative", id: "bandit", value: 10 },
    { type: "start" },
  );
  return { act, bandit: () => e.combatants.find((c) => c.id === "bandit") };
}

describe("repeated saves", () => {
  it("Hold Person: the bandit saves again at the end of its turn, and is free on a success", () => {
    const s = session();
    s.act([2], { type: "cast", id: "ilse", spell: "hold-person", targets: ["bandit"] });
    expect(s.bandit()?.conditions).toContain("paralyzed");
    s.act([20], { type: "next_turn" }, { type: "next_turn" }); // the bandit's turn ends: a 20
    expect(s.bandit()?.conditions ?? []).not.toContain("paralyzed");
  });

  it("Blindness/Deafness: the caster picks the condition", () => {
    const s = session();
    expect(() =>
      s.act([2], { type: "cast", id: "ilse", spell: "blindness-deafness", targets: ["bandit"] }),
    ).toThrow(/choose the condition/);
    s.act([2], {
      type: "cast",
      id: "ilse",
      spell: "blindness-deafness",
      targets: ["bandit"],
      condition: "deafened",
    });
    expect(s.bandit()?.conditions).toEqual(["deafened"]);
  });
});
