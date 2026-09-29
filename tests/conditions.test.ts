import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyEncounterAction,
  type CharacterState,
  type Combatant,
  castSpell,
  combatantFromCharacter,
  combatantFromMonster,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  lookup,
  type MonsterDef,
  makeAttack,
  rollSavingThrow,
  type SpellDef,
  scriptedRng,
} from "../src/index";
import { autocomplete, catalog, classBuild, fighterBuild } from "./helpers";

// Every case follows the SRD 5.2.1 Rules Glossary, conditions ("Attacks Affected", "Saving
// Throws Affected", "Automatic Critical Hits").

const fighter = fighterBuild(); // Brakka: Greatsword +5 (2d6+3), AC 17
const brakka = (...conditions: string[]): Combatant => {
  let state: CharacterState = createState(fighter, catalog);
  for (const condition of conditions) {
    state = applyAction(fighter, state, catalog, { type: "add_condition", condition }).state;
  }
  return combatantFromCharacter(fighter, state, catalog);
};
const goblin = (...conditions: string[]): Combatant =>
  combatantFromMonster(
    lookup(catalog.monsters, "goblin-warrior") as MonsterDef,
    { conditions },
    { conditions: catalog.conditions },
  );
const spell = (id: string) => lookup(catalog.spells, id) as SpellDef;

describe("attack rolls", () => {
  it("Blinded: attacks against it have Advantage, its own have Disadvantage", () => {
    const against = makeAttack(brakka(), "Greatsword", goblin("blinded"), {
      rng: scriptedRng([4, 16, 3, 3]),
    });
    expect(against.roll).toMatchObject({ rolls: [4, 16], d20: 16, mode: "advantage" });
    expect(against.reasons).toEqual(["Advantage: Goblin Warrior is Blinded (within 5 ft)"]);
    const its = makeAttack(goblin("blinded"), "Scimitar", brakka(), { rng: scriptedRng([18, 5]) });
    expect(its.roll).toMatchObject({ d20: 5, mode: "disadvantage" });
    expect(its.hit).toBe(false);
  });

  it("Prone: Advantage within 5 feet, Disadvantage from farther, and on its own attacks", () => {
    const near = makeAttack(brakka(), "Greatsword", goblin("prone"), {
      rng: scriptedRng([4, 16, 3, 3]),
    });
    expect(near.roll.mode).toBe("advantage");
    const far = makeAttack(brakka(), "Greatsword", goblin("prone"), {
      within_5ft: false,
      rng: scriptedRng([16, 4]),
    });
    expect(far.roll.mode).toBe("disadvantage");
    expect(far.reasons).toEqual(["Disadvantage: Goblin Warrior is Prone (beyond 5 ft)"]);
    const its = makeAttack(goblin("prone"), "Scimitar", brakka(), { rng: scriptedRng([18, 5]) });
    expect(its.roll.mode).toBe("disadvantage");
  });

  it("a ranged attack is beyond 5 feet by default", () => {
    const bow = makeAttack(goblin(), "Shortbow", brakka("prone"), { rng: scriptedRng([18, 5]) });
    expect(bow.roll.mode).toBe("disadvantage");
  });

  it("Invisible, Poisoned and Restrained", () => {
    const unseen = makeAttack(goblin("invisible"), "Scimitar", brakka(), {
      rng: scriptedRng([5, 18, 3]),
    });
    expect(unseen.roll.mode).toBe("advantage");
    const atUnseen = makeAttack(brakka(), "Greatsword", goblin("invisible"), {
      rng: scriptedRng([16, 4]),
    });
    expect(atUnseen.roll.mode).toBe("disadvantage");
    const sick = makeAttack(goblin("poisoned"), "Scimitar", brakka(), {
      rng: scriptedRng([18, 5]),
    });
    expect(sick.roll.mode).toBe("disadvantage");
    const held = makeAttack(brakka(), "Greatsword", goblin("restrained"), {
      rng: scriptedRng([4, 16, 3, 3]),
    });
    expect(held.roll.mode).toBe("advantage");
    const holding = makeAttack(goblin("restrained"), "Scimitar", brakka(), {
      rng: scriptedRng([18, 5]),
    });
    expect(holding.roll.mode).toBe("disadvantage");
  });

  it("Advantage and Disadvantage cancel, however many of each", () => {
    // Poisoned attacker (Disadvantage) against a Prone target within 5 ft (Advantage): one d20.
    const r = makeAttack(goblin("poisoned"), "Scimitar", brakka("prone"), {
      rng: scriptedRng([12, 3]),
    });
    expect(r.roll).toMatchObject({ rolls: [12], mode: "normal" });
    expect(r.reasons).toEqual([
      "Disadvantage: Goblin Warrior is Poisoned",
      "Advantage: Brakka is Prone (within 5 ft)",
    ]);
    // Asked Advantage plus a Poisoned attacker: normal.
    const asked = makeAttack(goblin("poisoned"), "Scimitar", brakka(), {
      mode: "advantage",
      rng: scriptedRng([12, 3]),
    });
    expect(asked.roll.mode).toBe("normal");
  });

  it("Paralyzed: a hit from within 5 feet is a Critical Hit; not from farther", () => {
    // Advantage; 9 + 5 = 14 misses AC 15, and a miss is never a Critical Hit.
    const miss = makeAttack(brakka(), "Greatsword", goblin("paralyzed"), {
      rng: scriptedRng([8, 9]),
    });
    expect(miss).toMatchObject({ hit: false, critical_hit: false });
    const hit = makeAttack(brakka(), "Greatsword", goblin("paralyzed"), {
      rng: scriptedRng([8, 12, 1, 2, 3, 4]),
    });
    expect(hit).toMatchObject({ hit: true, critical_hit: true });
    expect(hit.damage?.parts[0]?.rolls).toEqual([1, 2, 3, 4]); // the dice twice
    const far = makeAttack(brakka(), "Greatsword", goblin("paralyzed"), {
      within_5ft: false,
      rng: scriptedRng([8, 12, 1, 2]),
    });
    expect(far).toMatchObject({ hit: true, critical_hit: false });
  });

  it("Unconscious implies Prone: from farther, Advantage and Disadvantage cancel", () => {
    const far = makeAttack(brakka(), "Greatsword", goblin("unconscious"), {
      within_5ft: false,
      rng: scriptedRng([12, 1, 1]),
    });
    expect(far.roll.mode).toBe("normal");
    const near = makeAttack(brakka(), "Greatsword", goblin("unconscious"), {
      rng: scriptedRng([8, 12, 1, 1, 1, 1]),
    });
    expect(near).toMatchObject({ critical_hit: true });
    expect(near.roll.mode).toBe("advantage");
  });

  it("a Prone target within 5 feet enables Sneak Attack without asking for Advantage", () => {
    const pip = autocomplete(classBuild("rogue", { name: "Pip" }));
    const rogue = combatantFromCharacter(pip, createState(pip, catalog), catalog);
    const r = makeAttack(rogue, "Dagger", goblin("prone"), {
      riders: [{ rider: "sneak-attack" }],
      rng: scriptedRng([4, 16, 2, 5]),
    });
    expect(r).toMatchObject({ hit: true, riders: ["Sneak Attack"] });
  });
});

