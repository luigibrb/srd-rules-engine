/**
 * Schemas for static rules content (species, classes, backgrounds, feats, items).
 *
 * Content is data: it lives in YAML under `content/` and is validated against these schemas
 * at load time. Every top-level entity carries a stable slug `id` and a `source` tag so SRD
 * material can always be told apart from homebrew.
 */

import { z } from "zod";

export const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"] as const;
export type Ability = (typeof ABILITIES)[number];

export const ABILITY_NAMES: Readonly<Record<Ability, string>> = {
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma",
};

export const SKILLS = [
  "acrobatics",
  "animal-handling",
  "arcana",
  "athletics",
  "deception",
  "history",
  "insight",
  "intimidation",
  "investigation",
  "medicine",
  "nature",
  "perception",
  "performance",
  "persuasion",
  "religion",
  "sleight-of-hand",
  "stealth",
  "survival",
] as const;
export type Skill = (typeof SKILLS)[number];

export const SKILL_ABILITY: Readonly<Record<Skill, Ability>> = {
  acrobatics: "dex",
  "animal-handling": "wis",
  arcana: "int",
  athletics: "str",
  deception: "cha",
  history: "int",
  insight: "wis",
  intimidation: "cha",
  investigation: "int",
  medicine: "wis",
  nature: "int",
  perception: "wis",
  performance: "cha",
  persuasion: "cha",
  religion: "int",
  "sleight-of-hand": "dex",
  stealth: "dex",
  survival: "wis",
};

export function isSkill(value: string): value is Skill {
  return (SKILLS as readonly string[]).includes(value);
}

export function skillName(skill: Skill): string {
  return titleCase(skill.replaceAll("-", " ")).replace(" Of ", " of ");
}

/** Python-style `str.title()` for plain ASCII labels: "light armor" → "Light Armor". */
export function titleCase(text: string): string {
  return text.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_, pre, c) => pre + c.toUpperCase());
}

export const SIZES = ["small", "medium"] as const;
export type Size = (typeof SIZES)[number];

/**
 * Builder steps, in the order they are presented.
 *
 * Ordered by dependency: each step only needs what earlier steps decided. Equipment comes
 * before features so Weapon Mastery / Fighting Style can be picked knowing your gear, and
 * proficiencies come late so every skill grant (species, background, feats) is known before
 * you spend free picks. Spells come after features because features can decide which list
 * you pick from (Magic Initiate, Divine Order).
 */
export const STEPS = [
  "class",
  "species",
  "background",
  "abilities",
  "equipment",
  "features",
  "spells",
  "proficiencies",
  "languages",
  "details",
] as const;
export type Step = (typeof STEPS)[number];

export const CHOICE_KINDS = [
  "option", // pick among inline options, each with its own grants
  "ability",
  "skill",
  "tool",
  "skill_or_tool",
  "language",
  "feat",
  "weapon_mastery",
  "spell",
  "expertise", // a skill you're already proficient in
  "subclass", // the class's subclass (options: subclasses of the source's class)
  "ability_increase", // each pick is +1 to an ability; the same ability can be picked again
  "feature", // a selectable class feature (Eldritch Invocation, Metamagic): `features` table
] as const;
export type ChoiceKind = (typeof CHOICE_KINDS)[number];

const DEFAULT_STEP_BY_KIND: Partial<Record<ChoiceKind, Step>> = {
  skill: "proficiencies",
  tool: "proficiencies",
  skill_or_tool: "proficiencies",
  language: "languages",
  feat: "features",
  weapon_mastery: "features",
  spell: "spells",
  expertise: "proficiencies",
  subclass: "features",
  ability_increase: "features",
  feature: "features",
};

export const EFFECT_OPS = ["add", "set", "max", "min"] as const;
export type EffectOp = (typeof EFFECT_OPS)[number];

/** Effect targets the sheet reads, besides the per-skill, per-save and per-score ones. */
const EFFECT_TARGET_NAMES = [
  "ac",
  "attack.critical",
  "attack.ranged",
  "attacks",
  "checks",
  "darkvision",
  "hp_per_class_level",
  "hp_per_level",
  "initiative",
  "martial_arts.die",
  "saves",
  "skill.unproficient",
  "speed",
] as const;
export type EffectTarget =
  | (typeof EFFECT_TARGET_NAMES)[number]
  | `skill.${Skill}`
  | `save.${Ability}`
  | `score.${Ability}`;
