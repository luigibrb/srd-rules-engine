import { describe, expect, it } from "vitest";
import {
  abilityModifier,
  parseDiceExpression,
  proficiencyBonus,
  roll,
  seededRng,
} from "../src/index";

describe("parseDiceExpression", () => {
  it("parses basic expressions", () => {
    expect(parseDiceExpression("2d6")).toEqual({ count: 2, sides: 6, modifier: 0 });
  });
  it("parses a positive modifier", () => {
    expect(parseDiceExpression("1d20+5")).toEqual({ count: 1, sides: 20, modifier: 5 });
  });
  it("parses a negative modifier", () => {
    expect(parseDiceExpression("1d8-2")).toEqual({ count: 1, sides: 8, modifier: -2 });
  });
  it("is case-insensitive and trims", () => {
    expect(parseDiceExpression(" 3D4 ")).toEqual({ count: 3, sides: 4, modifier: 0 });
  });
  it.each(["invalid", "d6", "2d", "1d0", "2d6+", "1001d6", "1d1001"])("rejects %s", (expr) => {
    expect(() => parseDiceExpression(expr)).toThrow(RangeError);
  });
});

describe("roll", () => {
  it("stays in range", () => {
    const result = roll("4d6", seededRng(42));
    expect(result.rolls).toHaveLength(4);
    expect(result.rolls.every((r) => r >= 1 && r <= 6)).toBe(true);
    expect(result.total).toBe(result.rolls.reduce((a, b) => a + b, 0));
  });
  it("adds the modifier", () => {
    const result = roll("1d20+5", seededRng(0));
    expect(result.modifier).toBe(5);
    expect(result.total).toBe((result.rolls[0] as number) + 5);
  });
  it("is deterministic with a seed", () => {
    expect(roll("10d20", seededRng(7)).rolls).toEqual(roll("10d20", seededRng(7)).rolls);
  });
  it("covers every face", () => {
    const rng = seededRng(1);
    const faces = new Set(Array.from({ length: 600 }, () => rng.int(1, 6)));
    expect([...faces].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

it.each([
  [10, 0],
  [11, 0],
  [12, 1],
  [8, -1],
  [9, -1],
  [20, 5],
  [1, -5],
])("abilityModifier(%i) = %i", (score, expected) => {
  expect(abilityModifier(score)).toBe(expected);
});

it.each([
  [1, 2],
  [4, 2],
  [5, 3],
  [8, 3],
  [9, 4],
  [17, 6],
  [20, 6],
])("proficiencyBonus(%i) = %i", (level, expected) => {
  expect(proficiencyBonus(level)).toBe(expected);
});
