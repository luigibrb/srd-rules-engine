/**
 * An encounter: combatants in initiative order, the round and whose turn it is, and what each has
 * spent this turn. A saved document of its own, like `CharacterState`.
 *
 * Characters are referenced by a key into the caller's characters (build + state): their HP and
 * conditions stay in their `CharacterState`. Monsters live here, with their current HP and
 * conditions (the stat block in the catalog holds the rest).
 */

import { z } from "zod";
import { ABILITIES, SKILLS } from "./content";
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
  /**
   * Monsters only: daily uses spent, by action name ("Divine Aid (2/Day)") and by
   * `<action>#<spell>` for a spell's own uses ("Spellcasting#fireball"). Not reset in the
   * encounter (no rests).
   */
  daily_used: z.record(z.string(), z.int().min(0)).default({}),
  /** Monsters only: what it's concentrating on. */
  concentration: z.string().nullable().default(null),
  /** Toggles (Rage) switched on this turn, and whether one was extended this turn. */
  toggled_on: z.array(z.string()).default([]),
  extended: z.boolean().default(false),
  /** Monsters only: in its lair (more legendary uses, when the stat block says so). */
  in_lair: z.boolean().default(false),
  /** Legendary action uses spent since the start of its last turn, and once-per-round ones taken. */
  legendary_used: z.int().min(0).default(0),
  legendary_taken: z.array(z.string()).default([]),
  /** Legendary Resistance uses spent, and whether it spends them automatically on a failed save. */
  legendary_resistance_used: z.int().min(0).default(0),
  auto_legendary_resistance: z.boolean().default(true),
  /** Took the Dodge action: its benefits last until the start of its next turn. */
  dodging: z.boolean().default(false),
  /** Took the Disengage action: its movement doesn't provoke Opportunity Attacks this turn. */
  disengaged: z.boolean().default(false),
  /** Light weapons it attacked with in this turn's Attack action (the Light property's extra attack). */
  light_attacks: z.array(z.string()).default([]),
  /** Made the Light property's extra attack as part of the Attack action this turn (Nick). */
  nick_used: z.boolean().default(false),
  /** A hit this turn that allows a Cleave attack (the weapon and the creature hit), until used. */
  cleave: z.object({ attack: z.string(), target: z.string() }).nullable().default(null),
  /** Made its Cleave attack this turn. */
  cleave_used: z.boolean().default(false),
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
  /** A grapple: the DC of the `escape` check (Athletics or Acrobatics) that ends it. */
  escape_dc: z.int().nullable().default(null),
});
export type EncounterEffect = z.infer<typeof EncounterEffectSchema>;

/**
 * The Help action's benefit, until it's used or the start of the helper's next turn: Advantage on
 * the next attack roll by one of `by`'s allies against `on` (no `skill`), or on `on`'s next check
 * with `skill`.
 */
export const HelpSchema = z.object({
  by: z.string(),
  on: z.string(),
  skill: z.enum(SKILLS).nullable().default(null),
});
export type Help = z.infer<typeof HelpSchema>;

/**
 * A Weapon Mastery's lasting effect, until used or `ends`: Vex (`by`'s next attack roll against
 * `on` has Advantage), Sap (`on`'s next attack roll has Disadvantage), Slow (`on`'s Speed −10 ft).
 */
