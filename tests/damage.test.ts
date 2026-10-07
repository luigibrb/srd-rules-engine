import { describe, expect, it } from "vitest";
import {
  adjustDamage,
  applyAction,
  applyEncounterAction,
  type CharacterState,
  combatantFromCharacter,
  computePlaySheet,
  createEncounter,
  createState,
  type Encounter,
  encounterCombatant,
  formatDamage,
  isBloodied,
  rollDamage,
  scriptedRng,
  seededRng,
  takeDamage,
} from "../src/index";
import { catalog, fighterBuild } from "./helpers";

describe("adjustDamage (SRD Resistance, Vulnerability, Immunity)", () => {
  it("halves (rounded down), doubles, or ignores", () => {
    expect(adjustDamage({ amount: 9, type: "fire" }, { resistances: ["fire"] }).amount).toBe(4);
    expect(adjustDamage({ amount: 9, type: "fire" }, { vulnerabilities: ["fire"] }).amount).toBe(
      18,
    );
    expect(adjustDamage({ amount: 9, type: "fire" }, { immunities: ["fire"] }).amount).toBe(0);
    expect(adjustDamage({ amount: 9, type: "cold" }, { resistances: ["fire"] }).amount).toBe(9);
  });

  it("applies Resistance before Vulnerability (the SRD's example, after the -5 aura)", () => {
    const defenses = { resistances: ["all"], vulnerabilities: ["fire"] };
    const { amount, notes } = adjustDamage({ amount: 28 - 5, type: "fire" }, defenses);
    expect(amount).toBe(22);
    expect(notes).toEqual([
      "Resistance to fire: 23 damage halved to 11.",
      "Vulnerability to fire: 11 damage doubled to 22.",
    ]);
  });

  it("counts several Resistances to the same damage once", () => {
    const defenses = { resistances: ["necrotic", "all"] };
    expect(adjustDamage({ amount: 20, type: "necrotic" }, defenses).amount).toBe(10);
  });

  it("'all' covers untyped damage too", () => {
    expect(adjustDamage({ amount: 7 }, { resistances: ["all"] }).amount).toBe(3);
    expect(adjustDamage({ amount: 7 }, { resistances: ["fire"] }).amount).toBe(7);
  });
});

describe("takeDamage", () => {
  const full = { hp: 20, temp: 0, max: 20 };

  it("Temporary Hit Points go first", () => {
    const r = takeDamage({ hp: 20, temp: 5, max: 20 }, [{ amount: 7 }]);
    expect([r.dealt, r.absorbed, r.temp, r.hp]).toEqual([7, 5, 0, 18]);
  });

  it("adjusts each instance for its own type", () => {
    const r = takeDamage(
      full,
      [
        { amount: 10, type: "fire" },
        { amount: 10, type: "cold" },
      ],
      {
        resistances: ["fire"],
      },
    );
    expect(r.dealt).toBe(15);
  });

  it("drops to 0, or dies of massive damage (the SRD's example)", () => {
    expect(takeDamage(full, [{ amount: 25 }])).toMatchObject({ hp: 0, dropped_to_zero: true });
    // Hit Point maximum 12, 6 Hit Points, 18 damage: 12 remains, so the character dies.
    const r = takeDamage({ hp: 6, temp: 0, max: 12 }, [{ amount: 18 }]);
    expect(r).toMatchObject({ hp: 0, died: true, dropped_to_zero: false });
  });

  it("at 0 HP, damage is a Death Saving Throw failure (two on a Critical Hit)", () => {
    const down = { hp: 0, temp: 0, max: 20 };
    expect(takeDamage(down, [{ amount: 3 }]).death_save_failures).toBe(1);
    expect(takeDamage(down, [{ amount: 3 }], {}, { critical: true }).death_save_failures).toBe(2);
    expect(takeDamage(down, [{ amount: 20 }]).died).toBe(true);
  });

  it("sets the Concentration DC: 10 or half the damage, up to 30", () => {
    expect(takeDamage(full, [{ amount: 7 }]).concentration_dc).toBe(10);
    expect(takeDamage({ hp: 99, temp: 0, max: 99 }, [{ amount: 45 }]).concentration_dc).toBe(22);
    expect(takeDamage({ hp: 99, temp: 0, max: 99 }, [{ amount: 90 }]).concentration_dc).toBe(30);
    expect(takeDamage(full, [{ amount: 0 }]).concentration_dc).toBeNull();
  });
});

describe("rollDamage", () => {
  const longsword = { dice: "1d8", bonus: 3, type: "slashing" };
  const flames = { dice: "2d6", bonus: 0, type: "fire" };

  it("rolls every part and adds the bonus once", () => {
    const r = rollDamage([longsword, flames], { rng: scriptedRng([5, 2, 6]) });
    expect(r.parts.map((p) => [p.rolls, p.total])).toEqual([
      [[5], 8],
      [[2, 6], 8],
    ]);
    expect(r.total).toBe(16);
  });

  it("a Critical Hit doubles the dice, not the bonus", () => {
    const r = rollDamage([longsword], { critical: true, rng: scriptedRng([5, 7]) });
    expect(r.parts[0]).toMatchObject({ rolls: [5, 7], total: 15 });
  });

  it("never goes below 0, and fixed damage doesn't roll", () => {
    const weak = rollDamage([{ dice: "1d4", bonus: -3, type: "piercing" }], {
      rng: scriptedRng([1]),
    });
    expect(weak.total).toBe(0);
    const fixed = rollDamage([{ dice: null, bonus: 1, type: "piercing" }], { critical: true });
    expect(fixed.parts[0]).toMatchObject({ rolls: [], total: 1 });
  });

  it("is deterministic with a seeded Rng", () => {
    const a = rollDamage([longsword, flames], { rng: seededRng(7) });
    const b = rollDamage([longsword, flames], { rng: seededRng(7) });
    expect(a).toEqual(b);
  });

  it("formats parts for display", () => {
    expect(formatDamage([longsword, flames])).toBe("1d8+3 + 2d6");
    expect(formatDamage([{ dice: "1d4", bonus: -1, type: "piercing" }])).toBe("1d4-1");
    expect(formatDamage([{ dice: null, bonus: 1, type: "piercing" }])).toBe("1");
  });
});

