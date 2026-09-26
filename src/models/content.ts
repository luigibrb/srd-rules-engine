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
};

export const EFFECT_OPS = ["add", "set", "max"] as const;
export type EffectOp = (typeof EFFECT_OPS)[number];

/**
 * A declarative numeric modifier. Minimal precursor of the full Effect engine.
 *
 * `value` is an integer, the token `"prof"` (Proficiency Bonus) or an ability (`"wis"`: that
 * ability's modifier). `min` is a floor for the value ("Wisdom modifier, minimum of +1").
 * `when` names a condition evaluated by the sheet calculator (e.g. `"wearing_armor"`).
 */
export const EffectSchema = z.strictObject({
  target: z.string(),
  op: z.enum(EFFECT_OPS).default("add"),
  value: z.union([z.int(), z.literal("prof"), z.enum(ABILITIES)]),
  min: z.int().nullable().default(null),
  when: z.string().nullable().default(null),
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
  /** Spell slots per spell level: `[2]` = two level 1 slots. */
  slots: z.array(z.int().min(0)).default([]),
  /** Warlock Pact Magic: slots come back on a Short Rest. */
  pact: z.boolean().default(false),
});
export type Spellcasting = z.infer<typeof SpellcastingSchema>;

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
  /** `kind: spell`: a class spell list, or `"$<choice id>"` for the answer to a sibling choice. */
  spell_list: string | null;
  /** `kind: spell`: only spells with the Ritual tag. */
  ritual: boolean;
  /** `kind: spell`: the picks are always prepared (they don't count against a class's limit). */
  always_prepared: boolean;
  /** Options are limited to what a sibling choice picked (Wizard: prepare from spellbook). */
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
  effects: Effect[];
  items: ItemGrant[];
  gp: number;
  traits: Trait[];
  choices: ChoiceDef[];
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
        spell_list: z.string().nullable().default(null),
        ritual: z.boolean().default(false),
        always_prepared: z.boolean().default(false),
        subset_of: z.string().nullable().default(null),
        weapon_kind: z.enum(["melee", "ranged"]).nullable().default(null),
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
      effects: z.array(EffectSchema).default([]),
      items: z.array(ItemGrantSchema).default([]),
      gp: z.int().default(0),
      traits: z.array(TraitSchema).default([]),
      choices: z.array(ChoiceDefSchema).default([]),
    }),
  )
  .meta({ id: "Grants" });

/** The builder step a choice is asked in. */
export function choiceStep(choice: ChoiceDef): Step {
  return choice.step ?? DEFAULT_STEP_BY_KIND[choice.kind] ?? "features";
}

const entity = {
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "ids are lowercase slugs"),
  name: z.string(),
  source: z.string().default("srd-5.2.1"),
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
  /** Level 1 grants (core traits + level 1 features). */
  grants: GrantsSchema,
});
export type ClassDef = z.infer<typeof ClassSchema>;

export const FeatSchema = z.strictObject({
  ...entity,
  /** origin, general, fighting_style, epic_boon */
  category: z.string(),
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

export const PointBuySchema = z.strictObject({
  budget: z.int(),
  min_score: z.int(),
  max_score: z.int(),
  /** Score → cost. Keys are strings once parsed from JSON/YAML. */
  costs: z.record(z.string().regex(/^\d+$/), z.int()),
});
export type PointBuyRules = z.infer<typeof PointBuySchema>;

export const CreationSchema = z.strictObject({
  source: z.string().default("srd-5.2.1"),
  standard_array: z.array(z.int()),
  point_buy: PointBuySchema,
  max_score_at_creation: z.int(),
  base_grants: GrantsSchema,
});
export type CreationRules = z.infer<typeof CreationSchema>;
