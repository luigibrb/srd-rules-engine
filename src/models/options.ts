/**
 * What a combatant can do now (`combatantOptions`): each option is an encounter action ready to
 * send, with its cost, whether the engine would take it now and, if not, why. A computed result,
 * not a saved document.
 */

import { z } from "zod";
import { SpellAreaSchema } from "./content";
import { EncounterActionSchema } from "./encounter";
import { REFUSAL_CODES } from "./events";

/**
 * What an option spends: an action, a Bonus Action or a reaction; `attack`, one of the Attack
 * action's attacks (the first takes the action); `free` (no economy: a granted attack, moving a
 * zone, a check); `movement`; a monster's `legendary` action use.
 */
export const OPTION_COSTS = [
  "action",
  "bonus_action",
  "reaction",
  "attack",
  "free",
  "movement",
  "legendary",
] as const;
export type OptionCost = (typeof OPTION_COSTS)[number];

/** Who or what an option is aimed at. */
export const TargetSpecSchema = z.object({
  /** `creature`: ids in `target`/`targets`; `area`: a point or direction (`area`); `point`: a square. */
  kind: z.enum(["creature", "area", "self", "point"]),
  /** The most creatures it can target (`null`: not limited, or not known). */
  count: z.int().min(1).nullable(),
  /** How far, in feet (reach, long range, a spell's range, movement left); `null`: not checked. */
  range: z.int().min(0).nullable(),
  /**
   * Candidate creatures, enemies first, then nearest first: with positions, only those within
   * `range`; creatures without a position are listed last (the engine doesn't measure them).
   */
  ids: z.array(z.string()),
  /** The area's shape, for `kind: area`. */
  area: SpellAreaSchema.nullable(),
});
export type TargetSpec = z.infer<typeof TargetSpecSchema>;

export const OptionEntrySchema = z.object({
  /**
   * The encounter action to send. Its target is the first candidate (`targets.ids[0]`), or `""`
   * when there's none; an area spell has `targets: []` (send `area` instead to place it).
   */
  action: EncounterActionSchema,
  /** `Longsword +5 · 1d8+3 slashing`, `Fireball (level 3)`, `Second Wind`. */
  label: z.string(),
  cost: z.enum(OPTION_COSTS),
  /** The engine would take `action` now (a dry run with fixed dice: `checkAction`). */
  available: z.boolean(),
  /** Why not, in the engine's words; `null` when available. */
  reason: z.string().nullable(),
  /** Why not, as a code (`REFUSAL_CODES`); `null` when available. */
  code: z.enum(REFUSAL_CODES).nullable().default(null),
  targets: TargetSpecSchema.nullable(),
  /** A spell: the slot levels it can be cast with now (empty for a cantrip). */
  slot_levels: z.array(z.int()).default([]),
  /** A spell: the level of a Pact Magic slot it can use now (`pact: true`), if any. */
  pact_slot: z.int().nullable().default(null),
  /** Limited uses left (a feature's, a monster's daily uses, legendary uses this round). */
  uses: z.object({ left: z.int(), max: z.int() }).nullable().default(null),
  /**
   * The odds against its first candidate target (`target`), from the same modifiers the engine
   * would use (Advantage, cover, conditions): the chance to hit and to score a Critical Hit, or
   * that the target fails its save, and the average damage it would take (crits, a save's half
   * damage and its defenses included; features' extra dice left out). `null` when it has none.
   */
  odds: z
    .object({
      target: z.string(),
      hit: z.number().min(0).max(1).nullable(),
      critical: z.number().min(0).max(1).nullable(),
      fail_save: z.number().min(0).max(1).nullable(),
      average_damage: z.number().min(0).nullable(),
    })
    .nullable()
    .default(null),
  /** Something to know before choosing it ("Casting it ends Concentration on Bless"). */
  note: z.string().nullable().default(null),
});
export type OptionEntry = z.infer<typeof OptionEntrySchema>;

export const CombatantOptionsSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** It's this combatant's turn. */
    turn: z.boolean(),
    /** What it hasn't spent yet (the action and Bonus Action are only usable on its turn). */
    economy: z.object({
      action: z.boolean(),
      bonus_action: z.boolean(),
      reaction: z.boolean(),
      /** Feet of movement left this turn (its Speed, plus Dash, minus what it moved). */
      movement: z.int().min(0),
      /** Attacks left in the Attack action it took (Extra Attack, Multiattack). */
      attacks_left: z.int().min(0),
      /** Attacks a feature granted this turn (Flurry of Blows). */
      granted: z.object({ attack: z.string(), count: z.int() }).nullable(),
      /** A Cleave attack it can make (the weapon and the creature it hit). */
      cleave: z.object({ attack: z.string(), target: z.string() }).nullable(),
      /** A monster's legendary action uses left until the start of its turn. */
      legendary: z.object({ left: z.int(), max: z.int() }).nullable(),
    }),
    /** One per attack line, and its variants: thrown, Opportunity Attack, Light, Cleave, granted. */
    attacks: z.array(OptionEntrySchema),
    /** Spells it can cast: a character's cantrips and prepared spells, a monster's listed spells. */
    spells: z.array(OptionEntrySchema),
    /** A character's features used in turns (`sheet.actions`). */
    features: z.array(OptionEntrySchema),
    /** A monster's saving throw effects (`save_action`). */
    save_actions: z.array(OptionEntrySchema),
    /** A monster's legendary actions. */
    legendary: z.array(OptionEntrySchema),
    /** Dash, Disengage, Dodge, Help, Grapple, Shove, escape, stand up, move. */
    standard: z.array(OptionEntrySchema),
    /** The zones it created: move or end them. */
    zones: z.array(OptionEntrySchema),
  })
  .meta({ id: "CombatantOptions" });
export type CombatantOptions = z.infer<typeof CombatantOptionsSchema>;

/** The result of `checkAction`: the engine would take the action, or why not. */
export const ActionCheckSchema = z.object({
  ok: z.boolean(),
  reasons: z.array(z.string()),
  /** A code per reason (`REFUSAL_CODES`). */
  codes: z.array(z.enum(REFUSAL_CODES)),
});
export type ActionCheck = z.infer<typeof ActionCheckSchema>;
