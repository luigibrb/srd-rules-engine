/**
 * Combatants: what combat needs to know about a creature, whatever it comes from (a character's
 * build and play state, a monster stat block, the old `Character` snapshot).
 *
 * A combatant is a read-only view. Resolving an attack doesn't change anything: it returns the
 * rolls and the damage instances, and the caller applies them to the target's own state (for a
 * character, the play action `{ type: "damage", instances, critical }`).
 */

import type { Table } from "../content/catalog";
import type { Character } from "../models/character";
import {
  ABILITIES,
  type Ability,
  type AdvantageTarget,
  type ConditionDef,
  DAMAGE_TYPES,
  type MonsterDamage,
  type MonsterDef,
  SKILL_ABILITY,
  type Skill,
} from "../models/content";
import {
  type DamageInstance,
  type DamagePart,
  type DamageResult,
  type Defenses,
  formatDamage,
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
  /** Ability check bonuses without a skill. */
  readonly ability_checks: Readonly<Record<Ability, number>>;
  /** Skill check bonuses by skill id (a monster lists only its proficient skills). */
  readonly skills: Readonly<Record<string, number>>;
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
  /** Conditions it can't have (a monster's Immunities). */
  readonly condition_immunities: readonly string[];
  /** Saving throw effects it can use (a breath weapon), resolved by `useSaveAction`. */
  readonly save_actions: readonly SaveActionLine[];
  /** How its conditions change rolls (`conditionRolls`). */
  readonly condition_rolls: ConditionRolls;
  /** Legendary actions it can take after another creature's turn (a monster's). */
  readonly legendary_actions: readonly LegendaryActionLine[];
  /**
   * Legendary Resistance uses left: while above 0, a failed saving throw succeeds instead (SRD
   * "Legendary Resistance"), and the result says so.
   */
  readonly legendary_resistance: number;
  /** Its size, lowercase (`medium`; the first of a stat block's "Medium or Small"), if known. */
  readonly size: string | null;
}

/** A legendary action: an attack it makes, an action it uses, a saving throw effect, or text. */
export interface LegendaryActionLine {
  readonly name: string;
  /** Can't be taken again until the start of the monster's next turn. */
  readonly once_per_round: boolean;
  /** Attack lines it can make (one of them). */
  readonly attacks: readonly string[];
  /** Another action it uses (an attack line or a saving throw effect). */
  readonly uses: string | null;
  readonly save: SaveActionLine | null;
  readonly text: string;
}

/** Advantage or Disadvantage from a condition, with the condition's name for notes. */
export interface ConditionMode {
  readonly mode: "advantage" | "disadvantage";
  readonly condition: string;
  /** The condition's id (Grappled's exception: `except_against_source`). */
  readonly id: string;
  readonly except_against_source: boolean;
}

/** How a creature's conditions change rolls (SRD Rules Glossary, conditions). */
export interface ConditionRolls {
  /** On its own attack rolls. */
  readonly attack_rolls: readonly ConditionMode[];
  /** On attack rolls against it, from within 5 feet and from farther. */
  readonly attacked: readonly ConditionMode[];
  readonly attacked_beyond_5ft: readonly ConditionMode[];
  /** Conditions that make a hit from within 5 feet a Critical Hit. */
  readonly critical_within_5ft: readonly string[];
  /** Ability → the condition that makes it fail that saving throw. */
  readonly fail_saves: Readonly<Partial<Record<Ability, string>>>;
  /** Ability → the condition that gives Disadvantage on that saving throw. */
  readonly save_disadvantage: Readonly<Partial<Record<Ability, string>>>;
  readonly initiative: readonly ConditionMode[];
  readonly ability_checks: readonly ConditionMode[];
}

export const NO_CONDITION_ROLLS: ConditionRolls = {
  attack_rolls: [],
  attacked: [],
  attacked_beyond_5ft: [],
  critical_within_5ft: [],
  fail_saves: {},
  save_disadvantage: {},
  initiative: [],
  ability_checks: [],
};

/** Condition ids with the ones they imply (Unconscious → Incapacitated, Prone). */
export function expandConditions(ids: readonly string[], table: Table<ConditionDef>): string[] {
  const out: string[] = [];
  const add = (id: string) => {
    if (out.includes(id)) return;
    out.push(id);
    for (const next of (Object.hasOwn(table, id) ? table[id] : undefined)?.implies ?? []) add(next);
  };
  for (const id of ids) add(id);
  return out;
}

