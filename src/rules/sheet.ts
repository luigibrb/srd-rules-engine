/**
 * Compute the derived level 1 character sheet from a (possibly partial) build.
 *
 * Derived values are never stored; they are recomputed from the build every time. Each
 * headline number keeps its list of contributions so a UI can explain it
 * ("AC 17 = 16 Chain Mail + 1 Defense"). The sheet is plain JSON-serializable data.
 */

import { type Catalog, lookup } from "../content/catalog";
import type { CharacterBuild } from "../models/build";
import {
  ABILITIES,
  ABILITY_NAMES,
  type Ability,
  type ArmorDef,
  type EffectOp,
  type Size,
  SKILL_ABILITY,
  SKILLS,
  type Skill,
  type Trait,
  type WeaponDef,
} from "../models/content";
import { finalScores } from "./ability-scores";
import { type Resolution, resolve } from "./build-resolution";
import { abilityModifier, proficiencyBonus, signed } from "./dice";

export const LEVEL = 1;
export const DEFAULT_SCORE = 10;

export interface Contribution {
  readonly source: string;
  readonly value: number;
}

/** A number together with where it comes from. */
export interface Stat {
  readonly total: number;
  readonly parts: readonly Contribution[];
}

export interface SkillLine {
  readonly skill: Skill;
  readonly ability: Ability;
  readonly modifier: number;
  readonly proficient_from: string | null;
}

export interface SaveLine {
  readonly modifier: number;
  readonly proficient: boolean;
}

export interface AttackLine {
  readonly name: string;
  readonly attack_bonus: number;
  readonly damage: string;
  readonly damage_type: string;
  readonly mastery: string | null;
  readonly notes: readonly string[];
}

export interface DerivedSheet {
  readonly level: number;
  readonly scores: Readonly<Record<Ability, number>>;
  readonly modifiers: Readonly<Record<Ability, number>>;
  readonly scores_complete: boolean;
  readonly proficiency_bonus: number;
  readonly max_hp: Stat | null;
  readonly hit_die: number | null;
  readonly armor_class: Stat;
  readonly armor_worn: string | null;
  readonly initiative: Stat;
  readonly speed: Stat;
  readonly size: Size | null;
  readonly darkvision: number;
  readonly saving_throws: Readonly<Record<Ability, SaveLine>>;
  readonly skills: readonly SkillLine[];
  readonly passive_perception: number;
  readonly attacks: readonly AttackLine[];
  /** Tool id → source of the proficiency. */
  readonly tools: Readonly<Record<string, string>>;
  /** Language id → source. */
  readonly languages: Readonly<Record<string, string>>;
  readonly resistances: readonly string[];
  readonly cantrips: readonly string[];
  readonly armor_training: readonly string[];
  readonly weapon_proficiencies: readonly string[];
  readonly feats: readonly string[];
  readonly traits: readonly Trait[];
  readonly weapon_masteries: readonly string[];
  /** Item id → quantity. */
  readonly equipment: Readonly<Record<string, number>>;
  readonly gp: number;
  readonly warnings: readonly string[];
}

export function stat(parts: Contribution[]): Stat {
  return { total: parts.reduce((sum, p) => sum + p.value, 0), parts };
}

/** `16 Chain Mail + 1 Defense`. */
export function explainStat(s: Stat): string {
  return s.parts
    .map((p, i) =>
      i === 0
        ? `${p.value} ${p.source}`
        : `${p.value >= 0 ? "+" : "-"} ${Math.abs(p.value)} ${p.source}`,
    )
    .join(" ");
}

type ResolvedEffect = [op: EffectOp, value: number, source: string];

