/**
 * Odds for a UI's tooltips: the chance a d20 roll hits or a save fails, and average damage. Pure
 * arithmetic over the d20 (1/20 each face; Advantage takes the better of two, Disadvantage the
 * worse) and the dice's averages; nothing is rolled.
 */

import type { RollMode } from "./combatant";
import type { DamagePart, Defenses } from "./damage";
import { parseDiceExpression } from "./dice";

/** The chance one d20 face list passes, combined for Advantage or Disadvantage. */
function withMode(p: number, mode: RollMode): number {
  if (mode === "advantage") return 1 - (1 - p) ** 2;
  if (mode === "disadvantage") return p ** 2;
  return p;
}

/**
 * An attack roll's chances (SRD "Attack Rolls"): a natural 20 always hits and is a Critical Hit
 * from `critical_on` up, a natural 1 always misses; otherwise d20 + `bonus` ≥ `ac` hits.
 * `auto_critical`: every hit is a Critical Hit (Paralyzed within 5 feet).
 */
export function attackOdds({
  bonus,
  ac,
  mode = "normal",
  critical_on = 20,
  auto_critical = false,
}: {
  bonus: number;
  ac: number;
  mode?: RollMode;
  critical_on?: number;
  auto_critical?: boolean;
}): { hit: number; critical: number } {
  let hits = 0;
  let crits = 0;
  for (let d = 1; d <= 20; d++) {
    const hit = d === 20 || (d !== 1 && d + bonus >= ac);
    if (hit) hits++;
    if (hit && (auto_critical || d >= critical_on)) crits++;
  }
  return { hit: withMode(hits / 20, mode), critical: withMode(crits / 20, mode) };
}

/** A saving throw's chance to fail: d20 + `bonus` < `dc` (no natural 1 or 20 rule for saves). */
export function failOdds({
  bonus,
  dc,
  mode = "normal",
  automatic_failure = false,
}: {
  bonus: number;
  dc: number;
  mode?: RollMode;
  automatic_failure?: boolean;
}): number {
  if (automatic_failure) return 1;
  let passes = 0;
  for (let d = 1; d <= 20; d++) if (d + bonus >= dc) passes++;
  // Advantage on a save makes passing likelier: work on the chance to pass.
  return 1 - withMode(passes / 20, mode);
}

/**
 * Average damage of `parts` against `defenses` (Immunity, Resistance halves, Vulnerability
 * doubles; averages, so the rounding down is left out); `critical` doubles the dice.
 */
export function averageDamage(
  parts: readonly DamagePart[],
  { critical = false, defenses = {} }: { critical?: boolean; defenses?: Defenses } = {},
): number {
  let total = 0;
  for (const p of parts) {
    let avg = p.bonus;
    if (p.dice) {
      const { count, sides, modifier } = parseDiceExpression(p.dice);
      avg += (critical ? 2 : 1) * count * ((sides + 1) / 2) + modifier;
    }
    avg = Math.max(0, avg);
    const type = p.type.toLowerCase();
    const has = (list?: readonly string[]) =>
      (list ?? []).some((x) => x.toLowerCase() === type || x === "all");
    if (has(defenses.immunities)) continue;
    if (has(defenses.resistances)) avg /= 2;
    if (has(defenses.vulnerabilities)) avg *= 2;
    total += avg;
  }
  return total;
}