/** Every effect target the sheet understands; content using any other target is rejected. */
export const EFFECT_TARGETS: readonly EffectTarget[] = [
  ...EFFECT_TARGET_NAMES,
  ...SKILLS.map((s) => `skill.${s}` as const),
  ...ABILITIES.map((a) => `save.${a}` as const),
  ...ABILITIES.map((a) => `score.${a}` as const),
];

/** Conditions an effect can depend on (`when`), evaluated from what the character wears. */
export const EFFECT_CONDITIONS = [
  "wearing_armor",
  "wielding_shield",
  "wearing_heavy_armor",
  "not_wearing_heavy_armor",
  "unarmored",
] as const;
export type EffectCondition = (typeof EFFECT_CONDITIONS)[number];

/**
 * A declarative numeric modifier. Minimal precursor of the full Effect engine.
 *
 * `target` is one of `EFFECT_TARGETS`. `value` is an integer, the token `"prof"` (Proficiency
 * Bonus), `"half_prof"` (half of it, rounded down) or an ability (`"wis"`: that ability's
 * modifier). `min` is a floor for the value ("Wisdom modifier, minimum of +1"). `when` is one
 * of `EFFECT_CONDITIONS`.
 */
export const EffectSchema = z.strictObject({
  target: z.enum(EFFECT_TARGETS as [EffectTarget, ...EffectTarget[]], {
    error: (issue) => `unknown effect target '${String(issue.input)}' (see docs/CONTENT.md)`,
  }),
  op: z.enum(EFFECT_OPS).default("add"),
  value: z.union([z.int(), z.literal("prof"), z.literal("half_prof"), z.enum(ABILITIES)]),
  min: z.int().nullable().default(null),
  when: z
    .enum(EFFECT_CONDITIONS, {
      error: (issue) => `unknown effect condition '${String(issue.input)}' (see docs/CONTENT.md)`,
    })
    .nullable()
    .default(null),
});
export type Effect = z.infer<typeof EffectSchema>;

export const TraitSchema = z.strictObject({ name: z.string(), text: z.string() });
export type Trait = z.infer<typeof TraitSchema>;

/**
 * An alternative way to compute Armor Class while wearing no armor (Unarmored Defense, Mage
 * Armor): `base` + the listed ability modifiers. The sheet uses whichever option is best; they
 * never stack with each other or with worn armor.
 */
export const AcCalculationSchema = z.strictObject({
  name: z.string(),
  base: z.int().default(10),
  abilities: z.array(z.enum(ABILITIES)),
  /** Whether a Shield can still be used (Barbarian: yes; Monk: no). */
  shield: z.boolean().default(true),
});
export type AcCalculation = z.infer<typeof AcCalculationSchema>;

/**
 * A spellcasting feature. `list` is a class spell list id (`null` for a fixed set of spells,
 * like a species' cantrips); `ability` is the spellcasting ability. Either can be
 * `"$<choice id>"` to use the answer to one of the same source's choices (Magic Initiate lets
 * you pick both).
 */
export const SpellcastingSchema = z.strictObject({
  list: z.string().nullable().default(null),
  ability: z.string(),
  /**
   * How class levels turn into spell slots: `full` (each level counts), `half` (half, rounded
   * up), both through the Multiclass Spellcaster table in the creation rules; `pact` (Warlock
   * Pact Magic, from `pact_slots`); `null` for spells cast without class slots.
   */
  progression: z.enum(["full", "half", "pact"]).nullable().default(null),
  /** Pact Magic by class level (20 entries): number of slots and their level. */
  pact_slots: z.array(z.strictObject({ count: z.int(), level: z.int() })).default([]),
});
export type Spellcasting = z.infer<typeof SpellcastingSchema>;

/** A fixed ability score increase with its own cap (Primal Champion: Str +4, max 25). */
export const AbilityBonusSchema = z.strictObject({
  ability: z.enum(ABILITIES),
  value: z.int(),
  max: z.int().default(20),
});
export type AbilityBonus = z.infer<typeof AbilityBonusSchema>;

