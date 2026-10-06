import { describe, expect, it } from "vitest";
import {
  applyEncounterAction,
  type CharacterBuild,
  type CharacterState,
  computePlaySheet,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  resolve,
  scriptedRng,
} from "../src/index";
import * as svc from "../src/services/builder";
import { autocomplete, catalog, classBuild, levelUpIn } from "./helpers";

// SRD 5.2.1: Rage lasts up to 10 minutes, Innate Sorcery 1 minute; Divine Strike "once on each of
// your turns"; Spirit Guardians halves other creatures' Speed in its Emanation.

const level = (classId: string, n: number, name: string) =>
  levelUpIn(autocomplete(classBuild(classId, { name })), classId, n - 1);

function withSpell(b: CharacterBuild, spell: string): CharacterBuild {
  if (computePlaySheet(b, createState(b, catalog), catalog).spells.some((x) => x.id === spell))
    return b;
  const res = resolve(b, catalog);
  const choice = res.choices.find(
    (c) => c.definition.kind === "spell" && res.options(c).some((o) => o.id === spell),
  );
  if (!choice) throw new Error(`no choice offers ${spell}`);
  return svc.setChoice(b, catalog, choice.key, [...res.selected(choice).slice(0, -1), spell]).build;
}

function session(
  builds: Record<string, CharacterBuild>,
  at: Record<string, [number, number]> = {},
) {
  const states: Record<string, CharacterState> = Object.fromEntries(
    Object.entries(builds).map(([k, b]) => [k, createState(b, catalog)]),
  );
  let encounter: Encounter = createEncounter();
  const notes: string[] = [];
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
    }
  };
  const keys = Object.keys(builds);
  act(
    [],
    ...keys.map((character) => ({ type: "add_character", character, side: "party" }) as const),
    { type: "add_monster", monster: "goblin-warrior", side: "enemies" },
    ...keys.flatMap((id) =>
      at[id] ? [{ type: "place", id, x: at[id][0], y: at[id][1] } as const] : [],
    ),
    ...(at.goblin
      ? [{ type: "place", id: "goblin-warrior", x: at.goblin[0], y: at.goblin[1] } as const]
      : []),
    ...[...keys, "goblin-warrior"].map(
      (id, i) => ({ type: "set_initiative", id, value: 20 - i }) as const,
    ),
    { type: "start" },
  );
  return { act, notes, states, encounter: () => encounter };
}
const next = { type: "next_turn" } as const;
const on = (id: string, key: string): EncounterAction => ({
  type: "effects",
  id,
  actions: [{ type: "activate", key }],
});

describe("toggle durations", () => {
  it("Rage ends after 10 minutes (100 rounds) even when it's extended every turn", () => {
    const grom = level("barbarian", 1, "Grom");
    const s = session({ grom });
    s.act([], on("grom", "barbarian:rage"));
    for (let round = 0; round < 99; round++) {
      s.act([], { type: "extend", id: "grom" }, next, next);
    }
    expect(s.states.grom?.active).toEqual(["barbarian:rage"]);
    s.act([], { type: "extend", id: "grom" }, next, next);
    expect(s.notes).toContain("Rage ends: its duration is over.");
    expect(s.states.grom?.active).toEqual([]);
  });

  it("Innate Sorcery lasts 1 minute", () => {
    const sora = level("sorcerer", 1, "Sora");
    const s = session({ sora });
    s.act([], on("sora", "sorcerer:innate-sorcery"));
    for (let round = 0; round < 10; round++) s.act([], next, next);
    expect(s.notes).toContain("Innate Sorcery ends: its duration is over.");
  });
});

describe("Divine Strike on your own turns only", () => {
  it("refused on an Opportunity Attack", () => {
    const ilsa = level("cleric", 7, "Ilsa");
    const line = computePlaySheet(ilsa, createState(ilsa, catalog), catalog).attacks.find((a) =>
      a.riders.some((r) => r.id === "divine-strike"),
    );
    expect(line).toBeDefined();
    const s = session({ ilsa });
    s.act([], next);
    expect(() =>
      s.act([15, 3, 3], {
        type: "attack",
        id: "ilsa",
        target: "goblin-warrior",
        attack: line?.name as string,
        opportunity: true,
        riders: [{ rider: "divine-strike", type: "radiant" }],
      }),
    ).toThrow("Divine Strike is used on Ilsa's own turns");
  });
});

describe("Spirit Guardians halves Speed", () => {
  it("for a creature in the Emanation, not for its caster", () => {
    const ilsa = withSpell(level("cleric", 5, "Ilsa"), "spirit-guardians");
    const s = session({ ilsa }, { ilsa: [0, 0], goblin: [2, 0] });
    s.act([], { type: "cast", id: "ilsa", spell: "spirit-guardians", damage_type: "radiant" });
    s.act([], { type: "move", id: "ilsa", feet: 30 });
    s.act([20, 20], next);
    expect(() => s.act([], { type: "move", id: "goblin-warrior", feet: 20 })).toThrow(
      "Goblin Warrior can move 15 more feet this turn",
    );
  });
});