export function computeSheet(
  build: CharacterBuild,
  catalog: Catalog,
  res: Resolution = resolve(build, catalog),
): DerivedSheet {
  const pb = proficiencyBonus(LEVEL);
  const known = finalScores(build.base_scores, build.background_bonus);
  const scores = mapAbilities((a) => known[a] ?? DEFAULT_SCORE);
  const mod = mapAbilities((a) => abilityModifier(scores[a]));
  const cls = lookup(catalog.classes, build.class_id);
  const warnings: string[] = [];

  // Equipment: fixed item grants plus chosen packages (both are option sources).
  const equipment: Record<string, number> = {};
  for (const src of res.sources) {
    for (const grant of src.grants.items) {
      equipment[grant.item] = (equipment[grant.item] ?? 0) + grant.qty;
    }
  }
  const gp = res.sources.reduce((sum, src) => sum + src.grants.gp, 0);
  const training = res.granted("armor_training");

  const [armor, shield] = pickArmor(equipment, training, catalog, mod.dex);
  const conditions = new Map<string, boolean>([["wearing_armor", armor !== null]]);

  const effectsFor = (target: string): ResolvedEffect[] => {
    const out: ResolvedEffect[] = [];
    for (const [effect, source] of res.effects()) {
      if (effect.target !== target) continue;
      if (effect.when !== null && !conditions.get(effect.when)) continue;
      out.push([effect.op, effect.value === "prof" ? pb : effect.value, source]);
    }
    return out;
  };

  // Armor Class
  const acParts: Contribution[] = [];
  if (armor === null) {
    acParts.push({ source: "base (unarmored)", value: 10 }, { source: "Dex", value: mod.dex });
  } else {
    acParts.push({ source: armor.name, value: armor.base_ac });
    const dex = armor.dex_cap === null ? mod.dex : Math.min(mod.dex, armor.dex_cap);
    if (armor.dex_cap !== 0) {
      const cap = armor.dex_cap === null ? "" : ` (max ${armor.dex_cap})`;
      acParts.push({ source: `Dex${cap}`, value: dex });
    }
  }
  if (shield !== null) acParts.push({ source: shield.name, value: shield.base_ac });
  for (const [op, value, source] of effectsFor("ac")) {
    if (op === "add") acParts.push({ source, value });
  }

  // Hit points
  let maxHp: Stat | null = null;
  if (cls) {
    maxHp = stat([
      { source: `${cls.name} d${cls.hit_die}`, value: cls.hit_die },
      { source: "Con", value: mod.con },
      ...effectsFor("hp_per_level").map(([, value, source]) => ({ source, value: value * LEVEL })),
    ]);
  }

  // Initiative
  const initiative = stat([
    { source: "Dex", value: mod.dex },
    ...effectsFor("initiative")
      .filter(([op]) => op === "add")
      .map(([, value, source]) => ({ source, value })),
  ]);

  // Speed: base from `set`, raised by `max`, then flat adjustments.
  let speedValue = 30;
  let speedSource = "default";
  for (const [op, value, source] of effectsFor("speed")) {
    if (op === "set" || (op === "max" && value > speedValue)) {
      speedValue = value;
      speedSource = source;
    }
  }
  const speedParts: Contribution[] = [{ source: speedSource, value: speedValue }];
  if (armor?.strength && scores.str < armor.strength) {
    speedParts.push({ source: `${armor.name} (Str < ${armor.strength})`, value: -10 });
    warnings.push(
      `${armor.name} needs Strength ${armor.strength}: your Speed drops by 10 ft ` +
        `(Strength is ${scores.str}).`,
    );
  }
  if (armor?.stealth_disadvantage) {
    warnings.push(`${armor.name} gives Disadvantage on Dexterity (Stealth) checks.`);
  }

  const darkvision = Math.max(0, ...effectsFor("darkvision").map(([, v]) => v));

  // Saves and skills
  const saveProfs = res.savingThrows();
  const savingThrows = mapAbilities((a) => ({
    modifier: mod[a] + (saveProfs.has(a) ? pb : 0),
    proficient: saveProfs.has(a),
  }));
  const ownedSkills = res.skills();
  const skills: SkillLine[] = SKILLS.map((skill) => {
    const ability = SKILL_ABILITY[skill];
    return {
      skill,
      ability,
      modifier: mod[ability] + (ownedSkills.has(skill) ? pb : 0),
      proficient_from: ownedSkills.get(skill) ?? null,
    };
  });
  const perception = skills.find((line) => line.skill === "perception") as SkillLine;

  const masteries = res.weaponMasteries();
  const weaponProfs = res.granted("weapon_proficiencies");
  const featIds = new Set(res.featSources().map((s) => s.feat.id));
  const attackContext: AttackContext = {
    catalog,
    scores,
    pb,
    weaponProfs,
    masteries,
    rangedBonus: effectsFor("attack.ranged"),
    featIds,
  };
  const attacks: AttackLine[] = [
    {
      name: "Unarmed Strike",
      attack_bonus: mod.str + pb,
      damage: String(Math.max(0, 1 + mod.str)),
      damage_type: "bludgeoning",
      mastery: null,
      notes: [],
    },
  ];
  for (const itemId of Object.keys(equipment)) {
    const weapon = lookup(catalog.weapons, itemId);
    if (weapon) attacks.push(attackLine(weapon, attackContext));
  }

  let size: Size | null = null;
  for (const src of res.sources) size = src.grants.size ?? size;

  const traits: Trait[] = res.sources
    .filter((src) => src.feat === null && src.key !== "creation")
    .flatMap((src) => src.grants.traits);

  return {
    level: LEVEL,
    scores,
    modifiers: mod,
    scores_complete: Object.keys(known).length === ABILITIES.length,
    proficiency_bonus: pb,
    max_hp: maxHp,
    hit_die: cls ? cls.hit_die : null,
    armor_class: stat(acParts),
    armor_worn: armor ? armor.name : null,
    initiative,
    speed: stat(speedParts),
    size,
    darkvision,
    saving_throws: savingThrows,
    skills,
    passive_perception: 10 + perception.modifier,
    attacks,
    tools: Object.fromEntries(res.tools()),
    languages: Object.fromEntries(res.languages()),
    resistances: res.granted("resistances"),
    cantrips: res.granted("cantrips"),
    armor_training: training,
    weapon_proficiencies: weaponProfs,
    feats: res.featSources().map((s) => s.name),
    traits,
    weapon_masteries: masteries,
    equipment,
    gp,
    warnings,
  };
}