/**
 * A limited-use feature (Rage, Channel Divinity, Sorcery Points…). The maximum is one of:
 * `value`, a class table column (`progression`), an ability modifier (`ability`, with `min`),
 * the Proficiency Bonus (`proficiency`), or `per_class_level` × the class level. A later source
 * with the same `id` in the same class replaces the earlier definition (Action Surge: 2 uses at
 * level 17).
 */
export const ResourceSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  max: z.strictObject({
    value: z.int().nullable().default(null),
    progression: z.string().nullable().default(null),
    ability: z.enum(ABILITIES).nullable().default(null),
    proficiency: z.boolean().default(false),
    per_class_level: z.int().nullable().default(null),
    min: z.int().default(0),
  }),
  /** `short`: all uses back on a Short or Long Rest; `long`: on a Long Rest. */
  recharge: z.enum(["short", "long"]),
  /** For `long` resources that also regain some uses on a Short Rest (Rage: 1). */
  short_rest_regain: z.int().nullable().default(null),
});
export type ResourceDef = z.infer<typeof ResourceSchema>;

export const ItemGrantSchema = z.strictObject({
  item: z.string(),
  qty: z.int().min(1).default(1),
});
export type ItemGrant = z.infer<typeof ItemGrantSchema>;

export const FeatGrantSchema = z.strictObject({
  feat: z.string(),
  /** Pre-filled answers to the feat's own choices, e.g. `{spell_list: cleric}`. */
  params: z.record(z.string(), z.string()).default({}),
});
export type FeatGrant = z.infer<typeof FeatGrantSchema>;

// Grants → ChoiceDef → ChoiceOption → Grants is recursive, so these three types are written
// out by hand and the schemas are annotated with them.

export interface ChoiceOption {
  id: string;
  name: string;
  description: string;
  grants: Grants;
}

export interface ChoiceDef {
  id: string;
  label: string;
  kind: ChoiceKind;
  count: number;
  /** For `kind: option`. */
  options: ChoiceOption[];
  /** Restricts ids for other kinds; `null` means any. */
  allowed: string[] | null;
  /** Feat/tool/language/weapon category filter (any of these). */
  category: string[] | null;
  step: Step | null;
  hint: string;
  /** `kind: spell`: only spells of this level. */
  spell_level: number | null;
  /** `kind: spell`: spells of level 1 up to this one (a level you have slots for). */
  max_spell_level: number | null;
  /**
   * `kind: spell`: class spell lists (any of them), each possibly `"$<choice id>"` for the
   * answer to a sibling choice. `null` means any list.
   */
  spell_list: string[] | null;
  /** `kind: spell`: only spells you already have from another source (Agonizing Blast). */
  known_only: boolean;
  /** A label shared by related choices; `subset_of` refers to it. */
  tag: string | null;
  /** `kind: ability_increase`: the score can't go above this. */
  max_score: number;
  /** `kind: spell`: only spells with the Ritual tag. */
  ritual: boolean;
  /** `kind: spell`: only spells of this school (Evoker: evocation). */
  school: string | null;
  /** `kind: spell`: the picks are always prepared (they don't count against a class's limit). */
  always_prepared: boolean;
  /**
   * A list that grows with the class and can be changed freely (SRD: "after a Long Rest"):
   * `count` / `max_spell_level` by the source class's current level (20 values each).
   */
  scaling: { count: number[] | null; max_spell_level: number[] | null } | null;
  /**
   * The picks can be replaced one at a time later (SRD: "whenever you gain a level, you can
   * replace one…"): `class_level` at each later level in the source's class, `any_level` at every
   * later character level (Magic Initiate). Choices with the same `tag` form one family.
   */
  swap: "class_level" | "any_level" | null;
  /** A replacement spell must be of the same level as the one it replaces. */
  same_level: boolean;
  /**
   * The picks can be changed after a rest (SRD: "whenever you finish a Long Rest, you can
   * change…"). The build holds a starting set; the play state holds today's picks.
   */
  rest_change: "short" | "long" | null;
  /** Options are limited to what the choices with this `tag` picked (Wizard: prepare from the spellbook). */
  subset_of: string | null;
  /** `kind: weapon_mastery`: only melee or ranged weapons. */
  weapon_kind: "melee" | "ranged" | null;
}