/** What a creature's conditions (implied ones included) do to its rolls and to rolls against it. */
export function conditionRolls(ids: readonly string[], table: Table<ConditionDef>): ConditionRolls {
  const rolls = {
    attack_rolls: [] as ConditionMode[],
    attacked: [] as ConditionMode[],
    attacked_beyond_5ft: [] as ConditionMode[],
    critical_within_5ft: [] as string[],
    fail_saves: {} as Partial<Record<Ability, string>>,
    save_disadvantage: {} as Partial<Record<Ability, string>>,
    initiative: [] as ConditionMode[],
    ability_checks: [] as ConditionMode[],
  };
  for (const id of expandConditions(ids, table)) {
    const def = Object.hasOwn(table, id) ? table[id] : undefined;
    if (!def) continue;
    const entry = (mode: "advantage" | "disadvantage") => ({
      mode,
      condition: def.name,
      id: def.id,
      except_against_source: def.except_against_source,
    });
    if (def.attack_rolls) rolls.attack_rolls.push(entry(def.attack_rolls));
    if (def.attacked) rolls.attacked.push(entry(def.attacked));
    if (def.attacked_beyond_5ft) rolls.attacked_beyond_5ft.push(entry(def.attacked_beyond_5ft));
    if (def.critical_within_5ft) rolls.critical_within_5ft.push(def.name);
    if (def.initiative) rolls.initiative.push(entry(def.initiative));
    if (def.ability_checks) rolls.ability_checks.push(entry(def.ability_checks));
    for (const a of def.fail_saves) rolls.fail_saves[a] ??= def.name;
    for (const a of def.save_disadvantage) rolls.save_disadvantage[a] ??= def.name;
  }
  return rolls;
}

/** One reason for Advantage or Disadvantage on a roll. */
export interface ModeReason {
  readonly mode: "advantage" | "disadvantage";
  readonly reason: string;
}

/**
 * The mode of a D20 Test: Advantage if anything gives it, Disadvantage likewise, and a normal
 * roll when both apply, however many of each (SRD "Advantage", "Disadvantage").
 */
export function resolveMode(
  asked: RollMode,
  reasons: readonly ModeReason[],
): { mode: RollMode; reasons: string[] } {
  const all: ModeReason[] = [...reasons];
  if (asked !== "normal") all.unshift({ mode: asked, reason: "asked" });
  const advantage = all.some((r) => r.mode === "advantage");
  const disadvantage = all.some((r) => r.mode === "disadvantage");
  const mode =
    advantage && disadvantage
      ? "normal"
      : advantage
        ? "advantage"
        : disadvantage
          ? "disadvantage"
          : "normal";
  const label = (r: ModeReason) =>
    `${r.mode === "advantage" ? "Advantage" : "Disadvantage"}: ${r.reason}`;
  return { mode, reasons: all.filter((r) => r.reason !== "asked").map(label) };
}

export interface AttackModeOptions {
  /** Advantage or Disadvantage from elsewhere (the caller, a feature). */
  mode?: RollMode;
  /** The attacker is within 5 feet of the target (Prone, Paralyzed, Unconscious). */
  within_5ft: boolean;
  /** The attacker's condition ids whose source is this target (Grappled by it). */
  against_source_of?: readonly string[];
  /** More reasons for Advantage or Disadvantage (Help, Dodge…). */
  modes?: readonly ModeReason[];
}

/**
 * An attack roll's mode from the attacker's and the target's conditions, and whether a hit is a
 * Critical Hit (a Paralyzed or Unconscious target within 5 feet).
 */
export function attackMode(
  attacker: Combatant,
  target: Combatant,
  { mode = "normal", within_5ft, against_source_of = [], modes = [] }: AttackModeOptions,
): { mode: RollMode; reasons: string[]; critical_on_hit: boolean } {
  const reasons: ModeReason[] = [...modes];
  for (const c of attacker.condition_rolls.attack_rolls) {
    if (c.except_against_source && against_source_of.includes(c.id)) continue;
    reasons.push({ mode: c.mode, reason: `${attacker.name} is ${c.condition}` });
  }
  const against = within_5ft
    ? target.condition_rolls.attacked
    : target.condition_rolls.attacked_beyond_5ft;
  const where = within_5ft ? "within 5 ft" : "beyond 5 ft";
  for (const c of against) {
    reasons.push({ mode: c.mode, reason: `${target.name} is ${c.condition} (${where})` });
  }
  const resolved = resolveMode(mode, reasons);
  const critical_on_hit = within_5ft && target.condition_rolls.critical_within_5ft.length > 0;
  return { ...resolved, critical_on_hit };
}

