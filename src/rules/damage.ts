/**
 * Damage: rolling it and taking it (SRD 5.2.1 "Playing the Game" > "Damage and Healing").
 *
 * Pure functions shared by play (`applyAction` → `damage`) and combat (`applyDamage`), so the
 * rules for Resistance, Temporary Hit Points, dropping to 0 and death live in one place.
 */

import { parseDiceExpression, roll, signed } from "./dice";
import { mathRng, type Rng } from "./rng";

/** One part of an attack's damage: `dice` (or none, for a fixed amount) + `bonus`, of a type. */
export interface DamagePart {
  /** `1d8`, `2d6`; `null` for fixed damage (an Unarmed Strike without Martial Arts). */
  readonly dice: string | null;
  readonly bonus: number;
  readonly type: string;
}

/** `1d8+3`, `1d6-1`, `4` (fixed); several parts joined with ` + `: `1d8+3 + 2d6`. */
export function formatDamage(parts: readonly DamagePart[]): string {
  return parts
    .map((p) => {
      if (p.dice === null) return String(p.bonus);
      return p.bonus === 0 ? p.dice : `${p.dice}${signed(p.bonus)}`;
    })
    .join(" + ");
}

export interface RolledDamagePart extends DamagePart {
  readonly rolls: readonly number[];
  /** Dice + bonus, never below 0. */
  readonly total: number;
}

export interface RolledDamage {
  readonly parts: readonly RolledDamagePart[];
  readonly total: number;
  readonly critical: boolean;
}

/**
 * Roll every part. A Critical Hit rolls each part's dice twice (not the bonus). A penalty can
 * bring a part to 0 but not below (SRD "Damage Rolls").
 */
export function rollDamage(
  parts: readonly DamagePart[],
  { critical = false, rng = mathRng }: { critical?: boolean; rng?: Rng } = {},
): RolledDamage {
  const rolled = parts.map((part): RolledDamagePart => {
    if (part.dice === null) return { ...part, rolls: [], total: Math.max(0, part.bonus) };
    const { count, sides } = parseDiceExpression(part.dice);
    const result = roll(`${critical ? count * 2 : count}d${sides}`, rng);
    return { ...part, rolls: result.rolls, total: Math.max(0, result.total + part.bonus) };
  });
  return { parts: rolled, total: rolled.reduce((n, p) => n + p.total, 0), critical };
}

/** One instance of damage: an amount and its type (`null`: untyped). */
export interface DamageInstance {
  readonly amount: number;
  readonly type?: string | null;
}

/**
 * Damage types the target resists, is vulnerable to, or is immune to. `"all"` in a list means
 * every type (Petrified: Resistance to all damage).
 */
export interface Defenses {
  readonly resistances?: readonly string[];
  readonly vulnerabilities?: readonly string[];
  readonly immunities?: readonly string[];
}

/**
 * The damage an instance really deals, after Immunity, then Resistance (halved, rounded down),
 * then Vulnerability (doubled) (SRD "Order of Application"). Several Resistances to the same
 * damage count once ("No Stacking").
 */
export function adjustDamage(
  instance: DamageInstance,
  defenses: Defenses = {},
): { amount: number; notes: string[] } {
  const type = instance.type?.toLowerCase() ?? null;
  const has = (list: readonly string[] = []) =>
    list.includes("all") || (type !== null && list.includes(type));
  const label = type ?? "all damage";
  const base = Math.max(0, Math.floor(instance.amount));
  if (has(defenses.immunities)) {
    return { amount: 0, notes: base ? [`Immunity to ${label}: ${base} damage ignored.`] : [] };
  }
  let amount = base;
  const notes: string[] = [];
  if (has(defenses.resistances)) {
    amount = Math.floor(amount / 2);
    notes.push(`Resistance to ${label}: ${base} damage halved to ${amount}.`);
  }
  if (has(defenses.vulnerabilities)) {
    notes.push(`Vulnerability to ${label}: ${amount} damage doubled to ${amount * 2}.`);
    amount *= 2;
  }
  return { amount, notes };
}

/** What a creature has before taking damage. */
export interface Vitals {
  readonly hp: number;
  readonly temp: number;
  readonly max: number;
}

export interface DamageResult {
  /** Damage dealt after Immunity, Resistance and Vulnerability, before Temporary Hit Points. */
  readonly dealt: number;
  /** The part of it that Temporary Hit Points absorbed. */
  readonly absorbed: number;
  /** Hit Points and Temporary Hit Points afterwards. */
  readonly hp: number;
  readonly temp: number;
  /** Went from above 0 to 0 Hit Points without dying. */
  readonly dropped_to_zero: boolean;
  /** Died outright: massive damage, or damage at 0 HP at least the Hit Point maximum. */
  readonly died: boolean;
  /** Death Saving Throw failures to add (damage at 0 HP: 1, or 2 from a Critical Hit). */
  readonly death_save_failures: number;
  /** The Constitution save to keep Concentration, if the damage calls for one. */
  readonly concentration_dc: number | null;
  readonly notes: readonly string[];
}

/**
 * Take one or more instances of damage (SRD "Damage and Healing"): each is adjusted for the
 * target's defenses, Temporary Hit Points absorb the total first, then Hit Points drop.
 *
 * Interpretations (flagged in docs/ARCHITECTURE.md): damage fully absorbed by Temporary Hit
 * Points causes no Concentration save and no Death Saving Throw failure, and the Concentration
 * DC uses the damage that got past them.
 */
export function takeDamage(
  vitals: Vitals,
  instances: readonly DamageInstance[],
  defenses: Defenses = {},
  { critical = false }: { critical?: boolean } = {},
): DamageResult {
  const notes: string[] = [];
  let dealt = 0;
  for (const instance of instances) {
    const adjusted = adjustDamage(instance, defenses);
    dealt += adjusted.amount;
    notes.push(...adjusted.notes);
  }
  const absorbed = Math.min(vitals.temp, dealt);
  if (absorbed) notes.push(`${absorbed} absorbed by Temporary Hit Points.`);
  const rest = dealt - absorbed;
  const result = {
    dealt,
    absorbed,
    hp: vitals.hp,
    temp: vitals.temp - absorbed,
    dropped_to_zero: false,
    died: false,
    death_save_failures: 0,
    concentration_dc: rest > 0 ? Math.min(30, Math.max(10, Math.floor(rest / 2))) : null,
    notes,
  };
  if (vitals.hp === 0) {
    if (rest >= vitals.max) {
      notes.push("Damage at 0 HP equal to the Hit Point maximum: the character dies.");
      return { ...result, died: true };
    }
    if (rest > 0) {
      notes.push(
        `Damage at 0 HP: ${critical ? "two Death Saving Throw failures" : "a Death Saving Throw failure"}.`,
      );
      return { ...result, death_save_failures: critical ? 2 : 1 };
    }
    return result;
  }
  const after = vitals.hp - rest;
  if (after > 0) return { ...result, hp: after };
  if (-after >= vitals.max) {
    notes.push(
      "Massive damage: the rest of the damage equals the Hit Point maximum. The character dies.",
    );
    return { ...result, hp: 0, died: true };
  }
  return { ...result, hp: 0, dropped_to_zero: true };
}
