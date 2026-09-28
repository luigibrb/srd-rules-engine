/**
 * Casting a spell from the catalog: its `mechanics` against one or more combatants.
 *
 * Like `makeAttack`, casting changes nothing. The result lists what happens to each target
 * (attack or save, damage instances, healing, conditions) and the play actions that apply it:
 * `caster_actions` (spend the slot, start Concentration) and each target's `actions`.
 */

import type { SpellDef } from "../models/content";
import type { PlayAction } from "../models/state";
import {
  type Combatant,
  type CombatantSpellcasting,
  type D20Roll,
  type RollMode,
  rollD20,
  rollSavingThrow,
  type SaveResult,
} from "./combatant";
import {
  type DamageInstance,
  type DamagePart,
  type DamageResult,
  type RolledDamage,
  rollDamage,
  takeDamage,
} from "./damage";
import { parseDiceExpression } from "./dice";
import { mathRng, type Rng } from "./rng";

export interface CastOptions {
  /** The spell slot's level (default: the spell's level). Cantrips take none. */
  slot_level?: number;
  /** Spend a Pact Magic slot instead of a spell slot. */
  pact?: boolean;
  /** Which spellcasting feature to use, by source (default: the best one whose list has it). */
  spellcasting?: string;
  /** Advantage or Disadvantage on spell attack rolls. */
  mode?: RollMode;
  rng?: Rng;
}

export interface SpellAttackRoll {
  readonly roll: D20Roll;
  readonly total: number;
  readonly hit: boolean;
  readonly critical_hit: boolean;
  readonly critical_miss: boolean;
}

export interface SpellTargetResult {
  /** Index into the `targets` given to `castSpell` (several beams can hit the same one). */
  readonly target: number;
  readonly name: string;
  readonly attack: SpellAttackRoll | null;
  readonly save: SaveResult | null;
  /** Damage the target takes, before its own defenses. */
  readonly instances: readonly DamageInstance[];
  readonly critical: boolean;
  /** A preview of the damage on the target as it is now. */
  readonly outcome: DamageResult | null;
  readonly healing: number;
  readonly conditions: readonly string[];
  /** Play actions that apply all this to a character target's state. */
  readonly actions: readonly PlayAction[];
}

export interface SpellCastResult {
  readonly spell: string;
  readonly slot_level: number | null;
  /** The spellcasting feature used. */
  readonly spellcasting: string | null;
  readonly save_dc: number | null;
  readonly attack_bonus: number | null;
  /** Damage rolled once for every target (a save or an automatic hit). */
  readonly damage: RolledDamage | null;
  readonly targets: readonly SpellTargetResult[];
  /** Play actions for the caster: spend the slot, start Concentration. */
  readonly caster_actions: readonly PlayAction[];
  readonly notes: readonly string[];
}

/** Cantrip Upgrade tier: 1, then 2 at level 5, 3 at 11, 4 at 17. */
export function cantripTier(level: number): number {
  return level >= 17 ? 4 : level >= 11 ? 3 : level >= 5 ? 2 : 1;
}

/**
 * Cast `spell` at `targets` (combatants, or none for a spell without targets). Each result's
 * `target` is an index into `targets`; each damage preview is against the target as it is now.
 *
 * - A spell attack is rolled per target (per beam for Eldritch Blast), with its own damage roll
 *   and Critical Hit; a natural 1 misses and a natural 20 hits.
 * - Damage from a save (or an automatic hit) is rolled once for all targets (SRD "Damage against
 *   Multiple Targets"); on a successful save, each damage type is halved (rounded down) or
 *   ignored, per `save.on_success`.
 * - Healing is rolled once too, and each target regains it.
 *
 * Throws `RangeError` for an illegal slot level or too many targets. A spell without
 * `mechanics` is still cast (slot, Concentration), with a note that its effects are text.
 */
