import { ABILITY_FULL_NAMES, type AbilityFullName, type Character } from "../models/character";
import type { SavingThrow } from "../models/combat";
import { abilityModifier, roll } from "./dice";
import { mathRng, type Rng } from "./rng";

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