export interface Grants {
  size: Size | null;
  skills: Skill[];
  tools: string[];
  languages: string[];
  saving_throws: Ability[];
  armor_training: string[];
  weapon_proficiencies: string[];
  feats: FeatGrant[];
  resistances: string[];
  cantrips: string[];
  /** Spells you always have prepared (Hunter's Mark, Speak with Animals…). */
  spells: string[];
  spellcasting: Spellcasting | null;
  ac_calculations: AcCalculation[];
  ability_bonuses: AbilityBonus[];
  /** Limited-use features tracked in play (Rage, Second Wind…). */
  resources: ResourceDef[];
  /** Things a Long Rest gives besides recovery (Human: Heroic Inspiration). */
  on_long_rest: "heroic_inspiration"[];
  effects: Effect[];
  items: ItemGrant[];
  gp: number;
  traits: Trait[];
  choices: ChoiceDef[];
  /**
   * More grants that switch on as the source's class gains levels, e.g. a subclass's spells at
   * class levels 5, 7 and 9, or what a Land type gives at level 10.
   */
  at_class_level: { level: number; grants: Grants }[];
}

/** Grants fields that are plain lists of ids, usable with `Resolution.granted()`. */
export type GrantedIdList =
  | "armor_training"
  | "weapon_proficiencies"
  | "resistances"
  | "cantrips"
  | "spells";

export const ChoiceOptionSchema: z.ZodType<ChoiceOption, unknown> = z
  .lazy(() =>
    z.strictObject({
      id: z.string(),
      name: z.string(),
      description: z.string().default(""),
      grants: GrantsSchema.prefault({}),
    }),
  )
  .meta({ id: "ChoiceOption" });

export const ChoiceDefSchema: z.ZodType<ChoiceDef, unknown> = z
  .lazy(() =>
    z
      .strictObject({
        id: z.string(),
        label: z.string(),
        kind: z.enum(CHOICE_KINDS),
        count: z.int().min(1).default(1),
        options: z.array(ChoiceOptionSchema).default([]),
        allowed: z.array(z.string()).nullable().default(null),
        category: z
          .union([z.string(), z.array(z.string())])
          .transform((c) => (typeof c === "string" ? [c] : c))
          .nullable()
          .default(null),
        step: z.enum(STEPS).nullable().default(null),
        hint: z.string().default(""),
        spell_level: z.int().min(0).max(9).nullable().default(null),
        max_spell_level: z.int().min(1).max(9).nullable().default(null),
        spell_list: z
          .union([z.string(), z.array(z.string())])
          .transform((c) => (typeof c === "string" ? [c] : c))
          .nullable()
          .default(null),
        known_only: z.boolean().default(false),
        tag: z.string().nullable().default(null),
        max_score: z.int().default(20),
        ritual: z.boolean().default(false),
        school: z.string().nullable().default(null),
        always_prepared: z.boolean().default(false),
        subset_of: z.string().nullable().default(null),
        scaling: z
          .strictObject({
            count: z.array(z.int().min(0)).length(20).nullable().default(null),
            max_spell_level: z.array(z.int().min(0).max(9)).length(20).nullable().default(null),
          })
          .nullable()
          .default(null),
        swap: z.enum(["class_level", "any_level"]).nullable().default(null),
        same_level: z.boolean().default(false),
        rest_change: z.enum(["short", "long"]).nullable().default(null),
        weapon_kind: z.enum(["melee", "ranged"]).nullable().default(null),
      })
      .refine((c) => c.swap === null || c.tag !== null, {
        error: (issue) =>
          `choice '${(issue.input as { id?: string }).id}': a choice with \`swap\` needs a \`tag\` (its family)`,
      })
      .refine((c) => (c.kind === "option") === c.options.length > 0, {
        error: (issue) =>
          `choice '${(issue.input as { id?: string }).id}': inline options are required iff kind=option`,
      }),
  )
  .meta({ id: "ChoiceDef" });

