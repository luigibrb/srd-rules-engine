/**
 * When things in an encounter end: the count-down of effects, marks, mastery effects and zones at
 * the start or end of a creature's turn, and what the sweep after every action ends (a source or
 * target gone, Concentration lost, a grappler Incapacitated, a hidden creature seen). Pure: the
 * functions take plain facts and say what ends and why; `applyEncounterAction` applies it.
 */

/** When something ends: at the start or end of `of`'s turn, after `count` of them. */
export interface Ending {
  readonly at: "start" | "end";
  readonly of: string;
  readonly count: number;
  /** The turn it was made in doesn't count (an effect "until the end of your next turn"). */
  readonly skip_current: boolean;
}

/**
 * The start or end (`at`) of `of`'s turn, for items that end then: each one's count goes down
 * (or its first skip is used up). `items` comes back in order with the updated endings; `expired`
 * lists the ones whose count reached 0.
 */
export function countDown<T extends { readonly ends: Ending | null }>(
  items: readonly T[],
  at: "start" | "end",
  of: string,
): { items: T[]; expired: T[] } {
  const expired: T[] = [];
  const updated = items.map((item) => {
    const ends = item.ends;
    if (!ends || ends.at !== at || ends.of !== of) return item;
    if (ends.skip_current) return { ...item, ends: { ...ends, skip_current: false } };
    const next = { ...item, ends: { ...ends, count: ends.count - 1 } };
    if (next.ends.count <= 0) expired.push(next);
    return next;
  });
  return { items: updated, expired };
}

/** What the sweep needs to know about a combatant. */
export interface SweepCombatant {
  readonly id: string;
  /** Hidden (Hide), and whether its Invisible condition from hiding is still there. */
  readonly hidden: boolean;
  readonly hidden_effect: boolean;
  /** The spell a readied cast holds (its name), if any. */
  readonly holding: string | null;
  /** The spell it concentrates on (its name), or `null`. */
  readonly concentration: string | null;
  readonly conditions: ReadonlySet<string>;
  /** Defeated, dead or dying: out of the fight. */
  readonly out: boolean;
}

/** An effect, as the sweep sees it. */
export interface SweepEffect {
  readonly id: string;
  readonly target: string;
  readonly source: string | null;
  readonly condition: string;
  readonly label: string;
  readonly concentration: boolean;
  readonly ends_on: readonly string[];
}

export type SweepReason =
  | { readonly why: "target_left" }
  | { readonly why: "source_left" }
  | { readonly why: "source_incapacitated"; readonly name: string }
  | { readonly why: "concentration_ended" }
  | { readonly why: "caster_left" };

/** What the sweep after an action ends, in the order the reducer applies it. */
export interface SweepOutcome {
  /** Per combatant, in order: no longer hidden; a held spell that dissipates. */
  readonly combatants: readonly {
    readonly id: string;
    readonly unhide: boolean;
    readonly dissipates: string | null;
  }[];
  /** Mastery effects and marks that stay (by index in the given lists). */
  readonly masteries: readonly number[];
  readonly marks: readonly number[];
  /** Zones that end, with why. */
  readonly zones: readonly { readonly id: string; readonly reason: SweepReason }[];
}

/**
 * After every action: what ends because something changed. A creature no longer has its
 * Invisible condition from hiding; a readied spell's Concentration broke ("the spell dissipates");
 * a mastery effect's creatures or a mark's target left, or the Concentration a mark (Hunter's Mark)
 * or a zone needs ended. Effects are judged one at a time (`effectEnding`): ending one can remove
 * a condition the next one depends on.
 */
