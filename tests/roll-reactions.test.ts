import { describe, expect, it } from "vitest";
import {
  applyEncounterAction,
  type Catalog,
  type CharacterBuild,
  type CharacterState,
  createCatalog,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  type EncounterSettingsInput,
  scriptedRng,
} from "../src/index";
import * as svc from "../src/services/builder";
import { srdPack } from "../src/srd";
import { autocomplete, catalog, classBuild, fighterBuild, levelUpIn } from "./helpers";

// Reactions to another creature's d20 roll (SRD College of Lore "Cutting Words": "When a creature
// that you can see within 60 feet of yourself … succeeds on an ability check or attack roll, you
// can take a Reaction to expend one use of your Bardic Inspiration; roll your Bardic Inspiration
// die, and subtract the number rolled"), offered after the roll and before its outcome.

/** Lute, a level 3 College of Lore Bard (Bardic Die d6). */
const lute = () => levelUpIn(autocomplete(classBuild("bard", { name: "Lute" })), "bard", 2);

function session(
  builds: Record<string, CharacterBuild>,
  monsters: string[],
  { settings = {}, cat = catalog }: { settings?: EncounterSettingsInput; cat?: Catalog } = {},
) {
  const states: Record<string, CharacterState> = Object.fromEntries(
    Object.entries(builds).map(([k, b]) => [k, createState(b, cat)]),
  );
  let encounter: Encounter = createEncounter();
  const notes: string[] = [];
  let last: ReturnType<typeof applyEncounterAction> | null = null;
  const act = (rolls: number[], ...actions: EncounterAction[]) => {
    for (const action of actions) {
      const characters = Object.fromEntries(
        Object.entries(builds).map(([k, build]) => [
          k,
          { build, state: states[k] as CharacterState },
        ]),
      );
      last = applyEncounterAction(encounter, action, {
        catalog: cat,
        characters,
        rng: scriptedRng(rolls),
        settings,
      });
      encounter = last.encounter;
      Object.assign(states, last.states);
      notes.push(...last.notes);
    }
  };
  const keys = Object.keys(builds);
  act(
    [],
    ...keys.map((character) => ({ type: "add_character", character }) as const),
    ...monsters.map((monster) => ({ type: "add_monster", monster, side: "enemies" }) as const),
    // The monsters first, so they act now.
    ...monsters.map((id, i) => ({ type: "set_initiative", id, value: 20 - i }) as const),
    ...keys.map((id, i) => ({ type: "set_initiative", id, value: 10 - i }) as const),
    { type: "start" },
  );
  return {
    act,
    notes,
    states,
    get: (id: string) => encounter.combatants.find((c) => c.id === id),
    encounter: () => encounter,
    last: () => last,
  };
}

const swing: EncounterAction = {
  type: "attack",
  id: "goblin-warrior",
  target: "brakka",
  attack: "Scimitar",
};

describe("Cutting Words", () => {
  it("turns a goblin's hit on an ally into a miss: the Bard's reaction and a Bardic Inspiration use", () => {
    const s = session({ lute: lute(), brakka: fighterBuild() }, ["goblin-warrior"]);
    // 13 + 4 = 17 hits Brakka's AC 17; the Bardic Inspiration d6 rolls 3: 14, a miss.
    s.act([13, 3], swing);
    const attack = s.last()?.result as { hit: boolean; total: number };
    expect(attack).toMatchObject({ hit: false, total: 14 });
    expect(s.notes).toContain("Lute uses Cutting Words: -3 to the roll.");
    expect(s.get("lute")?.used.reaction).toBe(true);
    expect(s.states.lute?.uses_spent["bard:bardic-inspiration"]).toBe(1);
  });

  it("asks the Bard when the table decides; declined, the hit stands", () => {
    const s = session({ lute: lute(), brakka: fighterBuild() }, ["goblin-warrior"], {
      settings: { decisions_by: { lute: "ask" } },
    });
    s.act([13], swing);
    expect(s.encounter().pending).toMatchObject({
      combatant: "lute",
      kind: "roll_reaction",
      question: "Lute: use Cutting Words on Goblin Warrior's attack roll with Scimitar (17 vs 17)?",
    });
    s.act([5, 1], { type: "decide", use: false });
    expect(s.get("lute")?.used.reaction).toBe(false);
    expect((s.last()?.result as { hit: boolean } | undefined)?.hit).toBe(true);
  });

  it("isn't offered on an ally's success, beyond 60 feet, or once the reaction is spent", () => {
    const s = session({ lute: lute(), brakka: fighterBuild() }, ["goblin-warrior"]);
    // Far apart on the map: 70 feet.
    s.act(
      [],
      { type: "place", id: "lute", x: 0, y: 0 },
      { type: "place", id: "goblin-warrior", x: 14, y: 0 },
      { type: "place", id: "brakka", x: 15, y: 0 },
    );
    s.act([13, 5], swing);
    expect((s.last()?.result as { hit: boolean } | undefined)?.hit).toBe(true);
    expect(s.get("lute")?.used.reaction).toBe(false);
  });
});

describe("a reaction that adds to an ally's failed save", () => {
  // Invented: a feat that adds the reactor's Intelligence modifier to a failed save within 30 feet.
  const homebrew = createCatalog(srdPack, {
    name: "homebrew",
    feats: [
      {
        id: "quick-thinker",
        name: "Quick Thinker",
        category: "origin",
        grants: {
          resources: [
            { id: "quick-thinker", name: "Quick Thinker", max: { value: 2 }, recharge: "long" },
          ],
          actions: [
            {
              id: "quick-thinker",
              name: "Quick Thinker",
              economy: "reaction",
              uses: "quick-thinker",
              range: 30,
              modifies_roll: {
                rolls: ["save", "check"],
                when: "failure",
                sign: "add",
                bonus: "int",
                min: 1,
                who: "ally",
              },
            },
          ],
        },
      },
    ],
  });

  it("an ally's failed check gets the bonus and succeeds", () => {
    let ilse = autocomplete(classBuild("wizard", { name: "Ilse" }), homebrew);
    ilse = svc.setChoice(ilse, homebrew, "species:human#versatile", ["quick-thinker"]).build;
    ilse = autocomplete(ilse, homebrew);
    const s = session({ ilse, brakka: fighterBuild() }, [], { cat: homebrew });
    // Brakka's Athletics (+5) rolls 6 against DC 12: 11, a failure; Ilse's Intelligence saves it.
    s.act([6], { type: "check", id: "brakka", skill: "athletics", dc: 12 });
    expect(s.notes.some((n) => n.startsWith("Ilse uses Quick Thinker: "))).toBe(true);
    expect((s.last()?.result as { success: boolean } | undefined)?.success).toBe(true);
    expect(Object.values(s.states.ilse?.uses_spent ?? {})).toEqual([1]);
  });
});