describe("saving throws", () => {
  it("Paralyzed, Stunned, Unconscious, Petrified: Strength and Dexterity fail without a roll", () => {
    for (const condition of ["paralyzed", "stunned", "unconscious", "petrified"]) {
      const save = rollSavingThrow(goblin(condition), "dex", 5, { rng: scriptedRng([]) });
      expect(save, condition).toMatchObject({ success: false });
      expect(save.automatic_failure).toBeTruthy();
    }
    const wisdom = rollSavingThrow(goblin("paralyzed"), "wis", 5, { rng: scriptedRng([10]) });
    expect(wisdom).toMatchObject({ success: true, automatic_failure: null });
  });

  it("Restrained: Dexterity saves with Disadvantage", () => {
    const save = rollSavingThrow(goblin("restrained"), "dex", 12, { rng: scriptedRng([15, 6]) });
    expect(save).toMatchObject({ total: 8, success: false });
    expect(save.reasons).toEqual(["Disadvantage: Goblin Warrior is Restrained"]);
  });
});

describe("spells", () => {
  const caster: Combatant = {
    ...brakka(),
    name: "Mage",
    spellcasting: [
      {
        source: "Wizard",
        list: "wizard",
        ability: "int",
        save_dc: 15,
        attack_bonus: 7,
        modifier: 4,
      },
    ],
  };

  it("a spell attack against a Blinded target has Advantage", () => {
    const r = castSpell(caster, spell("fire-bolt"), [goblin("blinded")], {
      rng: scriptedRng([3, 14, 6]),
    });
    expect(r.targets[0]?.attack).toMatchObject({ hit: true });
    expect(r.targets[0]?.attack?.roll.mode).toBe("advantage");
  });

  it("a Paralyzed target fails a Fireball's Dexterity save and takes full damage", () => {
    const r = castSpell(caster, spell("fireball"), [goblin("paralyzed")], {
      rng: scriptedRng(Array(8).fill(1)),
    });
    expect(r.targets[0]?.save).toMatchObject({ success: false, automatic_failure: "Paralyzed" });
    expect(r.targets[0]?.instances).toEqual([{ amount: 8, type: "fire" }]);
  });
});