/** Everything a content source gives the character, plus the choices it asks for. */
export const GrantsSchema: z.ZodType<Grants, unknown> = z
  .lazy(() =>
    z.strictObject({
      size: z.enum(SIZES).nullable().default(null),
      skills: z.array(z.enum(SKILLS)).default([]),
      tools: z.array(z.string()).default([]),
      languages: z.array(z.string()).default([]),
      saving_throws: z.array(z.enum(ABILITIES)).default([]),
      armor_training: z.array(z.string()).default([]),
      weapon_proficiencies: z.array(z.string()).default([]),
      feats: z.array(FeatGrantSchema).default([]),
      resistances: z.array(z.string()).default([]),
      cantrips: z.array(z.string()).default([]),
      spells: z.array(z.string()).default([]),
      spellcasting: SpellcastingSchema.nullable().default(null),
      ac_calculations: z.array(AcCalculationSchema).default([]),
      ability_bonuses: z.array(AbilityBonusSchema).default([]),
      resources: z.array(ResourceSchema).default([]),
      on_long_rest: z.array(z.enum(["heroic_inspiration"])).default([]),
      effects: z.array(EffectSchema).default([]),
      items: z.array(ItemGrantSchema).default([]),
      gp: z.int().default(0),
      traits: z.array(TraitSchema).default([]),
      choices: z.array(ChoiceDefSchema).default([]),
      at_class_level: z
        .array(z.strictObject({ level: z.int().min(1).max(20), grants: GrantsSchema }))
        .default([]),
    }),
  )
  .meta({ id: "Grants" });

/** The builder step a choice is asked in. */
export function choiceStep(choice: ChoiceDef): Step {
  return choice.step ?? DEFAULT_STEP_BY_KIND[choice.kind] ?? "features";
}

/**
 * Where content comes from when an entity doesn't say: `createCatalog` fills in the pack's name
 * instead (`srd-5.2.1` for the SRD folder), so this default only applies to schemas used alone.
 */
export const DEFAULT_SOURCE = "homebrew";

const entity = {
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "ids are lowercase slugs"),
  name: z.string(),
  source: z.string().default(DEFAULT_SOURCE),
  description: z.string().default(""),
};

export const SpeciesSchema = z.strictObject({
  ...entity,
  creature_type: z.string().default("Humanoid"),
  grants: GrantsSchema,
});
export type SpeciesDef = z.infer<typeof SpeciesSchema>;

export const BackgroundSchema = z.strictObject({
  ...entity,
  ability_scores: z.array(z.enum(ABILITIES)).length(3),
  grants: GrantsSchema,
});
export type BackgroundDef = z.infer<typeof BackgroundSchema>;

export const ClassSchema = z.strictObject({
  ...entity,
  primary_abilities: z.array(z.enum(ABILITIES)),
  /** `any` (Str OR Dex) or `all` (Dex AND Wis). */
  primary_mode: z.enum(["any", "all"]).default("any"),
  hit_die: z.int(),
  complexity: z.string(),
  standard_array: z.record(z.enum(ABILITIES), z.int()),
  /** Core traits, gained only when this is your first class: saves, skills, proficiencies, gear. */
  grants: GrantsSchema,
  /** What you gain instead of `grants` when you multiclass into this class. */
  multiclass: GrantsSchema.prefault({}),
  /** Features by class level (`1`–`20`). Level 1 features apply to both starting and multiclass. */
  features: z.record(z.string().regex(/^([1-9]|1[0-9]|20)$/), GrantsSchema).default({}),
  /**
   * Named columns of the class table, one value per class level (20 values), shown on the
   * sheet as class resources, e.g. `Rages: [2, 2, 3, …]`.
   */
  progression: z.record(z.string(), z.array(z.union([z.int(), z.string()])).length(20)).default({}),
  /** The class level at which you choose a subclass. */
  subclass_level: z.int().min(1).max(20).default(3),
});
export type ClassDef = z.infer<typeof ClassSchema>;

export const SubclassSchema = z.strictObject({
  ...entity,
  /** The class this subclass belongs to. */
  class: z.string(),
  /** Features by class level. */
  features: z.record(z.string().regex(/^([1-9]|1[0-9]|20)$/), GrantsSchema).default({}),
});
export type SubclassDef = z.infer<typeof SubclassSchema>;

