import { describe, expect, it } from "vitest";
import {
  applyEncounterAction,
  type CharacterBuild,
  type CharacterState,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  scriptedRng,
} from "../src/index";
import { autocomplete, catalog, classBuild, fighterBuild, levelUpIn } from "./helpers";

// Decisions made after seeing a roll (SRD: "when the creature fails a D20 Test, the creature can
// roll the Bardic Inspiration die"; Legendary Resistance: "it can choose to succeed instead";
// Uncanny Dodge: "when an attacker … hits you"). `ask`: the action stops for an answer; `auto`:
// only when it can turn the failure into a success.

const level = (classId: string, n: number, name: string) =>
  levelUpIn(autocomplete(classBuild(classId, { name })), classId, n - 1);

function session(
  builds: Record<string, CharacterBuild>,
  monsters: { monster: string; decisions?: "ask" | "auto" }[],
  start: Encounter = createEncounter(),
) {
  const states: Record<string, CharacterState> = Object.fromEntries(
    Object.entries(builds).map(([k, b]) => [k, createState(b, catalog)]),
  );
  let encounter = start;
  const notes: string[] = [];
  let last: ReturnType<typeof applyEncounterAction> | null = null;
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
  // Monster ids as `add_monster` numbers them: goblin-warrior, goblin-warrior-2…
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
  return { act, notes, get, states, encounter: () => encounter, last: () => last };
}

describe("Bardic Inspiration", () => {
  /** Lute inspires Brakka (Str check +3); the encounter asks. */
  function inspired(decisions: "ask" | "auto") {
    const s = session(
      { lute: level("bard", 1, "Lute"), brakka: fighterBuild() },
      [{ monster: "goblin-warrior" }],
      createEncounter({ decisions }),
    );
    s.act([], { type: "feature", id: "lute", feature: "Bardic Inspiration", target: "brakka" });
    return s;
  }
  const check: EncounterAction = { type: "check", id: "brakka", ability: "str", dc: 15 };

  it("ask: the action stops after the roll, before anything is applied", () => {
    const s = inspired("ask");
    s.act([10], check); // 10 + 3 = 13 vs 15
    expect(s.encounter().pending).toMatchObject({
      combatant: "brakka",
      kind: "inspiration",
      question: "Brakka: Strength check 13 vs 15. Add the Bardic Inspiration die (d6)?",
      rolls: [10],
    });
    expect(s.notes.at(-1)).toBe(s.encounter().pending?.question);
    expect(() => s.act([], { type: "next_turn" })).toThrow("Waiting for a decision");
    // Yes: the same d20 (10), then the d6 (4): 17, a success.
    s.act([4], { type: "decide", use: true });
    expect(s.encounter().pending).toBeNull();
    expect(s.last()?.result).toMatchObject({ total: 17, success: true, inspiration: 4 });
    expect(s.get("brakka")?.inspiration).toBeNull();
  });

  it("ask: a player who rolled a 2 keeps the die", () => {
    const s = inspired("ask");
    s.act([2], check); // 5 vs 15
    expect(s.encounter().pending?.question).toBe(
      "Brakka: Strength check 5 vs 15. Add the Bardic Inspiration die (d6)?",
    );
    s.act([], { type: "decide", use: false });
    expect(s.last()?.result).toMatchObject({ success: false });
    expect(s.get("brakka")?.inspiration).toEqual({ die: 6, by: "lute" });
  });

  it("auto: used only when the die can make up the difference", () => {
    const s = inspired("auto");
    s.act([2], check); // short by 10: kept
    expect(s.encounter().pending).toBeNull();
    expect(s.get("brakka")?.inspiration).not.toBeNull();
    s.act([10, 4], check); // short by 2: used
    expect(s.last()?.result).toMatchObject({ total: 17, inspiration: 4 });
    expect(s.get("brakka")?.inspiration).toBeNull();
  });
});

describe("Legendary Resistance and Uncanny Dodge", () => {
  const fireball = (targets: string[]): EncounterAction => ({
    type: "cast",
    id: "mage",
    spell: "fireball",
    targets,
  });
  const dice = Array<number>(9).fill(2); // 9d6 (level 4 Fireball) = 18

  it("the GM decides for a monster set to ask, one question at a time", () => {
    const s = session({}, [
      { monster: "mage" },
      { monster: "adult-blue-dragon", decisions: "ask" },
    ]);
    s.act([1], fireball(["adult-blue-dragon"]));
    expect(s.encounter().pending).toMatchObject({
      combatant: "adult-blue-dragon",
      kind: "legendary_resistance",
      question:
        "Adult Blue Dragon fails a Dexterity saving throw (6 vs DC 14). Use Legendary Resistance (3 left)?",
    });
    expect(s.get("adult-blue-dragon")?.hp).toBe(212);
    s.act(dice, { type: "decide", use: false });
    expect(s.get("adult-blue-dragon")).toMatchObject({
      hp: 212 - 18,
      legendary_resistance_used: 0,
    });
  });

  it("several decisions in one action are asked in order and replayed with the same dice", () => {
    const s = session({}, [
      { monster: "mage" },
      { monster: "adult-blue-dragon", decisions: "ask" },
      { monster: "adult-blue-dragon", decisions: "ask" },
    ]);
    // The first save stops the action; the second dragon's d20 comes with the first answer.
    s.act([1], fireball(["adult-blue-dragon", "adult-blue-dragon-2"]));
    expect(s.encounter().pending?.combatant).toBe("adult-blue-dragon");
    s.act([1], { type: "decide", use: true });
    expect(s.encounter().pending).toMatchObject({
      combatant: "adult-blue-dragon-2",
      answers: [true],
    });
    s.act(dice, { type: "decide", use: false });
    expect(s.get("adult-blue-dragon")).toMatchObject({ hp: 212 - 9, legendary_resistance_used: 1 });
    expect(s.get("adult-blue-dragon-2")).toMatchObject({
      hp: 212 - 18,
      legendary_resistance_used: 0,
    });
  });

  it("Uncanny Dodge is offered once the rogue knows it's hit", () => {
    const s = session(
      { pip: level("rogue", 5, "Pip") },
      [{ monster: "goblin-warrior" }],
      createEncounter({ decisions: "ask" }),
    );
    const swing: EncounterAction = {
      type: "attack",
      id: "goblin-warrior",
      target: "pip",
      attack: "Scimitar",
    };
    s.act([], { type: "next_turn" }, { type: "set_decisions", id: "goblin-warrior", mode: "auto" });
    s.act([19, 6], swing);
    expect(s.encounter().pending).toMatchObject({ combatant: "pip", kind: "uncanny_dodge" });
    expect(s.encounter().pending?.question).toMatch(
      /^Goblin Warrior hits Pip with Scimitar .*Pip: use Uncanny Dodge to halve the damage\?$/,
    );
    s.act([], { type: "decide", use: false });
    expect(s.get("pip")?.used.reaction).toBe(false);
    s.act([], { type: "next_turn" }, { type: "next_turn" }); // Pip's turn, then the goblin's
    s.act([19, 6], swing);
    s.act([], { type: "decide", use: true });
    expect(s.notes).toContain("Pip uses Uncanny Dodge: the damage is halved.");
    expect(s.get("pip")?.used.reaction).toBe(true);
  });
});