/** A saving throw effect with a fixed DC (a monster's breath weapon or gaze). */
export interface SaveActionLine {
  readonly name: string;
  readonly ability: Ability;
  readonly dc: number;
  /** Damage on a failed save. */
  readonly damage_parts: readonly DamagePart[];
  readonly on_success: "half" | "none";
  /** Conditions on a failed save. */
  readonly conditions: readonly string[];
  /** `5–6`: recharges on those d6 rolls (tracked by the caller). */
  readonly recharge: string | null;
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
  /** Why the roll had Advantage or Disadvantage (conditions), if it did. */
  readonly reasons: readonly string[];
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
  /** The attacker is within 5 feet of the target (default: a melee attack is, a ranged one isn't). */
  within_5ft?: boolean;
  /** The attacker's condition ids whose source is the target (Grappled by it). */
  against_source_of?: readonly string[];
  /** More reasons for Advantage or Disadvantage (Help: `{ mode: "advantage", reason: "…" }`). */
  modes?: readonly ModeReason[];
  /**
   * The Light property's extra attack: the line's `light_extra_damage_parts` (no positive ability
   * modifier). Throws for an attack that isn't with a Light weapon.
   */
  light_extra?: boolean;
  /** The Cleave mastery's attack: the line's `cleave_damage_parts`. */
  cleave?: boolean;
}

/**
 * Make one attack with one of the attacker's attack lines (by name, or the line itself).
 *
 * A natural 1 always misses. A roll of `critical_hit_on` or more (a natural 20, or 19 with
 * Improved Critical) is a Critical Hit, which hits regardless of the target's AC (SRD "Critical
 * Hit") and rolls the damage dice twice. Conditions add Advantage or Disadvantage (`attackMode`),
 * and a hit on a Paralyzed or Unconscious target within 5 feet is a Critical Hit.
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
    within_5ft,
    against_source_of = [],
    modes = [],
    light_extra = false,
    cleave = false,
  }: AttackOptions = {},
): AttackResult {
  const line =
    typeof attack === "string" ? attacker.attacks.find((a) => a.name === attack) : attack;
  if (!line) {
    const known = attacker.attacks.map((a) => a.name).join(", ");
    throw new RangeError(`${attacker.name} has no attack '${String(attack)}' (${known})`);
  }
  const effective = attackMode(attacker, target, {
    mode,
    within_5ft: within_5ft ?? line.kind === "melee",
    against_source_of,
    modes,
  });
  if (light_extra && !line.light_extra_damage_parts) {
    throw new RangeError(`${line.name} isn't a Light weapon`);
  }
  if (cleave && !line.cleave_damage_parts) {
    throw new RangeError(`${line.name} doesn't have the Cleave mastery property`);
  }
  // Check the riders before rolling, so a refused request rolls nothing.
  const extra: DamagePart[] = [];
  const riderNames: string[] = [];
  for (const request of riders) {
    const rider = line.riders.find((r) => r.id === request.rider || r.name === request.rider);
    if (!rider) throw new RangeError(`${line.name} has no rider '${request.rider}'`);
    if (rider.requires === "advantage_or_ally") {
      const ok =
        effective.mode === "advantage" || (ally_adjacent && effective.mode !== "disadvantage");
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
  const roll = rollD20({ mode: effective.mode, rng });
  const total = roll.d20 + line.attack_bonus;
  const critical_miss = roll.d20 === 1;
  const criticalRoll = !critical_miss && roll.d20 >= Math.min(20, attacker.critical_hit_on);
  const hit = criticalRoll || (!critical_miss && total >= target.armor_class);
  const critical_hit = criticalRoll || (hit && effective.critical_on_hit);
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
    reasons: effective.reasons,
  };
  if (!hit) return { ...base, damage: null, riders: [], instances: [], outcome: null };
  let base_parts = line.damage_parts;
  if (light_extra && line.light_extra_damage_parts) base_parts = line.light_extra_damage_parts;
  else if (cleave && line.cleave_damage_parts) base_parts = line.cleave_damage_parts;
  else if (two_handed && line.two_handed_damage_parts) base_parts = line.two_handed_damage_parts;
  const parts = [...base_parts, ...extra];
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
  /** The condition that made it fail without a roll (Paralyzed: Strength and Dexterity). */
  readonly automatic_failure: string | null;
  /** It failed, and Legendary Resistance made it a success (one use spent). */
  readonly legendary_resistance: boolean;
  /** Why the roll had Advantage or Disadvantage, if it did. */
  readonly reasons: readonly string[];
}

/**
 * A saving throw against a DC. Unlike attacks, a natural 20 or 1 has no special effect. A
 * condition can make it fail without a roll (Paralyzed, Stunned…: Strength and Dexterity) or give
 * Disadvantage (Restrained: Dexterity); a feature can give Advantage (Rage: Strength).
 */
