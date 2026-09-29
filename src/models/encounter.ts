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
  /** Attacks left in this turn's Attack action (Extra Attack). */
  attacks_left: z.int().min(0).default(0),
  /** Once-per-turn riders already used this turn (Sneak Attack), reset at every turn's start. */
  riders_used: z.array(z.string()).default([]),
  /** Abilities with a Recharge that were used and haven't recharged (`Fire Breath`). */
  expended: z.array(z.string()).default([]),
  /** Monsters only: what it's concentrating on. */
  concentration: z.string().nullable().default(null),
  /** Toggles (Rage) switched on this turn, and whether one was extended this turn. */
  toggled_on: z.array(z.string()).default([]),
  extended: z.boolean().default(false),
});
export type EncounterCombatant = z.infer<typeof EncounterCombatantSchema>;

/**
 * When a timed effect ends: at the start or end of the `count`-th turn of combatant `of` (from
 * now). "Until the end of its next turn" is `{ at: end, of: it, count: 1 }`; "1 minute" is
 * `{ at: start, of: the source, count: 10 }`.
 */
export const EffectEndSchema = z.object({
  at: z.enum(["start", "end"]),
  of: z.string(),
  count: z.int().min(1),
  /** Created during `of`'s own turn: that turn's end doesn't count. */
  skip_current: z.boolean().default(false),
});
export type EffectEnd = z.infer<typeof EffectEndSchema>;

/** A condition with a duration or tied to someone's Concentration (Hold Person). */
export const EncounterEffectSchema = z.object({
  id: z.string(),
  target: z.string(),
  condition: z.string(),
  /** What caused it: `Hold Person`. With `concentration`, the source's Concentration on it. */
  label: z.string(),
  source: z.string().nullable().default(null),
  concentration: z.boolean().default(false),
  ends: EffectEndSchema.nullable().default(null),
});
export type EncounterEffect = z.infer<typeof EncounterEffectSchema>;

export const EncounterSchema = z.object({
  /** 0 before the fight starts. */
  round: z.int().min(0).default(0),
  /** Index into `order` of whose turn it is. */
  turn: z.int().min(0).default(0),
  /** Combatant ids in initiative order (set when the fight starts). */
  order: z.array(z.string()).default([]),
  combatants: z.array(EncounterCombatantSchema).default([]),
  /** Timed and Concentration effects in play. */
  effects: z.array(EncounterEffectSchema).default([]),
  /** Next effect id number. */
  next_effect: z.int().min(1).default(1),
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
  z.object({
    type: z.literal("effects"),
    id: z.string(),
    actions: z.array(PlayActionSchema),
    /** Who caused them: a condition added here becomes a timed effect when a duration is given. */
    source: z.string().optional(),
    /** `N` rounds (ends at the start of the source's turn, or the target's), or… */
    rounds: n.min(1).optional(),
    /** …until the start or end of someone's next turn (default: the source's). */
    until: z.object({ at: z.enum(["start", "end"]), of: z.string().optional() }).optional(),
    /** The conditions end when the source's Concentration on `label` ends. */
    concentration: z.boolean().optional(),
    label: z.string().optional(),
  }),
  z.object({ type: z.literal("end_effect"), effect: z.string() }),
  /**
   * One attack with an attack line (`makeAttack`), applied to the target. The first attack of a
   * turn uses the action (Extra Attack allows more); `reaction: true` makes it an Opportunity
   * Attack. Once-per-turn riders are enforced; an attack roll extends Rage.
   */
  z.object({
    type: z.literal("attack"),
    id: z.string(),
    target: z.string(),
    attack: z.string(),
    mode: z.enum(["normal", "advantage", "disadvantage"]).optional(),
    two_handed: z.boolean().optional(),
    riders: z.array(z.object({ rider: z.string(), type: z.string().optional() })).optional(),
    ally_adjacent: z.boolean().optional(),
    /** Within 5 feet of the target (default: a melee attack is, a ranged one isn't). */
    within_5ft: z.boolean().optional(),
    reaction: z.boolean().optional(),
  }),
  /** A saving throw effect (a monster's breath weapon) against targets; uses the action. */
  z.object({
    type: z.literal("save_action"),
    id: z.string(),
    ability: z.string(),
    targets: z.array(z.string()),
  }),
  /**
   * Cast a catalog spell (`castSpell`): uses the action, Bonus Action or reaction its casting
   * time says, spends the slot, applies the effects; a Concentration spell's conditions last
   * while the caster concentrates, up to its duration.
   */
  z.object({
    type: z.literal("cast"),
    id: z.string(),
    spell: z.string(),
    targets: z.array(z.string()).default([]),
    slot_level: n.min(1).max(9).optional(),
    pact: z.boolean().optional(),
    mode: z.enum(["normal", "advantage", "disadvantage"]).optional(),
  }),
  /** Extend Rage this turn some other way (forcing a saving throw). */
  z.object({ type: z.literal("extend"), id: z.string() }),
]);
export type EncounterAction = z.infer<typeof EncounterActionSchema>;
