/**
 * Combatants: what combat needs to know about a creature, whatever it comes from (a character's
 * build and play state, the old `Character` snapshot, and later a monster stat block).
 *
 * A combatant is a read-only view. Resolving an attack doesn't change anything: it returns the
 * rolls and the damage instances, and the caller applies them to the target's own state (for a
 * character, the play action `{ type: "damage", instances, critical }`).
 */

import type { Character } from "../models/character";
import { ABILITIES, type Ability, type AdvantageTarget, DAMAGE_TYPES } from "../models/content";
import {
  type DamageInstance,
  type DamagePart,
  type DamageResult,
  type Defenses,
  type RolledDamage,
  rollDamage,
  takeDamage,
} from "./damage";
import { abilityModifier } from "./dice";
import { mathRng, type Rng } from "./rng";
import type { AttackLine } from "./sheet";

export const ROLL_MODES = ["normal", "advantage", "disadvantage"] as const;
export type RollMode = (typeof ROLL_MODES)[number];

/** A way the combatant casts spells: the list it covers, its save DC and attack bonus. */
export interface CombatantSpellcasting {
  /** `Wizard`, `Magic Initiate`… */
  readonly source: string;
  /** Spell list id, or `null` for a fixed set of spells. */
  readonly list: string | null;
  readonly ability: Ability;
  readonly save_dc: number;
  readonly attack_bonus: number;
  /** The spellcasting ability modifier (added by Cure Wounds and similar). */
  readonly modifier: number;
}

export interface Combatant {
  readonly name: string;
  /** Character level (cantrip damage grows at 5, 11 and 17). */
  readonly level: number;
  readonly armor_class: number;
  readonly hp: number;
  readonly temp_hp: number;
  readonly max_hp: number;
  readonly proficiency_bonus: number;
  readonly modifiers: Readonly<Record<Ability, number>>;
  /** Saving throw bonuses (proficiency and penalties such as Exhaustion included). */
  readonly saving_throws: Readonly<Record<Ability, number>>;
  readonly defenses: Readonly<Required<Defenses>>;
  /** Active condition ids, implied ones included. */
  readonly conditions: readonly string[];
  readonly attacks: readonly AttackLine[];
  /** The lowest d20 roll that's a Critical Hit with these attacks (20; 19 for a Champion). */
  readonly critical_hit_on: number;
  readonly attacks_per_action: number;
  readonly spellcasting: readonly CombatantSpellcasting[];
  /** Advantage on saving throws or checks (`save.str` while raging). */
  readonly advantages: readonly AdvantageTarget[];
  /** Can't cast spells or concentrate (Rage). */
  readonly no_spells: boolean;
}

export interface D20Roll {
  /** One die, or two with Advantage or Disadvantage. */
  readonly rolls: readonly number[];
  /** The die that counts. */
  readonly d20: number;
  readonly mode: RollMode;
}

/** Roll a d20 for a D20 Test: two dice and the higher (Advantage) or lower (Disadvantage). */
export function rollD20({
  mode = "normal",
  rng = mathRng,
}: {
  mode?: RollMode;
  rng?: Rng;
} = {}): D20Roll {
  if (mode === "normal") {
    const d20 = rng.int(1, 20);
    return { rolls: [d20], d20, mode };
  }
  const rolls = [rng.int(1, 20), rng.int(1, 20)];
  const d20 = mode === "advantage" ? Math.max(...rolls) : Math.min(...rolls);
  return { rolls, d20, mode };
}

export interface AttackResult {
  readonly attacker: string;
  readonly target: string;
  /** The attack line used. */
  readonly attack: string;
  readonly attack_bonus: number;
  readonly target_ac: number;
  readonly roll: D20Roll;
  readonly total: number;
  readonly hit: boolean;
  readonly critical_hit: boolean;
  /** A natural 1: the attack misses whatever the total. */
  readonly critical_miss: boolean;
  /** The damage rolled on a hit. */
  readonly damage: RolledDamage | null;
  /** Names of the riders added to the damage. */
  readonly riders: readonly string[];
  /** What the target takes, before its own defenses (the play action's `instances`). */
  readonly instances: readonly DamageInstance[];
  /** The damage applied to the target as it is now (a preview; nothing is changed). */
  readonly outcome: DamageResult | null;
}

export interface AttackOptions {
  rng?: Rng;
  mode?: RollMode;
  /** Wield a Versatile weapon with two hands. */
  two_handed?: boolean;
  /**
   * Riders of the attack line to add on a hit (by id or name), with the damage type when there's
   * a choice: `[{ rider: "sneak-attack" }, { rider: "divine-strike", type: "radiant" }]`.
   * Once-per-turn limits are the caller's to track (turns come with encounters).
   */
  riders?: readonly { rider: string; type?: string }[];
  /** An ally is within 5 feet of the target and not Incapacitated (Sneak Attack without Advantage). */
  ally_adjacent?: boolean;
}

/**
 * Make one attack with one of the attacker's attack lines (by name, or the line itself).
 *
 * A natural 1 always misses. A roll of `critical_hit_on` or more (a natural 20, or 19 with
 * Improved Critical) is a Critical Hit, which hits regardless of the target's AC (SRD "Critical
 * Hit") and rolls the damage dice twice.
 */
