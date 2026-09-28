import type { Character } from "../models/character";
import type { AttackRoll, DamageRoll, SavingThrow } from "../models/combat";
import type { Spell } from "../models/spell";
import { attackRoll, damageRoll } from "../rules/combat";
import { takeDamage } from "../rules/damage";
import { abilityModifier } from "../rules/dice";
import type { Rng } from "../rules/rng";
import { castSpellAttack, castSpellDamage, castSpellSave } from "../rules/spells";

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

// --- attacks and spells -------------------------------------------------------------------

export interface AttackOutcome {
  readonly attack: AttackRoll;
  readonly damage: DamageRoll | null;
  /** The target after damage was applied. */
  readonly target: Character;
}

export interface SaveOutcome {
  readonly save: SavingThrow;
  readonly damage: DamageRoll | null;
  /** Damage actually applied: half (rounded down) on a successful save. */
  readonly damage_dealt: number;
  readonly target: Character;
}

/**
 * @deprecated Use `makeAttack` with combatants (`combatantFromCharacter`, or
 * `combatantFromSnapshot` for a `Character`): it takes the attack from the sheet's attack lines
 * and applies Resistance and Temporary Hit Points. Kept until 1.0.
 */
export function resolveAttack(
  attacker: Character,
  target: Character,
  attackBonus: number,
  damageDice: string,
  damageType: string,
  { rng }: { rng?: Rng } = {},
): AttackOutcome {
  const attack = attackRoll(attacker, target, attackBonus, { rng });
  if (!attack.hit) return { attack, damage: null, target };
  const damage = damageRoll(damageDice, damageType, { critical: attack.critical_hit, rng });
  return { attack, damage, target: applyDamage(target, damage.roll.total) };
}

export function resolveSpellAttack(
  caster: Character,
  target: Character,
  spell: Spell,
  spellcastingAbility: string,
  { rng }: { rng?: Rng } = {},
): AttackOutcome {
  const attack = castSpellAttack(caster, target, spell, spellcastingAbility, { rng });
  if (!attack.hit) return { attack, damage: null, target };
  const damage = castSpellDamage(spell, { critical: attack.critical_hit, rng });
  return { attack, damage, target: damage ? applyDamage(target, damage.roll.total) : target };
}

export function resolveSpellSave(
  caster: Character,
  target: Character,
  spell: Spell,
  spellcastingAbility: string,
  { rng }: { rng?: Rng } = {},
): SaveOutcome {
  const save = castSpellSave(caster, target, spell, spellcastingAbility, { rng });
  const damage = castSpellDamage(spell, { rng });
  if (damage === null) return { save, damage: null, damage_dealt: 0, target };
  // Half damage on a successful save (standard 5e rule).
  const dealt = save.success ? Math.floor(damage.roll.total / 2) : damage.roll.total;
  return { save, damage, damage_dealt: dealt, target: applyDamage(target, dealt) };
}