function mapAbilities<T>(fn: (a: Ability) => T): Record<Ability, T> {
  return Object.fromEntries(ABILITIES.map((a) => [a, fn(a)])) as Record<Ability, T>;
}

/** Assume the character wears the best armor they own and are trained in. */
function pickArmor(
  equipment: Record<string, number>,
  training: readonly string[],
  catalog: Catalog,
  dexMod: number,
): [ArmorDef | null, ArmorDef | null] {
  const owned = Object.keys(equipment)
    .map((id) => lookup(catalog.armor, id))
    .filter((a): a is ArmorDef => a !== undefined);
  const ac = (a: ArmorDef) =>
    a.base_ac + (a.dex_cap === null ? dexMod : Math.min(dexMod, a.dex_cap));
  let best: ArmorDef | null = null;
  for (const a of owned) {
    if (a.category !== "shield" && training.includes(a.category) && (!best || ac(a) > ac(best))) {
      best = a;
    }
  }
  if (best && ac(best) <= 10 + dexMod) best = null;
  const shield = training.includes("shield")
    ? (owned.find((a) => a.category === "shield") ?? null)
    : null;
  return [best, shield];
}

interface AttackContext {
  catalog: Catalog;
  scores: Record<Ability, number>;
  pb: number;
  weaponProfs: readonly string[];
  masteries: readonly string[];
  rangedBonus: readonly ResolvedEffect[];
  featIds: ReadonlySet<string>;
}

function attackLine(w: WeaponDef, ctx: AttackContext): AttackLine {
  const strMod = abilityModifier(ctx.scores.str);
  const dexMod = abilityModifier(ctx.scores.dex);
  let abilityMod: number;
  if (w.properties.includes("finesse")) abilityMod = Math.max(strMod, dexMod);
  else abilityMod = w.kind === "ranged" ? dexMod : strMod;
  const proficient = ctx.weaponProfs.includes(w.category);
  let bonus = abilityMod + (proficient ? ctx.pb : 0);
  const notes: string[] = [];
  if (w.kind === "ranged") bonus += ctx.rangedBonus.reduce((sum, [, v]) => sum + v, 0);
  if (!proficient) notes.push("not proficient");
  if (w.properties.includes("heavy")) {
    const needed: Ability = w.kind === "melee" ? "str" : "dex";
    if (ctx.scores[needed] < 13) notes.push(`Disadvantage (Heavy, ${ABILITY_NAMES[needed]} < 13)`);
  }
  if (w.range) notes.push(`range ${w.range}`);
  const twoHandedMelee =
    w.kind === "melee" &&
    (w.properties.includes("two-handed") || w.properties.includes("versatile"));
  if (ctx.featIds.has("great-weapon-fighting") && twoHandedMelee) {
    notes.push("GWF: treat 1-2 on damage dice as 3 (two hands)");
  }
  let damage = withMod(w.damage, abilityMod);
  if (w.versatile_damage) damage += ` (${withMod(w.versatile_damage, abilityMod)} two-handed)`;
  const mastery = ctx.masteries.includes(w.id)
    ? (lookup(ctx.catalog.masteries, w.mastery)?.name ?? null)
    : null;
  return {
    name: w.name,
    attack_bonus: bonus,
    damage,
    damage_type: w.damage_type,
    mastery,
    notes,
  };
}

function withMod(dice: string, mod: number): string {
  return mod === 0 ? dice : `${dice}${signed(mod)}`;
}
