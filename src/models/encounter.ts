/**
 * An encounter: combatants in initiative order, the round and whose turn it is, and what each has
 * spent this turn. A saved document of its own, like `CharacterState`.
 *
 * Characters are referenced by a key into the caller's characters (build + state): their HP and
 * conditions stay in their `CharacterState`. Monsters live here, with their current HP and
 * conditions (the stat block in the catalog holds the rest).
 */

import { z } from "zod";
import { PlayActionSchema } from "./state";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "ids are lowercase slugs");

export const EncounterCombatantSchema = z.object({
  id,
  name: z.string(),
  /** Who's on whose side (`party`, `enemies`…): informational. */
  side: z.string().default(""),
  /** A monster's catalog id… */
  monster: z.string().nullable().default(null),
  /** …or the key of a character in the caller's `characters`. */
  character: z.string().nullable().default(null),
  /** The Initiative count; `null` until rolled. */
  initiative: z.int().nullable().default(null),
  /** Monsters only: current HP, Temporary HP and conditions. */
  hp: z.int().min(0).nullable().default(null),
  temp_hp: z.int().min(0).default(0),
  conditions: z.array(z.string()).default([]),
  /** A monster at 0 Hit Points (SRD "Monster Death"): skipped in the turn order. */
  defeated: z.boolean().default(false),
  /** Spent this turn (the reaction until the start of its next turn). */
  used: z
    .object({
      action: z.boolean().default(false),
      bonus_action: z.boolean().default(false),
      reaction: z.boolean().default(false),
    })
    .prefault({}),
  /** Feet moved this turn, and extra movement from Dash. */
  moved: z.int().min(0).default(0),
  extra_movement: z.int().min(0).default(0),
});
export type EncounterCombatant = z.infer<typeof EncounterCombatantSchema>;

export const EncounterSchema = z.object({
  /** 0 before the fight starts. */
  round: z.int().min(0).default(0),
  /** Index into `order` of whose turn it is. */
  turn: z.int().min(0).default(0),
  /** Combatant ids in initiative order (set when the fight starts). */
  order: z.array(z.string()).default([]),
  combatants: z.array(EncounterCombatantSchema).default([]),
});
export type Encounter = z.infer<typeof EncounterSchema>;

export function parseEncounter(input: unknown): Encounter {
  return EncounterSchema.parse(input);
}

const n = z.int();
export const ECONOMY = ["action", "bonus_action", "reaction"] as const;

/** Everything that can happen in an encounter, as plain JSON. */
export const EncounterActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_monster"),
    monster: z.string(),
    /** Default: the monster's id, numbered if taken (`goblin-warrior-2`). */
    id: id.optional(),
    name: z.string().optional(),
    side: z.string().optional(),
    /** Fixed HP; default the stat block's average, or `roll_hp` to roll its Hit Dice. */
    hp: n.min(1).optional(),
    roll_hp: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("add_character"),
    character: z.string(),
    id: id.optional(),
    name: z.string().optional(),
    side: z.string().optional(),
  }),
  z.object({ type: z.literal("remove"), id: z.string() }),
  z.object({
    type: z.literal("roll_initiative"),
    /** Who rolls (default: everyone without an Initiative yet). */
    ids: z.array(z.string()).optional(),
    /** Surprised combatants roll with Disadvantage. */
    surprised: z.array(z.string()).optional(),
    /** Identical monsters (same stat block) share one roll. */
    group: z.boolean().optional(),
  }),
  z.object({ type: z.literal("set_initiative"), id: z.string(), value: n }),
  /** Put tied combatants in the order the GM and players decide: every id, in order. */
  z.object({ type: z.literal("set_order"), ids: z.array(z.string()) }),
  z.object({ type: z.literal("start") }),
  z.object({ type: z.literal("next_turn") }),
  z.object({ type: z.literal("end") }),
  z.object({ type: z.literal("use"), id: z.string(), what: z.enum(ECONOMY) }),
  z.object({ type: z.literal("move"), id: z.string(), feet: n.min(0) }),
  /** The Dash action: uses the action, adds the combatant's Speed to this turn's movement. */
  z.object({ type: z.literal("dash"), id: z.string() }),
  /**
   * Apply play actions to a combatant (what `makeAttack`, `castSpell` and `useSaveAction` return):
   * a character's go to its state; a monster supports damage, heal, set_temp_hp and conditions.
   */
  z.object({ type: z.literal("effects"), id: z.string(), actions: z.array(PlayActionSchema) }),
]);
export type EncounterAction = z.infer<typeof EncounterActionSchema>;