export const MasteryMarkSchema = z.object({
  mastery: z.enum(["vex", "sap", "slow"]),
  by: z.string(),
  on: z.string(),
  ends: EffectEndSchema,
});
export type MasteryMark = z.infer<typeof MasteryMarkSchema>;

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
  /** Help actions not used yet. */
  helps: z.array(HelpSchema).default([]),
  /** Weapon Mastery effects in play (Vex, Sap, Slow). */
  masteries: z.array(MasteryMarkSchema).default([]),
  /** Roll a dying character's Death Saving Throw at the start of its turn (else just a reminder). */
  auto_death_saves: z.boolean().default(true),
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
    /** In its lair: the stat block's lair values for legendary uses. */
    in_lair: z.boolean().optional(),
    /** `false`: don't spend Legendary Resistance automatically on a failed save. */
    auto_legendary_resistance: z.boolean().optional(),
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
  /**
   * The Dash action: uses the action, adds the combatant's Speed to this turn's movement.
   * `bonus_action: true` takes it as a Bonus Action instead (a feature that allows it: Cunning
   * Action), as for `disengage` and `dodge`.
   */
  z.object({ type: z.literal("dash"), id: z.string(), bonus_action: z.boolean().optional() }),
  /** The Disengage action: its movement doesn't provoke Opportunity Attacks this turn. */
  z.object({ type: z.literal("disengage"), id: z.string(), bonus_action: z.boolean().optional() }),
  /**
   * The Dodge action: until the start of its next turn, attack rolls against it have
   * Disadvantage and it makes Dexterity saves with Advantage (not while Incapacitated or at
   * Speed 0).
   */
  z.object({ type: z.literal("dodge"), id: z.string(), bonus_action: z.boolean().optional() }),
  /**
   * The Help action: Advantage on an ally's next attack roll against `target` (an enemy), or,
   * with `skill` (one the helper is proficient in), on `target`'s (an ally's) next check with
   * it. Either expires at the start of the helper's next turn.
   */
  z.object({
    type: z.literal("help"),
    id: z.string(),
    target: z.string(),
    skill: z.enum(SKILLS).optional(),
  }),
  /**
   * An Unarmed Strike to grapple or shove (in place of one attack, like `attack`): the target
   * saves (Strength or Dexterity: default the better) against 8 + Strength modifier + Proficiency
   * Bonus, or is Grappled (escape DC the same) or shoved (`push` 5 feet, or `prone`).
   */
  z.object({
    type: z.literal("unarmed"),
    id: z.string(),
    target: z.string(),
    option: z.enum(["grapple", "shove"]),
    shove: z.enum(["push", "prone"]).optional(),
    save: z.enum(["str", "dex"]).optional(),
    reaction: z.boolean().optional(),
  }),
  /**
   * Escape a grapple: the action, a Strength (Athletics) or Dexterity (Acrobatics) check (default
   * the better) against its escape DC. `effect` picks the grapple when there are several.
   */
  z.object({
    type: z.literal("escape"),
    id: z.string(),
    skill: z.enum(["athletics", "acrobatics"]).optional(),
    effect: z.string().optional(),
  }),
  /** Right itself from Prone: half its Speed in movement. */
  z.object({ type: z.literal("stand"), id: z.string() }),
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
    /** A grapple from `source` (a stat block's "escape DC 13"): `escape` checks against it. */
    escape_dc: n.optional(),
  }),
  z.object({ type: z.literal("end_effect"), effect: z.string() }),
  /**
   * One attack with an attack line (`makeAttack`), applied to the target. The first attack of a
   * turn uses the action (Extra Attack allows more); `reaction: true` uses the reaction instead
   * (`opportunity: true`: an Opportunity Attack, melee only, refused against a Disengaged
   * target). `light_extra: true` is the Light property's extra attack: a Bonus Action after
   * attacking with a Light weapon in the Attack action, with a different Light weapon, without a
   * positive ability modifier on damage (with a Nick weapon: part of the Attack action, once per
   * turn). `cleave: true` is the Cleave mastery's attack against a second creature after a hit.
   * The weapon's mastery property applies unless `mastery: false`. Once-per-turn riders are
   * enforced; an attack roll extends Rage; Help against the target is used up.
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
    opportunity: z.boolean().optional(),
    light_extra: z.boolean().optional(),
    cleave: z.boolean().optional(),
    mastery: z.boolean().optional(),
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
   * while the caster concentrates, up to its duration. A monster casts it through the action
   * that lists it (`via` when several do): that action's section decides the economy, its level
   * is fixed, and daily uses and Recharge are counted.
   */
  z.object({
    type: z.literal("cast"),
    id: z.string(),
    spell: z.string(),
    via: z.string().optional(),
    targets: z.array(z.string()).optional(),
    slot_level: n.min(1).max(9).optional(),
    pact: z.boolean().optional(),
    mode: z.enum(["normal", "advantage", "disadvantage"]).optional(),
  }),
  /** An ability check, with a skill or not, against a DC or not. Uses no action by itself. */
  z.object({
    type: z.literal("check"),
    id: z.string(),
    skill: z.enum(SKILLS).optional(),
    ability: z.enum(ABILITIES).optional(),
    dc: n.optional(),
    mode: z.enum(["normal", "advantage", "disadvantage"]).optional(),
  }),
  /** Extend Rage this turn some other way (forcing a saving throw). */
  z.object({ type: z.literal("extend"), id: z.string() }),
  /**
   * A legendary action, taken right after another creature's turn: an attack (`target`, and
   * `attack` when it offers a choice), a saving throw effect (`targets`), another action it uses,
   * or text. Uses per round come back at the start of the monster's turn.
   */
  z.object({
    type: z.literal("legendary"),
    id: z.string(),
    action: z.string(),
    target: z.string().optional(),
    targets: z.array(z.string()).optional(),
    attack: z.string().optional(),
    mode: z.enum(["normal", "advantage", "disadvantage"]).optional(),
    within_5ft: z.boolean().optional(),
  }),
]);
export type EncounterAction = z.infer<typeof EncounterActionSchema>;
