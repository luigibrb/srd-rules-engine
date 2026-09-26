import { z } from "zod";
import { AbilityFullNameSchema } from "./character";

export const SPELL_SCHOOLS = [
  "abjuration",
  "conjuration",
  "divination",
  "enchantment",
  "evocation",
  "illusion",
  "necromancy",
  "transmutation",
] as const;
export type SpellSchool = (typeof SPELL_SCHOOLS)[number];

export const DAMAGE_TYPES = [
  "acid",
  "bludgeoning",
  "cold",
  "fire",
  "force",
  "lightning",
  "necrotic",
  "piercing",
  "poison",
  "psychic",
  "radiant",
  "slashing",
  "thunder",
] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];

export const SpellSchema = z.object({
  name: z.string(),
  level: z.int().min(0).max(9),
  school: z.enum(SPELL_SCHOOLS),
  casting_time: z.string(),
  range: z.string(),
  duration: z.string(),
  damage_dice: z.string().nullable().default(null),
  damage_type: z.enum(DAMAGE_TYPES).nullable().default(null),
  save_ability: AbilityFullNameSchema.nullable().default(null),
  attack_type: z.string().nullable().default(null),
  description: z.string().default(""),
});
export type Spell = Readonly<z.infer<typeof SpellSchema>>;