describe("attack lines carry their damage", () => {
  const fighter = fighterBuild(); // Str 17, Dex 14
  const withItems = (...items: [string, string?][]) => {
    let state: CharacterState = createState(fighter, catalog);
    for (const [item, base] of items) {
      state = applyAction(fighter, state, catalog, { type: "add_item", item, base }).state;
    }
    return computePlaySheet(fighter, state, catalog);
  };

  it("parts match the display string", () => {
    const sheet = withItems(["longsword"]);
    const longsword = sheet.attacks.find((a) => a.name === "Longsword");
    expect(longsword).toMatchObject({
      kind: "melee",
      damage: "1d8+3 (1d10+3 two-handed)",
      damage_parts: [{ dice: "1d8", bonus: 3, type: "slashing" }],
      two_handed_damage_parts: [{ dice: "1d10", bonus: 3, type: "slashing" }],
    });
    for (const line of sheet.attacks) {
      expect(line.damage.startsWith(formatDamage(line.damage_parts)), line.name).toBe(true);
    }
  });

  it("a Blowgun's fixed damage gets no ability modifier (SRD Damage Rolls)", () => {
    const sheet = withItems(["blowgun"], ["weapon-1", "blowgun"]);
    const [plain, magic] = sheet.attacks.filter((a) => a.name.includes("Blowgun"));
    expect(plain).toMatchObject({ kind: "ranged", damage: "1" });
    expect(plain?.damage_parts).toEqual([{ dice: null, bonus: 1, type: "piercing" }]);
    expect(magic?.damage).toBe("2"); // a +1 weapon still adds its bonus
  });
});

describe("play damage uses the same rules", () => {
  it("Petrified halves untyped damage too (Resistance to all damage)", () => {
    const fighter = fighterBuild();
    let state = createState(fighter, catalog);
    state = applyAction(fighter, state, catalog, {
      type: "add_condition",
      condition: "petrified",
    }).state;
    const r = applyAction(fighter, state, catalog, { type: "damage", amount: 7 });
    expect(r.notes).toContain("Resistance to all damage: 7 damage halved to 3.");
    expect(computePlaySheet(fighter, r.state, catalog).play.hp.current).toBe(9);
  });
});

// SRD 5.2.1 Rules Glossary, "Bloodied": "half its Hit Points or fewer remaining".
describe("Bloodied", () => {
  it("at half the maximum or fewer, 0 included", () => {
    expect([6, 5, 1, 0].map((hp) => isBloodied(hp, 10))).toEqual([false, true, true, true]);
    // An odd maximum: 3 of 7 is Bloodied, 4 isn't.
    expect([isBloodied(4, 7), isBloodied(3, 7)]).toEqual([false, true]);
  });

  it("a character's play sheet and combatant say it; Temporary Hit Points don't count", () => {
    const fighter = fighterBuild(); // 12 HP
    let state = createState(fighter, catalog);
    const bloodied = () => computePlaySheet(fighter, state, catalog).play.hp.bloodied;
    expect(bloodied()).toBe(false);
    state = applyAction(fighter, state, catalog, { type: "damage", amount: 5 }).state;
    expect(bloodied()).toBe(false); // 7 of 12
    state = applyAction(fighter, state, catalog, { type: "set_temp_hp", amount: 10 }).state;
    state = applyAction(fighter, state, catalog, { type: "damage", amount: 11 }).state;
    expect(computePlaySheet(fighter, state, catalog).play.hp).toMatchObject({
      current: 6,
      temp: 0,
      bloodied: true,
    });
    expect(combatantFromCharacter(fighter, state, catalog).bloodied).toBe(true);
    state = applyAction(fighter, state, catalog, { type: "set_temp_hp", amount: 10 }).state;
    expect(bloodied()).toBe(true);
  });

  it("a monster in an encounter: a 10 HP Goblin Warrior is Bloodied at 5, not at 6", () => {
    let e: Encounter = applyEncounterAction(
      createEncounter(),
      { type: "add_monster", monster: "goblin-warrior" },
      { catalog },
    ).encounter;
    const id = e.combatants[0]?.id as string;
    const hit = (amount: number) => {
      e = applyEncounterAction(
        e,
        { type: "effects", id, actions: [{ type: "damage", amount }] },
        { catalog },
      ).encounter;
      return encounterCombatant(e, id, { catalog }).bloodied;
    };
    expect(encounterCombatant(e, id, { catalog }).bloodied).toBe(false);
    expect(hit(4)).toBe(false);
    expect(hit(1)).toBe(true);
  });
});