export function sweepOutcome(facts: {
  readonly combatants: readonly SweepCombatant[];
  readonly masteries: readonly { readonly by: string; readonly on: string }[];
  readonly marks: readonly {
    readonly by: string;
    readonly on: string;
    readonly kind: string;
    readonly label: string;
  }[];
  readonly zones: readonly {
    readonly id: string;
    readonly by: string;
    readonly label: string;
    readonly concentration: boolean;
  }[];
}): SweepOutcome {
  const byId = new Map(facts.combatants.map((c) => [c.id, c]));
  const present = (id: string) => byId.has(id);
  const combatants = facts.combatants.map((c) => ({
    id: c.id,
    unhide: c.hidden && !c.hidden_effect,
    dissipates: c.holding !== null && c.concentration !== c.holding ? c.holding : null,
  }));
  const masteries = facts.masteries.flatMap((m, i) => (present(m.by) && present(m.on) ? [i] : []));
  // A spell's mark stays when its caster leaves (the light is on the target); a mark tied to
  // Concentration (Hunter's Mark) ends with it.
  const marks = facts.marks.flatMap((m, i) => {
    if (!present(m.on)) return [];
    if (m.kind !== "quarry") return [i];
    return byId.get(m.by)?.concentration === m.label ? [i] : [];
  });
  const zones: { id: string; reason: SweepReason }[] = [];
  for (const z of facts.zones) {
    if (!z.concentration) continue;
    const source = byId.get(z.by);
    if (!source) zones.push({ id: z.id, reason: { why: "caster_left" } });
    else if (source.concentration !== z.label) {
      zones.push({ id: z.id, reason: { why: "concentration_ended" } });
    }
  }
  return { combatants, masteries, marks, zones };
}

/**
 * Whether an effect ends now, given its target and source as they are (`undefined`: gone):
 * `forget` when its condition went some other way (a rest, `remove_condition`), else the reason
 * it ends, or `null` when it lasts. Its target or source left; its grappler is Incapacitated (SRD
 * "Grappling"), or a source that ends it when Incapacitated is (Turn Undead); its Concentration
 * ended.
 */
export function effectEnding(
  effect: SweepEffect,
  target: SweepCombatant | undefined,
  source: SweepCombatant | undefined,
): SweepReason | { readonly why: "forget" } | null {
  if (!target) return { why: "target_left" };
  if (!target.conditions.has(effect.condition)) return { why: "forget" };
  if (effect.source && !source) return { why: "source_left" };
  if (effect.condition === "grappled" && source?.conditions.has("incapacitated")) {
    return { why: "source_incapacitated", name: source.id };
  }
  if (
    effect.ends_on.includes("source_incapacitated") &&
    source &&
    (source.conditions.has("incapacitated") || source.out)
  ) {
    return { why: "source_incapacitated", name: source.id };
  }
  if (effect.concentration && source && source.concentration !== effect.label) {
    return { why: "concentration_ended" };
  }
  return null;
}

/** What ends a summoned creature, as the sweep sees it. */
export interface SummonFacts {
  readonly ends: readonly ("zero_hp" | "spell" | "caster_dies")[];
  /** It lasts while its caster concentrates on `label`. */
  readonly concentration: boolean;
  readonly label: string;
  /** At 0 Hit Points (defeated). */
  readonly down: boolean;
}

export type SummonReason =
  | { readonly why: "dropped_to_zero" }
  | { readonly why: "concentration_ended" }
  | { readonly why: "caster_left" }
  | { readonly why: "caster_died" };

/**
 * Whether a summoned creature disappears now: it dropped to 0 Hit Points ("disappears when it
 * drops to 0 Hit Points"), its spell's Concentration ended (or its caster left the encounter), or
 * its caster died (Find Steed). `caster` is `undefined` when the caster isn't in the encounter.
 */
export function summonEnding(
  summon: SummonFacts,
  caster: SweepCombatant | undefined,
): SummonReason | null {
  if (summon.ends.includes("zero_hp") && summon.down) return { why: "dropped_to_zero" };
  if (summon.ends.includes("spell") && summon.concentration) {
    if (!caster) return { why: "caster_left" };
    if (caster.concentration !== summon.label) return { why: "concentration_ended" };
  }
  if (summon.ends.includes("caster_dies") && caster?.out) return { why: "caster_died" };
  return null;
}
