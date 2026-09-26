import type { RollResult } from "../models/combat";
import { mathRng, type Rng } from "./rng";

const DICE_PATTERN = /^(\d+)d(\d+)([+-]\d+)?$/i;

/** Upper bounds that keep a single roll cheap (the HTTP API rolls user-supplied expressions). */
export const MAX_DICE = 1000;
export const MAX_SIDES = 1000;

export interface DiceExpression {
  count: number;
  sides: number;
  modifier: number;
}

/** Parse an expression like `2d6+3`. Throws `RangeError` if it is malformed or too large. */
export function parseDiceExpression(expression: string): DiceExpression {
  const match = DICE_PATTERN.exec(expression.trim());
  if (!match) throw new RangeError(`Invalid dice expression: '${expression}'`);
  const count = Number(match[1]);
  const sides = Number(match[2]);
  const modifier = match[3] ? Number(match[3]) : 0;
  if (sides < 1) throw new RangeError(`Dice need at least one side: '${expression}'`);
  if (count > MAX_DICE || sides > MAX_SIDES) {
    throw new RangeError(`At most ${MAX_DICE} dice of ${MAX_SIDES} sides: '${expression}'`);
  }
  return { count, sides, modifier };
}

export function formatDiceExpression({ count, sides, modifier }: DiceExpression): string {
  const base = `${count}d${sides}`;
  return modifier === 0 ? base : `${base}${signed(modifier)}`;
}

export function roll(expression: string, rng: Rng = mathRng): RollResult {
  const { count, sides, modifier } = parseDiceExpression(expression);
  const rolls = Array.from({ length: count }, () => rng.int(1, sides));
  return {
    dice_expression: expression,
    rolls,
    modifier,
    total: rolls.reduce((a, b) => a + b, 0) + modifier,
  };
}

export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function proficiencyBonus(level: number): number {
  return Math.floor((level - 1) / 4) + 2;
}

/** `+2`, `-1`, `+0`. */
export function signed(n: number): string {
  return n < 0 ? `${n}` : `+${n}`;
}