export function rollSavingThrow(
  combatant: Combatant,
  ability: Ability,
  dc: number,
  { rng = mathRng, mode = "normal" }: { rng?: Rng; mode?: RollMode } = {},
): SaveResult {
  const bonus = combatant.saving_throws[ability];
  const base = { name: combatant.name, ability, dc, bonus };
  // Legendary Resistance: "If the monster fails a saving throw, it can choose to succeed instead."
  const resisted = combatant.legendary_resistance > 0;
  const failing = combatant.condition_rolls.fail_saves[ability];
  if (failing) {
    const roll = { rolls: [], d20: 0, mode: "normal" as const };
    return {
      ...base,
      roll,
      total: 0,
      success: resisted,
      automatic_failure: failing,
      legendary_resistance: resisted,
      reasons: [],
    };
  }
  const reasons: ModeReason[] = [];
  if (combatant.advantages.includes(`save.${ability}`)) {
    reasons.push({ mode: "advantage", reason: `${combatant.name}'s features` });
  }
  const hindered = combatant.condition_rolls.save_disadvantage[ability];
  if (hindered) reasons.push({ mode: "disadvantage", reason: `${combatant.name} is ${hindered}` });
  const resolved = resolveMode(mode, reasons);
  const roll = rollD20({ mode: resolved.mode, rng });
  const total = roll.d20 + bonus;
  const legendary = total < dc && resisted;
  return {
    ...base,
    roll,
    total,
    success: total >= dc || legendary,
    automatic_failure: null,
    legendary_resistance: legendary,
    reasons: resolved.reasons,
  };
}

export interface CheckResult {
  readonly name: string;
  readonly ability: Ability;
  /** The skill, when it's a skill check. */
  readonly skill: string | null;
  readonly dc: number | null;
  readonly bonus: number;
  readonly roll: D20Roll;
  readonly total: number;
  /** Against a DC; `null` when none was given (a contest, or the GM decides). */
  readonly success: boolean | null;
  readonly reasons: readonly string[];
}

/**
 * An ability check (SRD "Ability Check"): with a skill, the skill's bonus (proficiency,
 * Expertise, Jack of All Trades on the sheet; a monster's listed skills), else the ability's.
 * Advantage from features (`check.str` while raging) and conditions (Poisoned, Frightened:
 * Disadvantage) combine with `mode`.
 */
export function rollAbilityCheck(
  combatant: Combatant,
  what: { skill: Skill } | { ability: Ability },
  dc: number | null = null,
  {
    rng = mathRng,
    mode = "normal",
    modes = [],
  }: { rng?: Rng; mode?: RollMode; modes?: readonly ModeReason[] } = {},
): CheckResult {
  const skill = "skill" in what ? what.skill : null;
  const ability = skill ? SKILL_ABILITY[skill] : (what as { ability: Ability }).ability;
  const bonus = (skill ? combatant.skills[skill] : undefined) ?? combatant.ability_checks[ability];
  const reasons: ModeReason[] = [...modes];
  if (combatant.advantages.includes(`check.${ability}`)) {
    reasons.push({ mode: "advantage", reason: `${combatant.name}'s features` });
  }
  for (const c of combatant.condition_rolls.ability_checks) {
    reasons.push({ mode: c.mode, reason: `${combatant.name} is ${c.condition}` });
  }
  const resolved = resolveMode(mode, reasons);
  const roll = rollD20({ mode: resolved.mode, rng });
  const total = roll.d20 + bonus;
  return {
    name: combatant.name,
    ability,
    skill,
    dc,
    bonus,
    roll,
    total,
    success: dc === null ? null : total >= dc,
    reasons: resolved.reasons,
  };
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
    ability_checks: modifiers,
    skills: {},
    defenses: { resistances: [], vulnerabilities: [], immunities: [] },
    conditions: [],
    attacks: [],
    critical_hit_on: 20,
    attacks_per_action: 1,
    spellcasting: [],
    advantages: [],
    no_spells: false,
    condition_immunities: [],
    save_actions: [],
    condition_rolls: NO_CONDITION_ROLLS,
    legendary_actions: [],
    legendary_resistance: 0,
    size: null,
  };
}

/** A monster's current state in play (the stat block holds the maxima). */
export interface MonsterState {
  readonly hp?: number;
  readonly temp_hp?: number;
  readonly conditions?: readonly string[];
  /** In its lair: more legendary action and Legendary Resistance uses, when it has lair values. */
  readonly in_lair?: boolean;
  /** Legendary Resistance uses already spent today. */
  readonly legendary_resistance_used?: number;
  /** `false`: never spend Legendary Resistance automatically (the GM decides). Default true. */
  readonly auto_legendary_resistance?: boolean;
}