describe("in an encounter", () => {
  const run = (encounter: Encounter, rolls: number[], ...actions: EncounterAction[]) => {
    const rng = scriptedRng(rolls);
    let e = encounter;
    let state = createState(fighter, catalog);
    const notes: string[] = [];
    for (const action of actions) {
      const characters = { brakka: { build: fighter, state } };
      const r = applyEncounterAction(e, action, { catalog, characters, rng });
      e = r.encounter;
      state = r.states.brakka ?? state;
      notes.push(...r.notes);
    }
    return { encounter: e, notes };
  };
  const fight = () =>
    run(
      createEncounter(),
      [],
      { type: "add_character", character: "brakka" },
      { type: "add_monster", monster: "goblin-warrior" },
      { type: "add_monster", monster: "goblin-warrior" },
      { type: "set_initiative", id: "brakka", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 10 },
      { type: "set_initiative", id: "goblin-warrior-2", value: 5 },
      { type: "start" },
    ).encounter;

  it("Grappled: Disadvantage on attacks, except against the grappler", () => {
    // The goblin grapples Brakka (an effect whose source is the goblin), then Brakka attacks.
    const grapple: EncounterAction = {
      type: "effects",
      id: "brakka",
      actions: [{ type: "add_condition", condition: "grappled" }],
      source: "goblin-warrior",
      label: "Grapple",
    };
    const attack = (target: string): EncounterAction => ({
      type: "attack",
      id: "brakka",
      target,
      attack: "Greatsword",
    });
    // One d20 against the grappler: no Disadvantage.
    const atGrappler = run(fight(), [12, 1, 1], grapple, attack("goblin-warrior"));
    expect(atGrappler.notes.at(-1)).toBe(
      "Brakka hits Goblin Warrior with Greatsword (17 vs AC 15): 5 slashing.",
    );
    // Two d20s against anyone else.
    const atOther = run(fight(), [12, 3], grapple, attack("goblin-warrior-2"));
    expect(atOther.notes.at(-2)).toBe(
      "Brakka misses Goblin Warrior 2 with Greatsword (8 vs AC 15; Disadvantage: Brakka is Grappled).",
    );
  });

  it("a sourced condition is tracked until it's removed", () => {
    const grapple: EncounterAction = {
      type: "effects",
      id: "goblin-warrior-2",
      actions: [{ type: "add_condition", condition: "grappled" }],
      source: "goblin-warrior",
    };
    const held = run(fight(), [], grapple).encounter;
    expect(held.effects).toEqual([
      expect.objectContaining({ target: "goblin-warrior-2", source: "goblin-warrior", ends: null }),
    ]);
    const freed = run(held, [], {
      type: "effects",
      id: "goblin-warrior-2",
      actions: [{ type: "remove_condition", condition: "grappled" }],
    }).encounter;
    expect(freed.effects).toEqual([]);
  });

  it("a knocked-down goblin: the reason is in the notes", () => {
    const { notes } = run(
      fight(),
      [4, 16, 3, 3],
      {
        type: "effects",
        id: "goblin-warrior",
        actions: [{ type: "add_condition", condition: "prone" }],
      },
      { type: "attack", id: "brakka", target: "goblin-warrior", attack: "Greatsword" },
    );
    expect(notes).toContain(
      "Brakka hits Goblin Warrior with Greatsword (21 vs AC 15; Advantage: Goblin Warrior is Prone (within 5 ft)): 9 slashing.",
    );
  });

  it("Invisible rolls Initiative with Advantage, Incapacitated with Disadvantage", () => {
    const { encounter } = run(
      createEncounter(),
      [3, 17, 18, 4],
      { type: "add_monster", monster: "goblin-warrior" },
      { type: "add_monster", monster: "goblin-warrior" },
      {
        type: "effects",
        id: "goblin-warrior",
        actions: [{ type: "add_condition", condition: "invisible" }],
      },
      {
        type: "effects",
        id: "goblin-warrior-2",
        actions: [{ type: "add_condition", condition: "stunned" }],
      },
      { type: "roll_initiative" },
    );
    expect(encounter.combatants.map((c) => c.initiative)).toEqual([17 + 2, 4 + 2]);
  });
});