/**
 * What you need to take a feat or a class feature option. Every listed condition must hold.
 * Character level counts levels in all classes; `class_level` counts one class.
 */
export const PrerequisiteSchema = z.strictObject({
  level: z.int().nullable().default(null),
  class_level: z
    .strictObject({ class: z.string(), level: z.int().default(1) })
    .nullable()
    .default(null),
  /** At least one of these abilities must have a score of `min` or more. */
  abilities: z
    .strictObject({ any_of: z.array(z.enum(ABILITIES)), min: z.int() })
    .nullable()
    .default(null),
  /** Feats or features (ids) you must already have. */
  requires: z.array(z.string()).default([]),
  /** A trait you must have, by name (e.g. "Fighting Style"). */
  trait: z.string().nullable().default(null),
  /** You must have a Spellcasting or Pact Magic feature. */
  spellcasting: z.boolean().default(false),
  /** You must know at least one of these spells. */
  spells: z.array(z.string()).default([]),
});
export type Prerequisite = z.infer<typeof PrerequisiteSchema>;

export const FeatSchema = z.strictObject({
  ...entity,
  /** origin, general, fighting_style, epic_boon; features: eldritch_invocation, metamagic */
  category: z.string(),
  prerequisite: PrerequisiteSchema.nullable().default(null),
  repeatable: z.boolean().default(false),
  /** For repeatable feats: each instance must pick a different value for this choice id. */
  repeat_requires_different: z.string().nullable().default(null),
  grants: GrantsSchema.prefault({}),
  /** Notes about parts of the feat the builder does not automate yet. */
  unsupported: z.string().default(""),
});
export type FeatDef = z.infer<typeof FeatSchema>;

export const WeaponSchema = z.strictObject({
  ...entity,
  category: z.enum(["simple", "martial"]),
  kind: z.enum(["melee", "ranged"]),
  damage: z.string(),
  damage_type: z.string(),
  properties: z.array(z.string()).default([]),
  versatile_damage: z.string().nullable().default(null),
  range: z.string().nullable().default(null),
  mastery: z.string(),
  weight: z.string().default(""),
  cost: z.string().default(""),
});
export type WeaponDef = z.infer<typeof WeaponSchema>;

export const ArmorSchema = z.strictObject({
  ...entity,
  category: z.enum(["light", "medium", "heavy", "shield"]),
  base_ac: z.int(),
  /** `null` = no cap; `0` = Dex not added. */
  dex_cap: z.int().nullable().default(null),
  strength: z.int().nullable().default(null),
  stealth_disadvantage: z.boolean().default(false),
  weight: z.string().default(""),
  cost: z.string().default(""),
});
export type ArmorDef = z.infer<typeof ArmorSchema>;

export const GearSchema = z.strictObject({ ...entity });
export type GearDef = z.infer<typeof GearSchema>;

export const ToolSchema = z.strictObject({
  ...entity,
  /** artisan | gaming-set | musical-instrument | other */
  category: z.string(),
});
export type ToolDef = z.infer<typeof ToolSchema>;

export const LanguageSchema = z.strictObject({
  ...entity,
  /** standard | rare */
  category: z.string(),
});
export type LanguageDef = z.infer<typeof LanguageSchema>;

export const MasterySchema = z.strictObject({ ...entity });
export type MasteryDef = z.infer<typeof MasterySchema>;

export const SpellDefSchema = z.strictObject({
  ...entity,
  level: z.int().min(0).max(9),
  school: z.string(),
  /** Class spell lists that include this spell, e.g. `[cleric, druid]`. */
  lists: z.array(z.string()),
  casting_time: z.string(),
  ritual: z.boolean().default(false),
  range: z.string(),
  components: z.string(),
  duration: z.string(),
  concentration: z.boolean().default(false),
});
export type SpellDef = z.infer<typeof SpellDefSchema>;

/** A condition (SRD Rules Glossary). Exhaustion has levels; others are on or off. */
export const ConditionSchema = z.strictObject({
  ...entity,
  /** Your Speed is 0 and can't increase. */
  speed_zero: z.boolean().default(false),
  /** Conditions this one includes (Unconscious: Incapacitated and Prone). */
  implies: z.array(z.string()).default([]),
  /** Stacks in levels (Exhaustion: 1–6). */
  levels: z.boolean().default(false),
});
export type ConditionDef = z.infer<typeof ConditionSchema>;