/**
 * A combatant from a monster stat block: its attacks become attack lines (for `makeAttack`), its
 * saving throw effects become `save_actions` (for `useSaveAction`); spellcasting and legendary
 * actions stay in the stat block's text. With the catalog's `conditions`, its conditions change
 * rolls (`condition_rolls`).
 */
export function combatantFromMonster(
  monster: MonsterDef,
  state: MonsterState = {},
  { conditions: table }: { conditions?: Table<ConditionDef> } = {},
): Combatant {
  const modifiers = Object.fromEntries(
    ABILITIES.map((a) => [a, abilityModifier(monster.abilities[a])]),
  ) as Record<Ability, number>;
  const parts = (damage: readonly MonsterDamage[]): DamagePart[] =>
    damage.map((d) =>
      d.dice === null
        ? { dice: null, bonus: d.average, type: d.type }
        : { dice: d.dice, bonus: d.bonus, type: d.type },
    );
  const all = [...monster.actions, ...monster.bonus_actions, ...monster.reactions];
  const attacks: AttackLine[] = all.flatMap((action) => {
    const a = action.attack;
    if (!a?.damage.length) return [];
    const damage = parts(a.damage);
    const notes = [
      ...(a.reach !== null ? [`reach ${a.reach} ft.`] : []),
      ...(a.range !== null ? [`range ${a.range} ft.`] : []),
      ...(action.recharge ? [`Recharge ${action.recharge}`] : []),
    ];
    return [
      {
        name: action.name,
        kind: a.kind === "ranged" ? "ranged" : "melee",
        ability: null,
        weapon: false,
        properties: [],
        riders: [],
        attack_bonus: a.bonus,
        damage: formatDamage(damage),
        damage_type: damage[0]?.type ?? "",
        damage_parts: damage,
        two_handed_damage_parts: null,
        light_extra_damage_parts: null,
        cleave_damage_parts: null,
        mastery: null,
        notes,
      },
    ];
  });
  const saveLine = (action: MonsterDef["actions"][number]): SaveActionLine | null =>
    action.save
      ? {
          name: action.name,
          ability: action.save.ability,
          dc: action.save.dc,
          damage_parts: parts(action.save.damage),
          on_success: action.save.on_success,
          conditions: action.save.conditions,
          recharge: action.recharge,
        }
      : null;
  // Legendary actions' own saving throw effects are only usable as legendary actions.
  const saveActions = all.flatMap((action) => saveLine(action) ?? []);
  const legendaryActions: LegendaryActionLine[] = monster.legendary_actions.map((action) => ({
    name: action.name,
    once_per_round: action.once_per_round,
    attacks: action.attacks,
    uses: action.uses,
    save: saveLine(action),
    text: action.text,
  }));
  const resistance = monster.legendary_resistance;
  const resistanceUses = resistance
    ? state.in_lair && resistance.in_lair !== null
      ? resistance.in_lair
      : resistance.uses
    : 0;
  const resistanceLeft =
    state.auto_legendary_resistance === false
      ? 0
      : Math.max(0, resistanceUses - (state.legendary_resistance_used ?? 0));
  const hp = Math.min(state.hp ?? monster.hit_points, monster.hit_points);
  return {
    name: monster.name,
    // Cantrip Upgrade doesn't apply to monsters (their spells are text).
    level: 1,
    armor_class: monster.armor_class,
    hp,
    temp_hp: state.temp_hp ?? 0,
    max_hp: monster.hit_points,
    proficiency_bonus: monster.proficiency_bonus,
    modifiers,
    saving_throws: monster.saving_throws,
    ability_checks: modifiers,
    skills: monster.skills,
    defenses: {
      resistances: monster.resistances,
      vulnerabilities: monster.vulnerabilities,
      immunities: monster.immunities,
    },
    conditions: table ? expandConditions(state.conditions ?? [], table) : (state.conditions ?? []),
    attacks,
    critical_hit_on: 20,
    // Multiattack: that many attacks for one action.
    attacks_per_action: monster.multiattack ?? 1,
    spellcasting: [],
    advantages: [],
    no_spells: false,
    condition_immunities: monster.condition_immunities,
    save_actions: saveActions,
    condition_rolls: table ? conditionRolls(state.conditions ?? [], table) : NO_CONDITION_ROLLS,
    legendary_actions: legendaryActions,
    legendary_resistance: resistanceLeft,
    size: monster.size.split(" ")[0]?.toLowerCase() || null,
  };
}
