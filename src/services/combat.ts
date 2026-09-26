import type { Character } from "../models/character";
import type { AttackRoll, DamageRoll, SavingThrow } from "../models/combat";
import type { Spell } from "../models/spell";
import { attackRoll, damageRoll } from "../rules/combat";
import { abilityModifier } from "../rules/dice";
import type { Rng } from "../rules/rng";
import { castSpellAttack, castSpellDamage, castSpellSave } from "../rules/spells";

// --- hit points ---------------------------------------------------------------------------

export function isAlive(character: Character): boolean {
  return character.current_hit_points > 0;
}

export function applyDamage(character: Character, damage: number): Character {
  return { ...character, current_hit_points: Math.max(0, character.current_hit_points - damage) };
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