export function castSpell(
  caster: Combatant,
  spell: SpellDef,
  targets: readonly Combatant[],
  { slot_level, pact = false, spellcasting, mode = "normal", rng = mathRng }: CastOptions = {},
): SpellCastResult {
  if (caster.no_spells) throw new RangeError(`${caster.name} can't cast spells right now`);
  const m = spell.mechanics;
  const cantrip = spell.level === 0;
  const slot = cantrip ? null : (slot_level ?? spell.level);
  if (cantrip && slot_level !== undefined) {
    throw new RangeError(`${spell.name} is a cantrip: it doesn't use a spell slot`);
  }
  if (slot !== null && (slot < spell.level || slot > 9)) {
    throw new RangeError(`${spell.name} needs a spell slot of level ${spell.level} to 9`);
  }
  const above = slot === null ? 0 : slot - spell.level;
  const tier = cantripTier(caster.level);
  const beams = cantrip && m?.cantrip_scaling === "beams" ? tier : 1;
  const maxTargets = m?.targets == null ? null : m.targets + (m.upcast?.targets ?? 0) * above;
  if (beams > 1) {
    if (targets.length !== 1 && targets.length !== beams) {
      throw new RangeError(`${spell.name} has ${beams} beams: give 1 target or ${beams}`);
    }
  } else if (maxTargets !== null && targets.length > maxTargets) {
    throw new RangeError(`${spell.name} can target at most ${maxTargets} at this level`);
  }

  const casterActions: PlayAction[] = [];
  if (slot !== null) {
    casterActions.push(pact ? { type: "spend_pact_slot" } : { type: "spend_slot", level: slot });
  }
  if (spell.concentration) casterActions.push({ type: "set_concentration", spell: spell.name });
  const base = { spell: spell.id, slot_level: slot, caster_actions: casterActions };
  if (!m) {
    return {
      ...base,
      spellcasting: null,
      save_dc: null,
      attack_bonus: null,
      damage: null,
      targets: [],
      notes: [`${spell.name}: its effects aren't automated; see the spell's text.`],
    };
  }

  const line = pickSpellcasting(caster, spell, spellcasting);
  const needsLine = m.attack !== null || m.save !== null;
  const modifierUsed = m.damage.some((d) => d.add_modifier) || m.heal?.add_modifier === true;
  if (!line && (needsLine || modifierUsed)) {
    throw new RangeError(`${caster.name} has no spellcasting feature to cast ${spell.name}`);
  }
  const modifier = line?.modifier ?? 0;

  // Damage parts: the base dice, times the cantrip tier, plus upcast dice of the same type.
  const parts: DamagePart[] = m.damage.map((d) => {
    const { count, sides } = parseDiceExpression(d.dice);
    const scaled = cantrip && m.cantrip_scaling === "dice" ? count * tier : count;
    return { dice: `${scaled}d${sides}`, bonus: d.add_modifier ? modifier : 0, type: d.type };
  });
  for (const extra of m.upcast?.damage ?? []) {
    if (!above) break;
    const { count, sides } = parseDiceExpression(extra.dice);
    const i = parts.findIndex((p) => p.type === extra.type);
    const part = parts[i];
    if (part?.dice && parseDiceExpression(part.dice).sides === sides) {
      parts[i] = {
        ...part,
        dice: `${parseDiceExpression(part.dice).count + count * above}d${sides}`,
      };
    } else {
      parts.push({ dice: `${count * above}d${sides}`, bonus: 0, type: extra.type });
    }
  }

  // Indices into `targets`: every beam at the one target, or one entry per target.
  const aimed =
    beams > 1 && targets.length === 1 ? Array<number>(beams).fill(0) : [...targets.keys()];
  const results: SpellTargetResult[] = [];
  let shared: RolledDamage | null = null;
  const sharedDamage = () => {
    shared ??= parts.length && targets.length ? rollDamage(parts, { rng }) : null;
    return shared;
  };

  if (m.attack) {
    const bonus = line?.attack_bonus ?? 0;
    for (const index of aimed) {
      const target = targets[index] as Combatant;
      const roll = rollD20({ mode, rng });
      const critical_miss = roll.d20 === 1;
      const critical_hit = roll.d20 === 20;
      const hit = critical_hit || (!critical_miss && roll.d20 + bonus >= target.armor_class);
      const attack = { roll, total: roll.d20 + bonus, hit, critical_hit, critical_miss };
      const rolled =
        hit && parts.length ? rollDamage(parts, { critical: critical_hit, rng }) : null;
      const instances = rolled ? toInstances(rolled) : [];
      const conditions = hit ? conditionsOn(m, "hit") : [];
      const r = { attack, instances, critical: critical_hit, conditions };
      results.push(targetResult(index, target, r));
    }
  } else if (m.save) {
    const save = m.save;
    const dc = line?.save_dc ?? 0;
    const saves = targets.map((t) => rollSavingThrow(t, save.ability, dc, { rng }));
    const rolled = sharedDamage();
    targets.forEach((target, i) => {
      const result = saves[i] as SaveResult;
      let instances = rolled ? toInstances(rolled) : [];
      if (result.success) {
        instances =
          save.on_success === "half"
            ? instances.map((d) => ({ ...d, amount: Math.floor(d.amount / 2) }))
            : [];
      }
      const conditions = result.success ? [] : conditionsOn(m, "failed_save");
      results.push(targetResult(i, target, { save: result, instances, conditions }));
    });
  } else {
    const rolled = sharedDamage();
    for (const [i, target] of targets.entries()) {
      results.push(targetResult(i, target, { instances: rolled ? toInstances(rolled) : [] }));
    }
  }

  if (m.heal) {
    const healParts: DamagePart[] = [
      { dice: m.heal.dice, bonus: m.heal.add_modifier ? modifier : 0, type: "healing" },
    ];
    if (m.upcast?.heal && above) {
      const { count, sides } = parseDiceExpression(m.upcast.heal);
      healParts.push({ dice: `${count * above}d${sides}`, bonus: 0, type: "healing" });
    }
    const healing = rollDamage(healParts, { rng }).total;
    for (const [i, target] of targets.entries()) {
      const current = results[i] ?? targetResult(i, target, {});
      const actions: PlayAction[] = [...current.actions, { type: "heal", amount: healing }];
      results[i] = { ...current, healing, actions };
    }
  }

  return {
    ...base,
    spellcasting: line?.source ?? null,
    save_dc: m.save ? (line?.save_dc ?? null) : null,
    attack_bonus: m.attack ? (line?.attack_bonus ?? null) : null,
    damage: shared,
    targets: results,
    notes: [],
  };

  function targetResult(
    index: number,
    target: Combatant,
    r: {
      attack?: SpellAttackRoll;
      save?: SaveResult;
      instances?: DamageInstance[];
      critical?: boolean;
      conditions?: string[];
    },
  ): SpellTargetResult {
    const instances = r.instances ?? [];
    const critical = r.critical ?? false;
    const conditions = r.conditions ?? [];
    const outcome = instances.length
      ? takeDamage(
          { hp: target.hp, temp: target.temp_hp, max: target.max_hp },
          instances,
          target.defenses,
          { critical },
        )
      : null;
    const actions: PlayAction[] = [];
    if (instances.length) actions.push({ type: "damage", instances, critical });
    for (const condition of conditions) actions.push({ type: "add_condition", condition });
    return {
      target: index,
      name: target.name,
      attack: r.attack ?? null,
      save: r.save ?? null,
      instances,
      critical,
      outcome,
      healing: 0,
      conditions,
      actions,
    };
  }
}

/**
 * The spellcasting feature to cast with: the one named by `source`, else the best (highest
 * save DC) whose spell list includes the spell, else the best overall.
 */
function pickSpellcasting(
  caster: Combatant,
  spell: SpellDef,
  source: string | undefined,
): CombatantSpellcasting | null {
  if (source !== undefined) {
    const named = caster.spellcasting.find((s) => s.source === source);
    if (!named) throw new RangeError(`${caster.name} has no spellcasting from '${source}'`);
    return named;
  }
  const best = (lines: readonly CombatantSpellcasting[]) =>
    lines.reduce<CombatantSpellcasting | null>(
      (top, s) => (top === null || s.save_dc > top.save_dc ? s : top),
      null,
    );
  const onList = caster.spellcasting.filter((s) => s.list !== null && spell.lists.includes(s.list));
  return best(onList) ?? best(caster.spellcasting);
}

function conditionsOn(m: NonNullable<SpellDef["mechanics"]>, on: "hit" | "failed_save"): string[] {
  return m.conditions.filter((c) => c.on === on).map((c) => c.condition);
}

function toInstances(rolled: RolledDamage): DamageInstance[] {
  return rolled.parts.map((p) => ({ amount: p.total, type: p.type }));
}
