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
import { isMonkWeapon, isWeaponProficient } from "./weapons";

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
  /** Proficiency Bonus counted twice. */
  readonly expertise: boolean;
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
  /** Ids of every cantrip you know (a shortcut into `spells`). */
  readonly cantrips: readonly string[];
  readonly spellcasting: readonly SpellcastingLine[];
  /** Cantrips and prepared spells: what you can cast. */
  readonly spells: readonly SpellLine[];
  /** Spells in your spellbook (Wizard), prepared or not. */
  readonly spellbook: readonly string[];
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
type Conditions = ReadonlyMap<string, boolean>;

export interface SpellcastingLine {
  /** The feature's source, e.g. `Wizard` or `Magic Initiate`. */
  readonly source: string;
  /** Spell list id; `null` for a fixed set of spells or while it depends on an unanswered choice. */
  readonly list: string | null;
  readonly ability: Ability | null;
  readonly save_dc: number | null;
  readonly attack_bonus: number | null;
  /** Spell slots per spell level: `[2]` = two level 1 slots. */
  readonly slots: readonly number[];
  readonly pact: boolean;
}

export interface SpellLine {
  readonly id: string;
  readonly name: string;
  readonly level: number;
  readonly source: string;
  /** Granted by a feature (Favored Enemy, Druidic…); doesn't count against prepared spells. */
  readonly always_prepared: boolean;
}

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

  const effectsFor = (target: string, conditions: Conditions): ResolvedEffect[] => {
    const out: ResolvedEffect[] = [];
    for (const [effect, source] of res.effects()) {
      if (effect.target !== target) continue;
      if (effect.when !== null && !conditions.get(effect.when)) continue;
      let value =
        effect.value === "prof"
          ? pb
          : typeof effect.value === "string"
            ? mod[effect.value]
            : effect.value;
      if (effect.min !== null) value = Math.max(value, effect.min);
      out.push([effect.op, value, source]);
    }
    return out;
  };

  // Armor Class: the best of every legal way to compute it (see `bestArmorClass`).
  const ac = bestArmorClass(equipment, training, res, catalog, mod, effectsFor);
  const { armor, shield } = ac;
  const conditions: Conditions = new Map([
    ["wearing_armor", armor !== null],
    ["wielding_shield", shield !== null],
  ]);
  const effects = (target: string) => effectsFor(target, conditions);

  // Hit points
  let maxHp: Stat | null = null;
  if (cls) {
    maxHp = stat([
      { source: `${cls.name} d${cls.hit_die}`, value: cls.hit_die },
      { source: "Con", value: mod.con },
      ...effects("hp_per_level").map(([, value, source]) => ({ source, value: value * LEVEL })),
    ]);
  }

  // Initiative
  const initiative = stat([
    { source: "Dex", value: mod.dex },
    ...effects("initiative")
      .filter(([op]) => op === "add")
      .map(([, value, source]) => ({ source, value })),
  ]);

  // Speed: base from `set`, raised by `max`, then flat adjustments.
  let speedValue = 30;
  let speedSource = "default";
  for (const [op, value, source] of effects("speed")) {
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

  const darkvision = Math.max(0, ...effects("darkvision").map(([, v]) => v));

  // Saves and skills
  const saveProfs = res.savingThrows();
  const savingThrows = mapAbilities((a) => ({
    modifier: mod[a] + (saveProfs.has(a) ? pb : 0),
    proficient: saveProfs.has(a),
  }));
  const ownedSkills = res.skills();
  const expertise = res.expertise();
  const skills: SkillLine[] = SKILLS.map((skill) => {
    const ability = SKILL_ABILITY[skill];
    const proficient = ownedSkills.has(skill);
    const expert = proficient && expertise.has(skill);
    const bonus = effects(`skill.${skill}`).reduce(
      (sum, [op, v]) => sum + (op === "add" ? v : 0),
      0,
    );
    return {
      skill,
      ability,
      modifier: mod[ability] + (proficient ? pb : 0) + (expert ? pb : 0) + bonus,
      proficient_from: ownedSkills.get(skill) ?? null,
      expertise: expert,
    };
  });
  const perception = skills.find((line) => line.skill === "perception") as SkillLine;

  // Attacks
  const masteries = res.weaponMasteries();
  const weaponProfs = res.granted("weapon_proficiencies");
  const martialArtsDie = Math.max(0, ...effects("martial_arts.die").map(([, v]) => v));
  const attackContext: AttackContext = {
    catalog,
    scores,
    pb,
    weaponProfs,
    masteries,
    rangedBonus: effects("attack.ranged"),
    featIds: new Set(res.featSources().map((s) => s.feat.id)),
    // Martial Arts works only while you aren't wearing armor or wielding a Shield.
    martialArtsDie: armor === null && shield === null ? martialArtsDie : 0,
  };
  if (martialArtsDie && attackContext.martialArtsDie === 0) {
    warnings.push("Martial Arts doesn't work while you wear armor or wield a Shield.");
  }
  const attacks: AttackLine[] = [unarmedStrike(attackContext)];
  for (const itemId of Object.keys(equipment)) {
    const weapon = lookup(catalog.weapons, itemId);
    if (weapon) attacks.push(attackLine(weapon, attackContext));
  }

  // Spells
  const { spellcasting, spells, spellbook } = spellcastingSummary(res, catalog, mod, pb);

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
    armor_class: stat(ac.parts),
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
    cantrips: spells.filter((s) => s.level === 0).map((s) => s.id),
    spellcasting,
    spells,
    spellbook,
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

const ABBREVIATIONS: Record<Ability, string> = {
  str: "Str",
  dex: "Dex",
  con: "Con",
  int: "Int",
  wis: "Wis",
  cha: "Cha",
};

interface ArmorClassOption {
  parts: Contribution[];
  armor: ArmorDef | null;
  shield: ArmorDef | null;
}

/**
 * Assume the character uses the best legal configuration: each armor they own and are trained
 * in, or no armor (plain 10 + Dex, or an alternative such as Unarmored Defense), with or without
 * a Shield. Effects that depend on it (`when: wearing_armor`) are included in the comparison.
 * Ties go to the earlier option, so you aren't put in armor that doesn't help.
 */
function bestArmorClass(
  equipment: Record<string, number>,
  training: readonly string[],
  res: Resolution,
  catalog: Catalog,
  mod: Record<Ability, number>,
  effectsFor: (target: string, conditions: Conditions) => ResolvedEffect[],
): ArmorClassOption {
  const owned = Object.keys(equipment)
    .map((id) => lookup(catalog.armor, id))
    .filter((a): a is ArmorDef => a !== undefined);
  const shieldItem = training.includes("shield")
    ? (owned.find((a) => a.category === "shield") ?? null)
    : null;

  const bodies: { parts: Contribution[]; armor: ArmorDef | null; shieldAllowed: boolean }[] = [
    {
      parts: [
        { source: "base (unarmored)", value: 10 },
        { source: "Dex", value: mod.dex },
      ],
      armor: null,
      shieldAllowed: true,
    },
  ];
  for (const src of res.sources) {
    for (const calc of src.grants.ac_calculations) {
      bodies.push({
        parts: [
          { source: calc.name, value: calc.base },
          ...calc.abilities.map((a) => ({ source: ABBREVIATIONS[a], value: mod[a] })),
        ],
        armor: null,
        shieldAllowed: calc.shield,
      });
    }
  }
  for (const armor of owned) {
    if (armor.category === "shield" || !training.includes(armor.category)) continue;
    const parts: Contribution[] = [{ source: armor.name, value: armor.base_ac }];
    if (armor.dex_cap !== 0) {
      const dex = armor.dex_cap === null ? mod.dex : Math.min(mod.dex, armor.dex_cap);
      const cap = armor.dex_cap === null ? "" : ` (max ${armor.dex_cap})`;
      parts.push({ source: `Dex${cap}`, value: dex });
    }
    bodies.push({ parts, armor, shieldAllowed: true });
  }

  let best: ArmorClassOption | null = null;
  let bestTotal = Number.NEGATIVE_INFINITY;
  for (const body of bodies) {
    for (const shield of body.shieldAllowed && shieldItem ? [null, shieldItem] : [null]) {
      const conditions: Conditions = new Map([
        ["wearing_armor", body.armor !== null],
        ["wielding_shield", shield !== null],
      ]);
      const parts = [...body.parts];
      if (shield) parts.push({ source: shield.name, value: shield.base_ac });
      for (const [op, value, source] of effectsFor("ac", conditions)) {
        if (op === "add") parts.push({ source, value });
      }
      const total = parts.reduce((sum, p) => sum + p.value, 0);
      if (total > bestTotal) {
        best = { parts, armor: body.armor, shield };
        bestTotal = total;
      }
    }
  }
  return best as ArmorClassOption;
}

function spellcastingSummary(
  res: Resolution,
  catalog: Catalog,
  mod: Record<Ability, number>,
  pb: number,
): { spellcasting: SpellcastingLine[]; spells: SpellLine[]; spellbook: string[] } {
  const spellcasting: SpellcastingLine[] = [];
  for (const src of res.sources) {
    const sc = src.grants.spellcasting;
    if (!sc) continue;
    const ability = res.resolveRef(src, sc.ability) as Ability | null;
    spellcasting.push({
      source: src.name,
      list: sc.list === null ? null : res.resolveRef(src, sc.list),
      ability,
      save_dc: ability ? 8 + pb + mod[ability] : null,
      attack_bonus: ability ? pb + mod[ability] : null,
      slots: sc.slots,
      pact: sc.pact,
    });
  }

  const spells = new Map<string, SpellLine>();
  const add = (id: string, source: string, always: boolean) => {
    const spell = lookup(catalog.spells, id);
    if (spell && !spells.has(id)) {
      spells.set(id, { id, name: spell.name, level: spell.level, source, always_prepared: always });
    }
  };
  for (const src of res.sources) {
    for (const id of src.grants.cantrips) add(id, src.name, false);
    for (const id of src.grants.spells) add(id, src.name, true);
  }
  const spellbook: string[] = [];
  for (const choice of res.choices) {
    if (choice.definition.kind !== "spell") continue;
    // A choice that another one prepares from (a spellbook) isn't itself prepared.
    const isPool = res.choices.some(
      (c) => c.source === choice.source && c.definition.subset_of === choice.definition.id,
    );
    for (const id of res.selected(choice)) {
      if (isPool) spellbook.push(id);
      else add(id, choice.source.name, choice.definition.always_prepared);
    }
  }
  const sorted = [...spells.values()].sort((a, b) => a.level - b.level);
  return { spellcasting, spells: sorted, spellbook };
}

interface AttackContext {
  catalog: Catalog;
  scores: Record<Ability, number>;
  pb: number;
  weaponProfs: readonly string[];
  masteries: readonly string[];
  rangedBonus: readonly ResolvedEffect[];
  featIds: ReadonlySet<string>;
  /** Martial Arts die size (6 = d6) while it applies, else 0. */
  martialArtsDie: number;
}

function unarmedStrike(ctx: AttackContext): AttackLine {
  const strMod = abilityModifier(ctx.scores.str);
  if (!ctx.martialArtsDie) {
    return {
      name: "Unarmed Strike",
      attack_bonus: strMod + ctx.pb,
      damage: String(Math.max(0, 1 + strMod)),
      damage_type: "bludgeoning",
      mastery: null,
      notes: [],
    };
  }
  const abilityMod = Math.max(strMod, abilityModifier(ctx.scores.dex));
  return {
    name: "Unarmed Strike",
    attack_bonus: abilityMod + ctx.pb,
    damage: withMod(`1d${ctx.martialArtsDie}`, abilityMod),
    damage_type: "bludgeoning",
    mastery: null,
    notes: ["Martial Arts", "Bonus Action: one extra Unarmed Strike"],
  };
}

function attackLine(w: WeaponDef, ctx: AttackContext): AttackLine {
  const strMod = abilityModifier(ctx.scores.str);
  const dexMod = abilityModifier(ctx.scores.dex);
  const martialArts = ctx.martialArtsDie > 0 && isMonkWeapon(w);
  let abilityMod: number;
  if (w.properties.includes("finesse") || martialArts) abilityMod = Math.max(strMod, dexMod);
  else abilityMod = w.kind === "ranged" ? dexMod : strMod;
  const proficient = isWeaponProficient(w, ctx.weaponProfs);
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
  let die = w.damage;
  if (martialArts) {
    notes.push("Martial Arts");
    const sides = Number(/^1d(\d+)$/.exec(w.damage)?.[1] ?? 0);
    if (sides < ctx.martialArtsDie) die = `1d${ctx.martialArtsDie}`;
  }
  let damage = withMod(die, abilityMod);
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
