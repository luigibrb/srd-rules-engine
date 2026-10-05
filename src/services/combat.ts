import type { Character } from "../models/character";
import { takeDamage } from "../rules/damage";
import { abilityModifier } from "../rules/dice";

// --- hit points ---------------------------------------------------------------------------

export function isAlive(character: Character): boolean {
  return character.current_hit_points > 0;
}

/** Untyped damage to a combat snapshot (no Temporary Hit Points or defenses: see `takeDamage`). */
export function applyDamage(character: Character, damage: number): Character {
  const { hp } = takeDamage(
    { hp: character.current_hit_points, temp: 0, max: character.max_hit_points },
    [{ amount: damage }],
  );
  return { ...character, current_hit_points: hp };
}

export function applyHealing(character: Character, amount: number): Character {
  return {
    ...character,
    current_hit_points: Math.min(character.max_hit_points, character.current_hit_points + amount),
  };
}

export function passivePerception(character: Character, proficient = false): number {
  const bonus = proficient ? character.proficiency_bonus : 0;
  return 10 + abilityModifier(character.ability_scores.wisdom) + bonus;
}