export function makeAttack(
  attacker: Combatant,
  attack: string | AttackLine,
  target: Combatant,
  {
    rng = mathRng,
    mode = "normal",
    two_handed = false,
    riders = [],
    ally_adjacent = false,
  }: AttackOptions = {},
): AttackResult {
  const line =
    typeof attack === "string" ? attacker.attacks.find((a) => a.name === attack) : attack;
  if (!line) {
    const known = attacker.attacks.map((a) => a.name).join(", ");
    throw new RangeError(`${attacker.name} has no attack '${String(attack)}' (${known})`);
  }
  // Check the riders before rolling, so a refused request rolls nothing.
  const extra: DamagePart[] = [];
  const riderNames: string[] = [];
  for (const request of riders) {
    const rider = line.riders.find((r) => r.id === request.rider || r.name === request.rider);
    if (!rider) throw new RangeError(`${line.name} has no rider '${request.rider}'`);
    if (rider.requires === "advantage_or_ally") {
      const ok = mode === "advantage" || (ally_adjacent && mode !== "disadvantage");
      if (!ok) {
        throw new RangeError(
          `${rider.name} needs Advantage, or an ally next to the target and no Disadvantage`,
        );
      }
    }
    let type: string;
    if (typeof rider.type === "string") type = rider.type;
    else {
      const choice = request.type?.toLowerCase();
      if (!choice || !rider.type.includes(choice)) {
        throw new RangeError(`${rider.name}: choose a damage type (${rider.type.join(", ")})`);
      }
      type = choice;
    }
    if (!(DAMAGE_TYPES as readonly string[]).includes(type)) {
      throw new RangeError(`${rider.name}: unknown damage type '${type}'`);
    }
    extra.push({ dice: rider.dice, bonus: rider.bonus, type });
    riderNames.push(rider.name);
  }
  const roll = rollD20({ mode, rng });
  const total = roll.d20 + line.attack_bonus;
  const critical_miss = roll.d20 === 1;
  const critical_hit = !critical_miss && roll.d20 >= Math.min(20, attacker.critical_hit_on);
  const hit = critical_hit || (!critical_miss && total >= target.armor_class);
  const base = {
    attacker: attacker.name,
    target: target.name,
    attack: line.name,
    attack_bonus: line.attack_bonus,
    target_ac: target.armor_class,
    roll,
    total,
    hit,
    critical_hit,
    critical_miss,
  };
  if (!hit) return { ...base, damage: null, riders: [], instances: [], outcome: null };
  const parts = [
    ...(two_handed && line.two_handed_damage_parts
      ? line.two_handed_damage_parts
      : line.damage_parts),
    ...extra,
  ];
  const damage = rollDamage(parts, { critical: critical_hit, rng });
  const instances = damage.parts.map((p) => ({ amount: p.total, type: p.type }));
  const outcome = takeDamage(
    { hp: target.hp, temp: target.temp_hp, max: target.max_hp },
    instances,
    target.defenses,
    { critical: critical_hit },
  );
  return { ...base, damage, riders: riderNames, instances, outcome };
}

export interface SaveResult {
  readonly name: string;
  readonly ability: Ability;
  readonly dc: number;
  readonly bonus: number;
  readonly roll: D20Roll;
  readonly total: number;
  readonly success: boolean;
}

/** A saving throw against a DC. Unlike attacks, a natural 20 or 1 has no special effect. */
export function rollSavingThrow(
  combatant: Combatant,
  ability: Ability,
  dc: number,
  { rng = mathRng, mode = "normal" }: { rng?: Rng; mode?: RollMode } = {},
): SaveResult {
  const bonus = combatant.saving_throws[ability];
  // Advantage from the combatant (Rage: Strength saves) combines with the one asked for.
  const roll = rollD20({
    mode: combineModes(mode, combatant.advantages.includes(`save.${ability}`)),
    rng,
  });
  const total = roll.d20 + bonus;
  return { name: combatant.name, ability, dc, bonus, roll, total, success: total >= dc };
}

/** Advantage and Disadvantage cancel; several of either count once (SRD "Advantage"). */
export function combineModes(mode: RollMode, advantage: boolean): RollMode {
  if (!advantage) return mode;
  return mode === "disadvantage" ? "normal" : "advantage";
}

const FULL_NAMES = {
  str: "strength",
  dex: "dexterity",
  con: "constitution",
  int: "intelligence",
  wis: "wisdom",
  cha: "charisma",
} as const satisfies Record<Ability, keyof Character["ability_scores"]>;

/**
 * A combatant from the old hand-filled `Character` snapshot: no attacks (pass an `AttackLine`
 * to `makeAttack`), no spellcasting, no saving throw proficiencies, no Temporary Hit Points or
 * defenses.
 */
export function combatantFromSnapshot(character: Character): Combatant {
  const modifiers = Object.fromEntries(
    ABILITIES.map((a) => [a, abilityModifier(character.ability_scores[FULL_NAMES[a]])]),
  ) as Record<Ability, number>;
  return {
    name: character.name,
    level: character.level,
    armor_class: character.armor_class,
    hp: character.current_hit_points,
    temp_hp: 0,
    max_hp: character.max_hit_points,
    proficiency_bonus: character.proficiency_bonus,
    modifiers,
    saving_throws: modifiers,
    defenses: { resistances: [], vulnerabilities: [], immunities: [] },
    conditions: [],
    attacks: [],
    critical_hit_on: 20,
    attacks_per_action: 1,
    spellcasting: [],
    advantages: [],
    no_spells: false,
  };
}