export const MAGIC_ITEM_CATEGORIES = [
  "armor",
  "weapon",
  "ammunition",
  "potion",
  "ring",
  "rod",
  "scroll",
  "staff",
  "wand",
  "wondrous",
] as const;

/**
 * A magic item. Armor, weapons and some staffs are magic versions of a mundane item: `base`
 * says which ones, and each item in an inventory records the one it is. While the item is
 * active (worn or held, and attuned if it requires Attunement) its `grants` apply, and `bonus`
 * adds to the base weapon's attacks or the base armor's AC.
 */
export const MagicItemSchema = z.strictObject({
  ...entity,
  category: z.enum(MAGIC_ITEM_CATEGORIES),
  rarity: z.string(),
  attunement: z.boolean().default(false),
  /** Who can attune, as the SRD words it ("a Paladin", "a Spellcaster"). */
  attunement_by: z.string().nullable().default(null),
  /** Classes allowed to attune, parsed from `attunement_by` (empty: anyone, or see the text). */
  attunement_classes: z.array(z.string()).default([]),
  /** Attunement needs a Spellcasting or Pact Magic feature. */
  attunement_spellcaster: z.boolean().default(false),
  base: z
    .strictObject({
      kind: z.enum(["weapon", "armor", "shield", "ammunition"]),
      ids: z.array(z.string()).nullable().default(null),
      categories: z.array(z.string()).nullable().default(null),
      except: z.array(z.string()).default([]),
      /** For weapons: only melee (Flame Tongue: "Any Melee Weapon") or only ranged. */
      weapon_kind: z.enum(["melee", "ranged"]).nullable().default(null),
    })
    .nullable()
    .default(null),
  bonus: z
    .strictObject({
      attack: z.int().default(0),
      damage: z.int().default(0),
      ac: z.int().default(0),
      spell_attack: z.int().default(0),
    })
    .prefault({}),
  grants: GrantsSchema.prefault({}),
  /** `equipped` (worn or held) or `carried` ("while it is on your person"). */
  active_when: z.enum(["equipped", "carried"]).default("equipped"),
  charges: z.int().nullable().default(null),
  consumable: z.boolean().default(false),
  /** The base armor loses its Strength requirement and Stealth Disadvantage (Mithral). */
  ignores_armor_penalties: z.boolean().default(false),
  /** Hit Points regained when used (potions), as dice: `2d4+2`. */
  heal: z.string().nullable().default(null),
  /** Kinds of this item; each inventory item picks one (Ring of Resistance: the damage type). */
  variants: z
    .array(z.strictObject({ id: z.string(), name: z.string(), grants: GrantsSchema.prefault({}) }))
    .default([]),
});
export type MagicItemDef = z.infer<typeof MagicItemSchema>;

export const PointBuySchema = z.strictObject({
  budget: z.int(),
  min_score: z.int(),
  max_score: z.int(),
  /** Score → cost. Keys are strings once parsed from JSON/YAML. */
  costs: z.record(z.string().regex(/^\d+$/), z.int()),
});
export type PointBuyRules = z.infer<typeof PointBuySchema>;

export const CreationSchema = z.strictObject({
  source: z.string().default(DEFAULT_SOURCE),
  standard_array: z.array(z.int()),
  point_buy: PointBuySchema,
  max_score_at_creation: z.int(),
  base_grants: GrantsSchema,
  /** Fixed Hit Points per level after 1 are hit die / 2 + 1 (SRD "Gaining a Level"). */
  max_level: z.int().default(20),
  /** Minimum score in the primary abilities to multiclass (into and out of a class). */
  multiclass_min_score: z.int().default(13),
  /**
   * Multiclass Spellcaster table: spell slots per spell level for each caster level (1–20).
   * Single-class full and half casters use it too (their tables match it).
   */
  spell_slots: z.array(z.array(z.int())).length(20),
});
export type CreationRules = z.infer<typeof CreationSchema>;
