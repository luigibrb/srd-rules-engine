import { describe, expect, it } from "vitest";
import {
  applyDamage,
  applyHealing,
  attackRoll,
  type Character,
  CharacterSchema,
  castSpellSave,
  damageRoll,
  fixedRng,
  isAlive,
  passivePerception,
  resolveAttack,
  resolveSpellSave,
  SpellSchema,
  savingThrow,
  scriptedRng,
  seededRng,
  spellAttackBonus,
  spellSaveDc,
} from "../src/index";

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return CharacterSchema.parse({
    name: "Test",
    character_class: "fighter",
    level: 5,
    ability_scores: {
      strength: 16,
      dexterity: 14,
      constitution: 15,
      intelligence: 10,
      wisdom: 12,
      charisma: 8,
    },
    max_hit_points: 44,
    current_hit_points: 44,
    armor_class: 16,
    proficiency_bonus: 3,
    ...overrides,
  });
}

describe("attacks", () => {
  it("a natural 20 is a critical hit", () => {
    const result = attackRoll(makeCharacter(), makeCharacter(), 5, { rng: fixedRng(20) });
    expect(result.critical_hit).toBe(true);
    expect(result.hit).toBe(true);
  });

  it("a natural 1 always misses", () => {
    const target = makeCharacter({ armor_class: 1 });
    const result = attackRoll(makeCharacter(), target, 99, { rng: fixedRng(1) });
    expect(result.critical_miss).toBe(true);
    expect(result.hit).toBe(false);
  });

  it("a natural 20 hits any AC", () => {
    const target = makeCharacter({ armor_class: 40 });
    expect(attackRoll(makeCharacter(), target, 0, { rng: fixedRng(20) }).hit).toBe(true);
  });

  it("a critical hit doubles all dice", () => {
    const normal = damageRoll("2d6", "slashing", { rng: seededRng(0) });
    expect(normal.dice_expression).toBe("2d6");
    const crit = damageRoll("2d6+3", "slashing", { critical: true, rng: seededRng(0) });
    expect(crit.dice_expression).toBe("4d6+3");
    expect(crit.roll.rolls).toHaveLength(4);
  });

  it("a miss deals no damage", () => {
    const target = makeCharacter({ name: "T", armor_class: 30 });
    const out = resolveAttack(makeCharacter(), target, 0, "1d6", "slashing", { rng: fixedRng(1) });
    expect(out.attack.hit).toBe(false);
    expect(out.damage).toBeNull();
    expect(out.target.current_hit_points).toBe(target.current_hit_points);
  });

  it("a hit applies damage to the target", () => {
    const target = makeCharacter({ armor_class: 10 });
    const rng = scriptedRng([15, 4]); // d20, then 1d6
    const out = resolveAttack(makeCharacter(), target, 5, "1d6+2", "slashing", { rng });
    expect(out.damage?.roll.total).toBe(6);
    expect(out.target.current_hit_points).toBe(38);
  });
});

describe("saving throws", () => {
  it("succeeds when the total meets the DC", () => {
    const result = savingThrow(makeCharacter(), "dexterity", 15, { rng: fixedRng(20) });
    expect(result.success).toBe(true);
  });

  it("adds proficiency when proficient", () => {
    const result = savingThrow(makeCharacter(), "Strength", 10, {
      proficient: true,
      rng: fixedRng(5),
    });
    expect(result.bonus).toBe(3 + 3);
  });

  it("rejects unknown abilities", () => {
    expect(() => savingThrow(makeCharacter(), "constructor", 10)).toThrow(/Unknown ability/);
  });
});

describe("hit points", () => {
  it("damage clamps to zero", () => {
    expect(applyDamage(makeCharacter({ current_hit_points: 5 }), 100).current_hit_points).toBe(0);
  });
  it("healing clamps to max", () => {
    const char = makeCharacter({ current_hit_points: 10, max_hit_points: 44 });
    expect(applyHealing(char, 100).current_hit_points).toBe(44);
  });
  it("is alive above 0 HP", () => {
    expect(isAlive(makeCharacter({ current_hit_points: 1 }))).toBe(true);
    expect(isAlive(makeCharacter({ current_hit_points: 0 }))).toBe(false);
  });
  it("passive perception", () => {
    expect(passivePerception(makeCharacter())).toBe(11);
    expect(passivePerception(makeCharacter(), true)).toBe(14);
  });
});

describe("spells", () => {
  const fireball = SpellSchema.parse({
    name: "Fireball",
    level: 3,
    school: "evocation",
    casting_time: "Action",
    range: "150 feet",
    duration: "Instantaneous",
    damage_dice: "8d6",
    damage_type: "fire",
    save_ability: "Dexterity",
  });
  const wizard = makeCharacter({
    character_class: "wizard",
    ability_scores: { ...makeCharacter().ability_scores, intelligence: 18 },
  });

  it("save DC and attack bonus", () => {
    expect(spellSaveDc(wizard, "intelligence")).toBe(8 + 3 + 4);
    expect(spellAttackBonus(wizard, "intelligence")).toBe(3 + 4);
  });

  it("uses the spell's save ability", () => {
    const save = castSpellSave(wizard, makeCharacter(), fireball, "intelligence", {
      rng: fixedRng(10),
    });
    expect(save.ability).toBe("dexterity");
  });

  it("half damage on a successful save, rounded down", () => {
    // d20 = 20 (save succeeds), then eight d6 = 3 each → 24 → 12.
    const rng = scriptedRng([20, 3, 3, 3, 3, 3, 3, 3, 3]);
    const out = resolveSpellSave(wizard, makeCharacter(), fireball, "intelligence", { rng });
    expect(out.save.success).toBe(true);
    expect(out.damage?.roll.total).toBe(24);
    expect(out.damage_dealt).toBe(12);
    expect(out.target.current_hit_points).toBe(32);
  });

  it("full damage on a failed save", () => {
    const rng = scriptedRng([1, 3, 3, 3, 3, 3, 3, 3, 3]);
    const out = resolveSpellSave(wizard, makeCharacter(), fireball, "intelligence", { rng });
    expect(out.save.success).toBe(false);
    expect(out.damage_dealt).toBe(24);
  });
});
