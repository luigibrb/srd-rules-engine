import type { Character } from "../models/character";
import type { AttackRoll, DamageRoll, SavingThrow } from "../models/combat";
import type { Spell } from "../models/spell";
import { abilityScore, attackRoll, damageRoll, savingThrow } from "./combat";
import { abilityModifier } from "./dice";
import { mathRng, type Rng } from "./rng";

/**
 * @deprecated Cast catalog spells with `castSpell` (combatants, `mechanics`). Kept until 1.0.
 */
export function spellSaveDc(caster: Character, spellcastingAbility: string): number {
  return 8 + caster.proficiency_bonus + abilityModifier(abilityScore(caster, spellcastingAbility));
}

/**
 * @deprecated Cast catalog spells with `castSpell` (combatants, `mechanics`). Kept until 1.0.
 */
export function spellAttackBonus(caster: Character, spellcastingAbility: string): number {
  return caster.proficiency_bonus + abilityModifier(abilityScore(caster, spellcastingAbility));
}

/**
 * @deprecated Cast catalog spells with `castSpell` (combatants, `mechanics`). Kept until 1.0.
 */
export function castSpellAttack(
  caster: Character,
  target: Character,
  _spell: Spell,
  spellcastingAbility: string,
  { rng = mathRng }: { rng?: Rng } = {},
): AttackRoll {
  return attackRoll(caster, target, spellAttackBonus(caster, spellcastingAbility), { rng });
}

/**
 * @deprecated Cast catalog spells with `castSpell` (combatants, `mechanics`). Kept until 1.0.
 */
export function castSpellSave(
  caster: Character,
  target: Character,
  spell: Spell,
  spellcastingAbility: string,
  { rng = mathRng }: { rng?: Rng } = {},
): SavingThrow {
  const dc = spellSaveDc(caster, spellcastingAbility);
  return savingThrow(target, spell.save_ability ?? "dexterity", dc, { rng });
}

/**
 * @deprecated Cast catalog spells with `castSpell` (combatants, `mechanics`). Kept until 1.0.
 */
export function castSpellDamage(
  spell: Spell,
  { critical = false, rng = mathRng }: { critical?: boolean; rng?: Rng } = {},
): DamageRoll | null {
  if (!spell.damage_dice || !spell.damage_type) return null;
  return damageRoll(spell.damage_dice, spell.damage_type, { critical, rng });
}
