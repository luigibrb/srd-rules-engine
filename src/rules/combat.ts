import { ABILITY_FULL_NAMES, type AbilityFullName, type Character } from "../models/character";
import type { AttackRoll, DamageRoll, SavingThrow } from "../models/combat";
import { abilityModifier, formatDiceExpression, parseDiceExpression, roll } from "./dice";
import { mathRng, type Rng } from "./rng";

/** A natural 20 always hits (and crits); a natural 1 always misses. */
export function attackRoll(
  attacker: Character,
  target: Character,
  attackBonus: number,
  { rng = mathRng }: { rng?: Rng } = {},
): AttackRoll {
  const result = roll("1d20", rng);
  const d20 = result.rolls[0] as number;
  const total = d20 + attackBonus;
  return {
    attacker_name: attacker.name,
    target_name: target.name,
    attack_bonus: attackBonus,
    target_ac: target.armor_class,
    roll: result,
    hit: d20 === 20 || (d20 !== 1 && total >= target.armor_class),
    critical_hit: d20 === 20,
    critical_miss: d20 === 1,
  };
}

/** Roll damage. A critical hit doubles every die (not the modifier). */
export function damageRoll(
  diceExpression: string,
  damageType: string,
  { critical = false, rng = mathRng }: { critical?: boolean; rng?: Rng } = {},
): DamageRoll {
  const expr = critical ? doubleDice(diceExpression) : diceExpression;
  return { dice_expression: expr, roll: roll(expr, rng), damage_type: damageType };
}

export function abilityScore(character: Character, ability: string): number {
  const key = ability.toLowerCase();
  if (!(ABILITY_FULL_NAMES as readonly string[]).includes(key)) {
    throw new RangeError(`Unknown ability '${ability}'`);
  }
  return character.ability_scores[key as AbilityFullName];
}

export function savingThrow(
  character: Character,
  ability: string,
  dc: number,
  { proficient = false, rng = mathRng }: { proficient?: boolean; rng?: Rng } = {},
): SavingThrow {
  let bonus = abilityModifier(abilityScore(character, ability));
  if (proficient) bonus += character.proficiency_bonus;
  const result = roll("1d20", rng);
  return {
    character_name: character.name,
    ability,
    dc,
    bonus,
    roll: result,
    success: result.total + bonus >= dc,
  };
}

function doubleDice(expression: string): string {
  const parsed = parseDiceExpression(expression);
  return formatDiceExpression({ ...parsed, count: parsed.count * 2 });
}
