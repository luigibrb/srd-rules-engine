/**
 * Encounters: initiative, rounds and turns, the action economy, and applying the results of
 * attacks, spells and saving throw effects to monsters and characters.
 *
 * Like play, every change is a JSON action applied by `applyEncounterAction`, which checks it
 * against the rules and throws `EncounterError` otherwise. Characters are referenced by key: the
 * caller passes their build and state in `characters`, and gets changed states back in `states`.
 */

import { type Catalog, lookup } from "../content/catalog";
import type { CharacterBuild } from "../models/build";
import {
  ABILITY_NAMES,
  type DamageType,
  type MonsterDef,
  type Skill,
  type SpellArea,
  type SpellDef,
  skillName,
} from "../models/content";
import {
  type EffectEnd,
  type Encounter,
  type EncounterAction,
  type EncounterCombatant,
  EncounterCombatantSchema,
  type EncounterEffect,
  EncounterSchema,
  type Help,
  type MasteryMark,
  type Pending,
  type SpellMark,
  type Zone,
} from "../models/encounter";
import type { EncounterEvent, RefusalCode } from "../models/events";
import type { CharacterState, PlayAction } from "../models/state";
import {
  type AreaPlacement,
  areaSquares,
  distanceToPoint,
  type GridPoint,
  type GridSpace,
  inArea,
} from "../rules/areas";
import {
  castSpell,
  type SaveActionResult,
  type SpellCastResult,
  type SpellTargetResult,
  saveAgainst,
  useSaveAction,
} from "../rules/casting";
import {
  type AttackResult,
  type CheckResult,
  type Combatant,
  combatantFromMonster,
  type Decide,
  type Decision,
  type ModeReason,
  makeAttack,
  monsterSpells,
  type RollMode,
  resolveMode,
  rollAbilityCheck,
  rollD20,
  rollSavingThrow,
  type SaveActionLine,
  type SaveResult,
} from "../rules/combatant";
import { rollDamage, takeDamage } from "../rules/damage";
import { parseDiceExpression, roll } from "../rules/dice";
import {
  type CoverDegree,
  coverDegree,
  findPath,
  gridDistance,
  lineClear,
  type Occupant,
  obstacles,
  spaceCorners,
  key as squareKey,
  stepBlocked,
  stepCost,
  straightPath,
  type Terrain,
} from "../rules/grid";
import { mathRng, type Rng } from "../rules/rng";
import type { AttackLine } from "../rules/sheet";
import { encounterEvents } from "./events";
import { applyAction, combatantFromCharacter, computePlaySheet, PlayError } from "./play";
import { refusalCode } from "./refusals";

export class EncounterError extends Error {
  override name = "EncounterError";
  readonly messages: readonly string[];
  /** A code per message, for a UI (`REFUSAL_CODES`). */
  readonly codes: readonly RefusalCode[];
  constructor(messages: readonly string[]) {
    super(messages.join("; "));
    this.messages = messages;
    this.codes = messages.map(refusalCode);
  }
}

export interface CharacterRef {
  readonly build: CharacterBuild;
  readonly state: CharacterState;
}

export interface EncounterContext {
  readonly catalog: Catalog;
  /** Characters by the key their combatants use (`character`). */
  readonly characters?: Readonly<Record<string, CharacterRef>>;
  readonly rng?: Rng;
}

export interface EncounterResult {
  readonly encounter: Encounter;
  /** Character states changed by the action, by character key. */
  readonly states: Readonly<Record<string, CharacterState>>;
  readonly notes: readonly string[];
  /** The rolls of an `attack`, `save_action`, `cast`, `legendary`, `check`, `unarmed` or `escape`. */
  readonly result:
    | AttackResult
    | SaveActionResult
    | SpellCastResult
    | CheckResult
    | SaveResult
    | null;
  /** The decision the action stopped for (also in `encounter.pending`), if any. */
  readonly pending?: Pending | null;
  /** What changed, as data (turns, moves, HP, conditions, resources, effects, zones…). */
  readonly events: readonly EncounterEvent[];
  /**
   * The dice the action drew from `rng`, in order: replaying the action with them (`scriptedRng`)
   * gives the same result (`replayHistory`).
   */
  readonly rolls: readonly number[];
}

/** A new encounter. `auto_death_saves: false` leaves Death Saving Throws to the players. */
export function createEncounter(
  options: { auto_death_saves?: boolean; decisions?: "ask" | "auto" } = {},
): Encounter {
  return EncounterSchema.parse(options);
}

/** Whose turn it is, or `null` before the fight starts. */
export function currentCombatant(encounter: Encounter): EncounterCombatant | null {
  if (encounter.round === 0) return null;
  const id = encounter.order[encounter.turn];
  return encounter.combatants.find((c) => c.id === id) ?? null;
}

/** A combatant as combat sees it (for `makeAttack`, `castSpell`, `useSaveAction`). */
export function encounterCombatant(
  encounter: Encounter,
  id: string,
  ctx: EncounterContext,
): Combatant {
  const c =
    encounter.combatants.find((x) => x.id === id) ?? fail(`No combatant '${id}' in the encounter`);
  if (c.monster !== null) {
    const def = monsterDef(ctx, c);
    const base = combatantFromMonster(
      def,
      {
        hp: c.hp ?? def.hit_points,
        temp_hp: c.temp_hp,
        conditions: c.conditions,
        in_lair: c.in_lair,
        legendary_resistance_used: c.legendary_resistance_used,
        auto_legendary_resistance: c.auto_legendary_resistance,
      },
      { conditions: ctx.catalog.conditions },
    );
    // An ability waiting to recharge can't be used.
    const ready = (name: string) => !c.expended.includes(name);
    return withDodge(ctx, encounter, c, {
      ...base,
      id: c.id,
      name: c.name,
      inspiration_die: c.inspiration?.die ?? null,
      attacks: base.attacks.filter((a) => ready(a.name)),
      save_actions: base.save_actions.filter((a) => ready(a.name)),
    });
  }
  const ref = characterRef(ctx, c);
  return withDodge(ctx, encounter, c, {
    ...combatantFromCharacter(ref.build, ref.state, ctx.catalog),
    id: c.id,
    name: c.name,
    inspiration_die: c.inspiration?.die ?? null,
  });
}

/**
 * The Dodge action's benefits (SRD "Dodge"): attack rolls against it have Disadvantage, and it
 * makes Dexterity saves with Advantage; lost while Incapacitated or at Speed 0.
 */
function withDodge(
  ctx: EncounterContext,
  encounter: Encounter,
  c: EncounterCombatant,
  base: Combatant,
): Combatant {
  if (!c.dodging || base.conditions.includes("incapacitated") || speedOf(ctx, c, encounter) === 0) {
    return base;
  }
  const dodge = {
    mode: "disadvantage",
    condition: "Dodging",
    id: "dodging",
    except_against_source: false,
  } as const;
  const rolls = base.condition_rolls;
  return {
    ...base,
    advantages: [...base.advantages, "save.dex"],
    condition_rolls: {
      ...rolls,
      attacked: [...rolls.attacked, dodge],
      attacked_beyond_5ft: [...rolls.attacked_beyond_5ft, dodge],
    },
  };
}

export function applyEncounterAction(
  encounter: Encounter,
  action: EncounterAction,
  outer: EncounterContext,
  /** `events: false` skips working out `events` (a dry run doesn't need them). */
  { events: withEvents = true }: { events?: boolean } = {},
): EncounterResult {
  const pending = encounter.pending;
  const drawn: number[] = [];
  const base = outer.rng ?? mathRng;
  const counted: EncounterContext = {
    ...outer,
    rng: {
      int: (min, max) => {
        const value = base.int(min, max);
        drawn.push(value);
        return value;
      },
    },
  };
  let r: Omit<EncounterResult, "events" | "rolls">;
  if (action.type === "decide") {
    if (!pending) fail("There's no decision to make");
    // Replay the stopped action with the same dice and one more answer.
    const clear = { ...encounter, pending: null };
    r = attempt(clear, pending.action, counted, pending.rolls, [...pending.answers, action.use]);
  } else {
    if (pending) fail(`Waiting for a decision: ${pending.question}`);
    r = attempt(encounter, action, counted, [], []);
  }
  if (!withEvents) return { ...r, events: [], rolls: drawn };
  const events = encounterEvents(
    encounter,
    r.encounter,
    outer.catalog,
    outer.characters,
    r.states,
    action.type === "decide" && pending ? pending.action : action,
  );
  return { ...r, events, rolls: drawn };
}

/** Thrown when an action needs an answer it doesn't have: the action stops with nothing applied. */
class PendingDecision {
  constructor(
    readonly combatant: string,
    readonly kind: Decision["kind"],
    readonly question: string,
    readonly recommended: boolean,
  ) {}
}

/** Run an action with recorded dice; a decision without an answer leaves it pending. */
function attempt(
  encounter: Encounter,
  action: EncounterAction,
  outer: EncounterContext,
  rolls: readonly number[],
  answers: readonly boolean[],
): Omit<EncounterResult, "events" | "rolls"> {
  const recorded: number[] = [];
  const base = outer.rng ?? mathRng;
  const rng: Rng = {
    int: (min, max) => {
      const value =
        recorded.length < rolls.length ? (rolls[recorded.length] as number) : base.int(min, max);
      recorded.push(value);
      return value;
    },
  };
  try {
    return run(encounter, action, { ...outer, rng }, answers);
  } catch (error) {
    if (!(error instanceof PendingDecision)) throw error;
    const stopped = {
      action,
      rolls: recorded,
      answers: [...answers],
      combatant: error.combatant,
      kind: error.kind,
      question: error.question,
      recommended: error.recommended,
    };
    return {
      encounter: EncounterSchema.parse({ ...encounter, pending: stopped }),
      states: {},
      notes: [error.question],
      result: null,
      pending: stopped,
    };
  }
}

function run(
  encounter: Encounter,
  action: EncounterAction,
  outer: EncounterContext,
  answers: readonly boolean[],
): Omit<EncounterResult, "events" | "rolls"> {
  const e = structuredClone(encounter) as Encounter;
  const notes: string[] = [];
  const states: Record<string, CharacterState> = {};
  // A working copy of the characters: several can change in one action (attacker and target).
  const chars: Record<string, CharacterRef> = { ...(outer.characters ?? {}) };
  const ctx: EncounterContext = { ...outer, characters: chars };
  const rng = ctx.rng ?? mathRng;
  let result: EncounterResult["result"] = null;
  // Decisions after a roll: `auto` takes the recommendation; `ask` uses the next answer given,
  // or stops the action for one.
  let answered = 0;
  const decide: Decide = (d) => {
    const c = d.combatant.id ? e.combatants.find((x) => x.id === d.combatant.id) : undefined;
    if (!c || (c.decisions ?? e.decisions) === "auto") return d.recommended;
    if (answered < answers.length) return answers[answered++] as boolean;
    throw new PendingDecision(c.id, d.kind, d.question, d.recommended);
  };
  const play = (c: EncounterCombatant, a: PlayAction): void => {
    const ref = characterRef(ctx, c);
    let r: ReturnType<typeof applyAction>;
    try {
      r = applyAction(ref.build, ref.state, ctx.catalog, a, { rng });
    } catch (error) {
      if (error instanceof PlayError) {
        throw new EncounterError(error.messages.map((m) => `${c.name}: ${m}`));
      }
      throw error;
    }
    chars[c.character as string] = { build: ref.build, state: r.state };
    states[c.character as string] = r.state;
    notes.push(...r.notes);
  };
  const concentrationOf = (c: EncounterCombatant): string | null =>
    c.monster !== null ? c.concentration : characterRef(ctx, c).state.concentration;
  /** Apply play actions to a combatant; a concentrating one saves against damage. */
  const applyTo = (c: EncounterCombatant, actions: readonly PlayAction[]): void => {
    for (const a of actions) {
      let dc: number | null = null;
      if (a.type === "damage") {
        const t = encounterCombatant(e, c.id, ctx);
        const instances = a.instances ?? [{ amount: a.amount ?? 0, type: a.damage_type ?? null }];
        const vitals = { hp: t.hp, temp: t.temp_hp, max: t.max_hp };
        dc = takeDamage(vitals, instances, t.defenses, { critical: a.critical }).concentration_dc;
      }
      if (c.monster !== null) notes.push(...monsterEffect(ctx, c, a));
      else {
        play(c, a);
        if (a.type === "activate") c.toggled_on.push(a.key);
      }
      const spell = concentrationOf(c);
      if (dc !== null && spell) {
        const save = rollSavingThrow(encounterCombatant(e, c.id, ctx), "con", dc, { rng, decide });
        spendLegendaryResistance(c, save);
        const outcome = saveText(save);
        if (save.success) notes.push(`${c.name} keeps Concentration on ${spell} (${outcome}).`);
        else {
          notes.push(`${c.name} loses Concentration on ${spell} (${outcome}).`);
          if (c.monster !== null) c.concentration = null;
          else play(c, { type: "set_concentration", spell: null });
        }
      }
    }
  };
  /** End an effect; its condition goes unless another effect still gives it. */
  const endEffect = (effect: EncounterEffect, why: string): void => {
    e.effects = e.effects.filter((x) => x.id !== effect.id);
    const target = e.combatants.find((c) => c.id === effect.target);
    const still = e.effects.some(
      (x) => x.target === effect.target && x.condition === effect.condition,
    );
    const name = lookup(ctx.catalog.conditions, effect.condition)?.name ?? effect.condition;
    notes.push(`${name} on ${target?.name ?? effect.target} ends (${effect.label}: ${why}).`);
    if (!target || still) return;
    if (target.monster !== null) {
      target.conditions = target.conditions.filter((x) => x !== effect.condition);
    } else if (characterRef(ctx, target).state.conditions.includes(effect.condition)) {
      play(target, { type: "remove_condition", condition: effect.condition });
    }
  };
  /** Register timed or Concentration effects for the conditions a target now has. */
  const addEffects = (
    target: EncounterCombatant,
    conditions: readonly string[],
    opts: {
      source: string | null;
      label: string;
      concentration: boolean;
      ends: EffectEnd | null;
      escape_dc?: number | null;
      escape_skill?: "athletics" | "acrobatics" | null;
    },
  ): void => {
    const has = conditionsOf(ctx, target);
    for (const condition of conditions) {
      if (!has.has(condition)) continue; // immune
      e.effects.push({
        id: `effect-${e.next_effect++}`,
        target: target.id,
        condition,
        ...opts,
        escape_dc: opts.escape_dc ?? null,
        escape_skill: opts.escape_skill ?? null,
      });
    }
  };
  const endsFrom = (
    target: string,
    source: string | undefined,
    rounds: number | undefined,
    until: { at: "start" | "end"; of?: string } | undefined,
  ): EffectEnd | null => {
    if (rounds !== undefined) {
      return { at: "start", of: source ?? target, count: rounds, skip_current: false };
    }
    if (until) {
      const of = until.of ?? source ?? target;
      find(of);
      return {
        at: until.at,
        of,
        count: 1,
        skip_current: until.at === "end" && current()?.id === of,
      };
    }
    return null;
  };
  /** Count down effects that end at the start or end of `c`'s turn. */
  const tick = (c: EncounterCombatant, at: "start" | "end"): void => {
    for (const effect of [...e.effects]) {
      const ends = effect.ends;
      if (!ends || ends.at !== at || ends.of !== c.id) continue;
      if (ends.skip_current) {
        ends.skip_current = false;
        continue;
      }
      ends.count -= 1;
      if (ends.count <= 0) endEffect(effect, "its duration is over");
    }
    for (const mark of [...e.masteries]) {
      const ends = mark.ends;
      if (ends.at !== at || ends.of !== c.id) continue;
      if (ends.skip_current) ends.skip_current = false;
      else if (--ends.count <= 0) e.masteries = e.masteries.filter((m) => m !== mark);
    }
    for (const mark of [...e.marks]) {
      const ends = mark.ends;
      if (ends.at !== at || ends.of !== c.id) continue;
      if (ends.skip_current) ends.skip_current = false;
      else if (--ends.count <= 0) e.marks = e.marks.filter((m) => m !== mark);
    }
    for (const zone of [...e.zones]) {
      const ends = zone.ends;
      if (!ends || ends.at !== at || ends.of !== c.id) continue;
      if (ends.skip_current) ends.skip_current = false;
      else if (--ends.count <= 0) endZone(zone, "its duration is over");
    }
  };
  /**
   * The squares' origin of a zone: its point, or for an Emanation its caster's space, or the
   * space at its point (`space` squares wide).
   */
  const zoneSquares = (z: Zone): Set<string> | null => zoneArea(e, ctx, z);
  /** Whether `x`, at its position now, is in the zone (an Emanation doesn't include its caster). */
  const inZoneNow = (z: Zone, squares: ReadonlySet<string> | null, x: EncounterCombatant) =>
    !!squares &&
    !!x.position &&
    !outOfFight(ctx, x) &&
    !(z.area.shape === "emanation" && !z.point && x.id === z.by) &&
    inArea(squares, { position: x.position, size: spaceOf(ctx, x) });
  /** The positioned creatures in a zone. */
  const inZone = (z: Zone): string[] => {
    const squares = zoneSquares(z);
    return e.combatants.filter((x) => inZoneNow(z, squares, x)).map((x) => x.id);
  };
  /**
   * Creatures save against a zone (`why`: "ends its turn in it"), each once per turn when the
   * spell says so; the damage is rolled once for all of them. When the save is the caster's to
   * force (Conjure Animals), the caster decides for each creature.
   */
  const zoneSave = (z: Zone, ids: readonly string[], why: string): void => {
    const save = z.save;
    if (!save) return;
    const caster = e.combatants.find((x) => x.id === z.by);
    const who = ids.map(find).filter((t) => {
      if (z.unaffected.includes(t.id) || outOfFight(ctx, t)) return false;
      if (z.once_per_turn && z.saved.includes(t.id)) return false;
      if (!z.optional || !caster) return true;
      if (t.id === caster.id) return false; // the caster doesn't force itself
      const ability = ABILITY_NAMES[save.ability];
      const question = `${caster.name}: force ${t.name} (${why}) to make a ${ability} saving throw against ${z.label}?`;
      const view = encounterCombatant(e, caster.id, ctx);
      return decide({
        kind: "zone_force",
        combatant: view,
        question,
        recommended: !alliesOf(e, t.id, caster),
      });
    });
    if (!who.length) return;
    const views = who.map((t) => encounterCombatant(e, t.id, ctx));
    const r = saveAgainst({ ...save, conditions: z.conditions }, z.damage, views, { rng, decide });
    const names = who.map((t) => t.name).join(", ");
    notes.push(`${z.label}: ${names} ${why} (${ABILITY_NAMES[save.ability]} DC ${save.dc}).`);
    for (const hit of r.targets) {
      const t = who[hit.target] as EncounterCombatant;
      z.saved.push(t.id);
      spendLegendaryResistance(t, hit.save);
      notes.push(targetNote(t.name, hit));
      applyTo(t, hit.actions);
      if (hit.save?.success) continue;
      if (hit.conditions.length && (z.concentration || z.until)) {
        addEffects(t, hit.conditions, {
          source: z.by,
          label: z.label,
          // "until the end of the current turn" (Stinking Cloud), else while the spell lasts.
          concentration: z.until ? false : z.concentration,
          ends: z.until ? { at: "end", of: t.id, count: 1, skip_current: false } : null,
          escape_dc: z.escape_dc,
          escape_skill: z.escape_skill,
        });
      }
      if (z.on_fail.includes("no_actions") && current()?.id === t.id) {
        t.used.action = true;
        t.used.bonus_action = true;
        notes.push(`${t.name} can't take an action or a Bonus Action this turn.`);
      }
      const spell = z.on_fail.includes("lose_concentration") ? concentrationOf(t) : null;
      if (spell) {
        notes.push(`${t.name} loses Concentration on ${spell} (${z.label}).`);
        if (t.monster !== null) t.concentration = null;
        else play(t, { type: "set_concentration", spell: null });
      }
    }
  };
  /** Damage for every 5 feet moved into or within zones that deal it (Spike Growth). */
  const zoneMoveDamage = (c: EncounterCombatant, steps: Map<string, number>): void => {
    for (const z of [...e.zones]) {
      const n = steps.get(z.id) ?? 0;
      if (!n || z.unaffected.includes(c.id) || outOfFight(ctx, c)) continue;
      const parts = z.damage.map((d) => {
        if (!d.dice) return { ...d, bonus: d.bonus * n };
        const { count, sides } = parseDiceExpression(d.dice);
        return { ...d, dice: `${count * n}d${sides}`, bonus: d.bonus * n };
      });
      const rolled = rollDamage(parts, { rng });
      const instances = rolled.parts.map((p) => ({ amount: p.total, type: p.type }));
      const dealt = instances.map((d) => `${d.amount} ${d.type}`).join(" + ");
      notes.push(`${z.label}: ${c.name} moves ${n * 5} feet in it: ${dealt}.`);
      applyTo(c, [{ type: "damage", instances }]);
    }
  };
  /** Who is in each zone now, to find who enters one after a move. */
  const zoneOccupants = (): Map<string, Set<string>> =>
    new Map(e.zones.map((z) => [z.id, new Set(inZone(z))]));
  /** Creatures now in a zone that weren't before (they entered it, or it moved onto them) save. */
  const zoneEntries = (before: Map<string, Set<string>>): void => {
    for (const z of [...e.zones]) {
      if (!z.triggers.includes("enter")) continue;
      const was = before.get(z.id) ?? new Set<string>();
      const entered = inZone(z).filter((id) => !was.has(id));
      if (entered.length) zoneSave(z, entered, entered.length > 1 ? "are in it now" : "enters it");
    }
  };
  /** Zones with this trigger that `c` is in make it save. */
  const zoneTurn = (c: EncounterCombatant, at: "start_turn" | "end_turn"): void => {
    for (const z of [...e.zones]) {
      if (!z.triggers.includes(at) || !inZone(z).includes(c.id)) continue;
      zoneSave(z, [c.id], at === "start_turn" ? "starts its turn in it" : "ends its turn in it");
    }
  };
  const endZone = (z: Zone, why: string): void => {
    e.zones = e.zones.filter((x) => x.id !== z.id);
    notes.push(`${z.label} ends (${why}).`);
  };
  /** The end of `c`'s turn: effects, and toggles that weren't extended (Rage). */
  const endTurn = (c: EncounterCombatant): void => {
    zoneTurn(c, "end_turn");
    tick(c, "end");
    if (c.character !== null) {
      const ref = characterRef(ctx, c);
      const sheet = computePlaySheet(ref.build, ref.state, ctx.catalog);
      for (const t of sheet.toggles) {
        if (t.active && t.extends_each_turn && !c.extended && !c.toggled_on.includes(t.key)) {
          notes.push(`${t.name} ends: it wasn't extended this turn.`);
          play(c, { type: "deactivate", key: t.key });
        }
      }
    }
    c.toggled_on = [];
    c.extended = false;
    c.disengaged = false;
    c.light_attacks = [];
    c.nick_used = false;
    c.cleave = null;
    c.cleave_used = false;
    c.surged = false;
    c.granted_attacks = null;
    c.hits = [];
    c.features_used = [];
  };
  /** The start of `c`'s turn: effects, recharges; once-per-turn riders reset for everyone. */
  const startTurn = (c: EncounterCombatant): void => {
    // A dying character makes a Death Saving Throw at the start of its turn (SRD).
    if (c.character !== null) {
      const ref = characterRef(ctx, c);
      const play = computePlaySheet(ref.build, ref.state, ctx.catalog).play;
      if (play.dying && e.auto_death_saves) applyTo(c, [{ type: "death_save" }]);
      else if (play.dying) notes.push(`${c.name} is at 0 Hit Points: make a Death Saving Throw.`);
    }
    for (const x of e.combatants) x.riders_used = [];
    // "Only once per turn": every creature's turn is a new one.
    for (const z of e.zones) z.saved = [];
    // Toggles that last until the start of your next turn (Reckless Attack) end.
    if (c.character !== null) {
      const ref = characterRef(ctx, c);
      for (const t of computePlaySheet(ref.build, ref.state, ctx.catalog).toggles) {
        if (t.active && t.ends_at_turn_start) {
          notes.push(`${t.name} ends: it lasts until the start of ${c.name}'s next turn.`);
          play(c, { type: "deactivate", key: t.key });
        }
      }
    }
    // Dodge lasts, and Help can be used, until the start of the creature's next turn.
    c.dodging = false;
    e.helps = e.helps.filter((h) => h.by !== c.id);
    // Legendary action uses come back at the start of the monster's turn.
    c.legendary_used = 0;
    c.legendary_taken = [];
    tick(c, "start");
    zoneTurn(c, "start_turn");
    if (c.monster !== null && c.expended.length) {
      const def = monsterDef(ctx, c);
      const all = [
        ...def.actions,
        ...def.bonus_actions,
        ...def.reactions,
        ...def.legendary_actions,
      ];
      for (const name of [...c.expended]) {
        const min = Number(
          /^(\d)/.exec(all.find((a) => a.name === name)?.recharge ?? "")?.[1] ?? 7,
        );
        const d6 = rng.int(1, 6);
        if (d6 >= min) {
          c.expended = c.expended.filter((x) => x !== name);
          notes.push(`${c.name}'s ${name} recharges (${d6}).`);
        } else notes.push(`${c.name}'s ${name} doesn't recharge (${d6}).`);
      }
    }
  };
  /** A monster's save turned into a success by Legendary Resistance: one use spent. */
  /** A Bardic Inspiration die added to a roll is gone. */
  const useInspiration = (c: EncounterCombatant, rolled: number | null | undefined): void => {
    if (rolled === null || rolled === undefined || !c.inspiration) return;
    notes.push(`${c.name} adds its Bardic Inspiration die: ${rolled}.`);
    c.inspiration = null;
  };
  const spendLegendaryResistance = (c: EncounterCombatant, save: SaveResult | null): void => {
    useInspiration(c, save?.inspiration);
    if (!save?.legendary_resistance || c.monster === null) return;
    c.legendary_resistance_used += 1;
    const def = monsterDef(ctx, c);
    const max = def.legendary_resistance
      ? c.in_lair && def.legendary_resistance.in_lair !== null
        ? def.legendary_resistance.in_lair
        : def.legendary_resistance.uses
      : 0;
    const left = Math.max(0, max - c.legendary_resistance_used);
    notes.push(`${c.name} uses Legendary Resistance to succeed instead (${left} left today).`);
  };
  /** Put `c` on a square; another creature's space can't be the end of a move. */
  const occupy = (c: EncounterCombatant, to: { x: number; y: number }): void => {
    const size = spaceOf(ctx, c);
    const blocked = new Set(e.map.blocked.map(squareKey));
    for (let dx = 0; dx < size; dx++) {
      for (let dy = 0; dy < size; dy++) {
        if (blocked.has(`${to.x + dx},${to.y + dy}`)) fail(`${to.x + dx},${to.y + dy} is blocked`);
      }
    }
    const taken = spaceTaken(c, to);
    if (taken) fail(`${taken.name} is in that space`);
    c.position = { ...to };
  };
  /** Another creature whose space overlaps `c`'s at `to`. */
  const spaceTaken = (c: EncounterCombatant, to: GridPoint): EncounterCombatant | undefined =>
    spaceTakenBy(e, ctx, c, to);
  const feetBetween = (a: EncounterCombatant, b: EncounterCombatant): number | null =>
    feetApart(ctx, a, b);
  const enemiesNear = (c: EncounterCombatant): EncounterCombatant[] => enemiesWithin5(e, ctx, c);
  /**
   * What positions say about an attack: a melee attack within reach, a ranged one within long
   * range (Disadvantage beyond normal range, and with an enemy within 5 feet), whether it's
   * within 5 feet, and whether an ally of the attacker is next to the target (Sneak Attack).
   */
  const attackGeometry = (
    c: EncounterCombatant,
    t: EncounterCombatant,
    line: AttackLine,
    options: {
      thrown?: boolean;
      within_5ft?: boolean;
      ally_adjacent?: boolean;
      opportunity?: boolean;
    },
  ) => {
    const modes: ModeReason[] = [];
    if (options.thrown && !line.properties.includes("thrown")) {
      fail(`${line.name} can't be thrown`);
    }
    const ranged = line.kind === "ranged" || Boolean(options.thrown);
    const distance = feetBetween(c, t);
    let within_5ft = options.within_5ft;
    let ally_adjacent = options.ally_adjacent;
    if (distance === null) {
      if (options.thrown) within_5ft ??= false;
      return { modes, within_5ft, ally_adjacent };
    }
    within_5ft ??= distance <= 5;
    if (!ranged) {
      // An Opportunity Attack happens just before the target leaves the reach.
      const reach = line.reach ?? 5;
      if (!options.opportunity && distance > reach) {
        fail(`${t.name} is ${distance} feet away: out of ${line.name}'s reach (${reach} ft)`);
      }
    } else {
      const range = line.range;
      if (range && distance > range.long) {
        fail(`${t.name} is ${distance} feet away: beyond ${line.name}'s range (${range.long} ft)`);
      }
      if (range && distance > range.normal) {
        modes.push({
          mode: "disadvantage",
          reason: `${t.name} is beyond normal range (${range.normal} ft)`,
        });
      }
      const near = enemiesNear(c)[0];
      if (near) modes.push({ mode: "disadvantage", reason: `${near.name} is within 5 ft` });
    }
    ally_adjacent ??= e.combatants.some((x) => {
      if (x.id === c.id || x.id === t.id || x.defeated || !alliesOf(e, x.id, c)) return false;
      const d = feetBetween(x, t);
      return d !== null && d <= 5 && !conditionsOf(ctx, x).has("incapacitated");
    });
    return { modes, within_5ft, ally_adjacent };
  };
  /**
   * The positioned creatures in an area placed by `c` (rules/areas.ts), after checking that its
   * point is within `range` feet; a Cube "originating from" `c` (no range) must touch its space.
   */
  const areaTargets = (
    c: EncounterCombatant,
    area: SpellArea,
    placement: AreaPlacement,
    range: number | null,
    label: string,
  ): string[] => {
    const placed = placeArea(e, ctx, c, area, placement, range, label);
    areaCover.clear();
    for (const id of placed.total) {
      notes.push(`${find(id).name} has Total Cover from ${label}'s point of origin.`);
    }
    for (const [id, cover] of placed.cover) areaCover.set(id, cover);
    return placed.ids;
  };
  /** Cover worked out for the creatures of the last area placed, by id. */
  const areaCover = new Map<string, MapCover>();
  /**
   * `t`'s cover against `c`: the cover given, else (both positioned) worked out from the map,
   * from `c`'s space or from the last area's point of origin; noted when it changes the roll.
   */
  const coverFor = (
    c: EncounterCombatant,
    t: EncounterCombatant,
    given: Cover | undefined,
    { area = false, relevant = true }: { area?: boolean; relevant?: boolean } = {},
  ): Cover | undefined => {
    if (given) return given;
    let found: MapCover | undefined;
    if (area) found = areaCover.get(t.id);
    else if (c.position && t.position && c.id !== t.id) {
      const corners = spaceCorners({ position: c.position, size: spaceOf(ctx, c) });
      found = mapCover(e, ctx, corners, t, [c.id]);
    }
    if (!found || found.degree === "none") return undefined;
    const cover = found.degree;
    if (relevant && cover !== "total") {
      const what = cover === "half" ? "Half Cover" : "Three-Quarters Cover";
      notes.push(`${t.name} has ${what} (behind ${found.by ?? "an obstacle"}).`);
    }
    return cover;
  };
  /** Targets of a saving throw effect: from its area, or given (checked against its range). */
  const saveTargets = (
    c: EncounterCombatant,
    line: SaveActionLine,
    placement: AreaPlacement | undefined,
    given: readonly string[] | undefined,
  ): string[] => {
    if (placement) {
      if (!line.area) fail(`${line.name} has no area: give its targets`);
      if (given?.length) fail("Give targets or an area, not both");
      const ids = areaTargets(c, line.area, placement, line.range ?? null, line.name);
      notes.push(areaNote(line.name, line.area, ids));
      return ids;
    }
    for (const id of given ?? []) {
      const d = feetBetween(c, find(id));
      if (line.range && d !== null && d > line.range) {
        fail(`${find(id).name} is ${d} feet away: out of ${line.name}'s range (${line.range} ft)`);
      }
    }
    return [...(given ?? [])];
  };
  /** "Fireball's Sphere covers Brakka and Lute." */
  const areaNote = (label: string, area: SpellArea, ids: readonly string[]): string => {
    const names = ids.map((id) => find(id).name);
    const shape = `${area.shape[0]?.toUpperCase()}${area.shape.slice(1)}`;
    return names.length
      ? `${label}'s ${shape} covers ${names.join(", ")}.`
      : `${label}'s ${shape} covers no one.`;
  };
  /** The creatures in a spell's area (its point within the spell's range), noted. */
  const spellArea = (
    c: EncounterCombatant,
    spell: SpellDef,
    placement: AreaPlacement,
  ): string[] => {
    const area = spell.mechanics?.area ?? fail(`${spell.name} has no area to place`);
    const ids = areaTargets(c, area, placement, spellRangeFeet(spell), spell.name);
    notes.push(areaNote(spell.name, area, ids));
    return ids;
  };
  /** A zone's point out of a positioned caster's spell range is refused. */
  const checkZonePoint = (c: EncounterCombatant, spell: SpellDef, point?: GridPoint) => {
    const reach = spellRangeFeet(spell);
    if (!point || !c.position || reach === null) return;
    const d = gridDistance(point, 1, c.position, spaceOf(ctx, c));
    if (d > reach)
      fail(`That point is ${d} feet away: out of ${spell.name}'s range (${spell.range})`);
  };
  /** A target out of a positioned caster's spell range is refused ("60 feet", "Touch"). */
  const checkSpellRange = (
    c: EncounterCombatant,
    spell: SpellDef,
    targets: EncounterCombatant[],
  ) => {
    const limit = spellTargetRange(spell);
    if (limit === null) return;
    for (const t of targets) {
      const d = t === c ? 0 : feetBetween(c, t);
      if (d !== null && d > limit) {
        fail(`${t.name} is ${d} feet away: out of ${spell.name}'s range (${spell.range})`);
      }
    }
  };
  /** `t`'s feature that halves an attack's damage as its reaction (Uncanny Dodge), if usable. */
  const reactionThatHalves = (t: EncounterCombatant): string | null => {
    if (t.character === null || t.used.reaction) return null;
    if (conditionsOf(ctx, t).has("incapacitated")) return null;
    const ref = characterRef(ctx, t);
    const sheet = computePlaySheet(ref.build, ref.state, ctx.catalog);
    return sheet.actions.find((a) => a.halves_attack_damage)?.name ?? null;
  };
  /** One attack by `c` on `t`, applied: riders once per turn, notes, damage. */
  const attackOn = (
    c: EncounterCombatant,
    t: EncounterCombatant,
    attackName: string,
    options: {
      mode?: "normal" | "advantage" | "disadvantage";
      two_handed?: boolean;
      riders?: readonly { rider: string; type?: string }[];
      ally_adjacent?: boolean;
      within_5ft?: boolean;
      light_extra?: boolean;
      cleave?: boolean;
      mastery?: boolean;
      thrown?: boolean;
      cover?: Cover;
      opportunity?: boolean;
    },
  ): AttackResult => {
    const attacker = encounterCombatant(e, c.id, ctx);
    const line = attacker.attacks.find((a) => a.name === attackName);
    // Positions: reach, range, close combat, within 5 feet and an ally next to the target.
    const spatial = line
      ? attackGeometry(c, t, line, options)
      : {
          modes: [] as ModeReason[],
          within_5ft: options.within_5ft,
          ally_adjacent: options.ally_adjacent,
        };
    const riders = options.riders ?? [];
    const onceIds = riders.flatMap((r) => {
      const rider = line?.riders.find((x) => x.id === r.rider || x.name === r.rider);
      return rider?.once_per_turn ? [rider.id] : [];
    });
    const again = onceIds.find((id) => c.riders_used.includes(id));
    if (again) fail(`${c.name} has already used ${again} this turn`);
    const target = withCover(encounterCombatant(e, t.id, ctx), coverFor(c, t, options.cover));
    // Help: Advantage on the next attack roll by one of the helper's allies against the target.
    const help = e.helps.find(
      (h) => h.on === t.id && h.skill === null && h.by !== c.id && alliesOf(e, h.by, c),
    );
    const modes: ModeReason[] = help
      ? [{ mode: "advantage", reason: `${find(help.by).name} Helps against ${t.name}` }]
      : [];
    modes.push(...spatial.modes);
    // Vex: Advantage on c's next attack roll against t; Sap: Disadvantage on c's next attack roll.
    const vex = e.masteries.find((m) => m.mastery === "vex" && m.by === c.id && m.on === t.id);
    const sap = e.masteries.find((m) => m.mastery === "sap" && m.on === c.id);
    if (vex) modes.push({ mode: "advantage", reason: `Vex (${c.name}'s last hit on ${t.name})` });
    if (sap) modes.push({ mode: "disadvantage", reason: `Sap (${find(sap.by).name}'s hit)` });
    // Guiding Bolt: Advantage on the next attack roll against t, whoever makes it.
    const mark = e.marks.find((m) => m.on === t.id);
    if (mark) modes.push({ mode: "advantage", reason: markReason(mark) });
    let hit: AttackResult;
    try {
      // The attacker's conditions caused by this target (Grappled by it), from the effects.
      const against_source_of = e.effects
        .filter((x) => x.target === c.id && x.source === t.id)
        .map((x) => x.condition);
      hit = makeAttack(attacker, attackName, target, {
        rng,
        decide,
        mode: options.mode,
        two_handed: options.two_handed,
        riders,
        ally_adjacent: spatial.ally_adjacent,
        within_5ft: spatial.within_5ft,
        against_source_of,
        modes,
        light_extra: options.light_extra,
        cleave: options.cleave,
      });
    } catch (error) {
      if (error instanceof RangeError) fail(error.message);
      throw error;
    }
    c.extended = true; // an attack roll extends Rage
    useInspiration(c, hit.inspiration);
    if (help) e.helps = e.helps.filter((h) => h !== help);
    e.masteries = e.masteries.filter((m) => m !== vex && m !== sap);
    e.marks = e.marks.filter((m) => m !== mark);
    const why = hit.reasons.length ? `; ${hit.reasons.join("; ")}` : "";
    const roll = `${hit.total} vs AC ${hit.target_ac}${why}`;
    if (!hit.hit) notes.push(`${c.name} misses ${t.name} with ${hit.attack} (${roll}).`);
    else {
      c.riders_used.push(...onceIds);
      c.hits.push(t.id);
      const dealt = hit.instances.map((d) => `${d.amount} ${d.type}`).join(" + ");
      const crit = hit.critical_hit ? "Critical Hit! " : "";
      notes.push(`${crit}${c.name} hits ${t.name} with ${hit.attack} (${roll}): ${dealt}.`);
      let instances = [...hit.instances];
      // Uncanny Dodge: the target's reaction once it knows it's hit.
      const dodge = reactionThatHalves(t);
      const question = `${c.name} hits ${t.name} with ${hit.attack} (${roll}). ${t.name}: use ${dodge} to halve the damage?`;
      if (
        dodge &&
        decide({ kind: "uncanny_dodge", combatant: target, question, recommended: true })
      ) {
        t.used.reaction = true;
        instances = instances.map((d) => ({ ...d, amount: Math.floor(d.amount / 2) }));
        notes.push(`${t.name} uses ${dodge}: the damage is halved.`);
      }
      applyTo(t, [{ type: "damage", instances, critical: hit.critical_hit }]);
    }
    if (line?.mastery && options.mastery !== false) {
      applyMastery(c, t, attacker, line, hit, options.cleave ?? false);
    }
    return hit;
  };
  /** The attack's weapon mastery property (SRD "Mastery Properties"), after the attack. */
  const applyMastery = (
    c: EncounterCombatant,
    t: EncounterCombatant,
    attacker: Combatant,
    line: AttackLine,
    hit: AttackResult,
    cleaving: boolean,
  ): void => {
    const mastery = line.mastery?.toLowerCase();
    const modifier = line.ability ? attacker.modifiers[line.ability] : 0;
    const dealt = (hit.outcome?.dealt ?? 0) > 0;
    const until = (at: "start" | "end") => ({
      at,
      of: c.id,
      count: 1,
      skip_current: at === "end" && current()?.id === c.id,
    });
    if (!hit.hit) {
      // Graze: damage equal to the ability modifier on a miss.
      if (mastery === "graze" && modifier > 0 && !outOfFight(ctx, t)) {
        notes.push(`Graze: ${t.name} takes ${modifier} ${line.damage_type} damage.`);
        applyTo(t, [{ type: "damage", instances: [{ amount: modifier, type: line.damage_type }] }]);
      }
      return;
    }
    if (outOfFight(ctx, t) || t.defeated) return;
    if (mastery === "vex" && dealt) {
      e.masteries.push({ mastery: "vex", by: c.id, on: t.id, ends: until("end") });
      notes.push(`Vex: ${c.name}'s next attack roll against ${t.name} has Advantage.`);
    } else if (mastery === "sap") {
      e.masteries.push({ mastery: "sap", by: c.id, on: t.id, ends: until("start") });
      notes.push(`Sap: ${t.name}'s next attack roll has Disadvantage.`);
    } else if (mastery === "slow" && dealt) {
      e.masteries.push({ mastery: "slow", by: c.id, on: t.id, ends: until("start") });
      notes.push(`Slow: ${t.name}'s Speed is 10 feet lower until ${c.name}'s next turn.`);
    } else if (mastery === "topple") {
      const dc = 8 + modifier + attacker.proficiency_bonus;
      const save = rollSavingThrow(encounterCombatant(e, t.id, ctx), "con", dc, { rng, decide });
      notes.push(`Topple: ${t.name} ${save.success ? "succeeds" : "fails"} (${saveText(save)}).`);
      spendLegendaryResistance(t, save);
      if (!save.success) applyTo(t, [{ type: "add_condition", condition: "prone" }]);
    } else if (mastery === "push") {
      const size = encounterCombatant(e, t.id, ctx).size;
      if (!["huge", "gargantuan"].includes(size ?? "")) {
        notes.push(`Push: ${c.name} can push ${t.name} up to 10 feet straight away.`);
      }
    } else if (mastery === "cleave" && line.kind === "melee" && !cleaving && !c.cleave_used) {
      c.cleave = { attack: line.name, target: t.id };
      notes.push(
        `Cleave: ${c.name} can attack a second creature within 5 feet of ${t.name} with ${line.name}.`,
      );
    }
  };
  /** A saving throw effect used by `user` against targets, applied. */
  const saveEffectOn = (
    c: EncounterCombatant,
    user: Combatant,
    name: string,
    targetIds: readonly string[],
    cover?: Readonly<Record<string, Cover>>,
    area = false,
  ): SaveActionResult => {
    const targets = targetIds.map(find);
    const line = user.save_actions.find((a) => a.name === name);
    const relevant = line?.ability === "dex";
    let r: SaveActionResult;
    try {
      const combatants = targets.map((t) =>
        withCover(
          encounterCombatant(e, t.id, ctx),
          coverFor(c, t, cover?.[t.id], { area, relevant }),
        ),
      );
      r = useSaveAction(user, name, combatants, { rng, decide });
    } catch (error) {
      if (error instanceof RangeError) fail(error.message);
      throw error;
    }
    c.extended = true; // forcing a saving throw extends Rage
    for (const hit of r.targets) {
      const t = targets[hit.target] as EncounterCombatant;
      spendLegendaryResistance(t, hit.save); // notes Bardic Inspiration first: it changed the roll
      notes.push(targetNote(t.name, hit));
      applyTo(t, hit.actions);
    }
    return r;
  };
  /**
   * `c` casts a spell at targets (`castSpell`) and the results are applied; a Concentration
   * spell's conditions become effects for its duration. Economy and limits are the caller's.
   */
  const castBy = (
    c: EncounterCombatant,
    spell: SpellDef,
    targetIds: readonly string[],
    options: {
      slot_level?: number;
      pact?: boolean;
      mode?: RollMode;
      spellcasting?: string;
      cover?: Readonly<Record<string, Cover>>;
      /** The targets come from an area: its point was checked against the range instead. */
      area?: boolean;
      /** A follow-up saving throw's other creatures (Ice Knife), when positions aren't used. */
      nearby?: readonly string[];
      damage_type?: DamageType;
      /** A zone's point (its area's), and the creatures it doesn't affect. */
      point?: GridPoint;
      unaffected?: readonly string[];
    },
  ): SpellCastResult => {
    const zone = spell.mechanics?.zone ?? null;
    if (options.unaffected?.length && !zone?.designate) {
      fail(`${spell.name} doesn't let its caster designate creatures it doesn't affect`);
    }
    if (zone && !zone.on_cast && targetIds.length && !options.area) {
      fail(`${spell.name}: creatures don't save when it appears; give no targets`);
    }
    const targets = targetIds.map(find);
    if (!options.area) checkSpellRange(c, spell, targets);
    // Positions: an enemy within 5 feet hinders ranged spell attacks; Prone targets within 5 ft.
    const near = enemiesNear(c)[0];
    const modes: ModeReason[] = near
      ? [{ mode: "disadvantage", reason: `${near.name} is within 5 ft` }]
      : [];
    const within_5ft = targets.map((t) => {
      const d = feetBetween(c, t);
      return d === null ? undefined : d <= 5;
    });
    const nearby = followUpNearby(spell, targets, options.nearby);
    const {
      cover,
      area: _area,
      nearby: _nearby,
      point: _point,
      unaffected: _unaffected,
      ...cast
    } = options;
    const relevant = !!spell.mechanics?.attack || spell.mechanics?.save?.ability === "dex";
    const views = targets.map((t) =>
      withCover(
        encounterCombatant(e, t.id, ctx),
        coverFor(c, t, cover?.[t.id], { area: options.area, relevant }),
      ),
    );
    const nearbyViews = nearby.map((t) =>
      withCover(encounterCombatant(e, t.id, ctx), cover?.[t.id]),
    );
    // Help, Vex, Sap and Guiding Bolt reach spell attack rolls too, each used by one roll.
    const used = { helps: [] as Help[], masteries: [] as MasteryMark[], marks: [] as SpellMark[] };
    const modesFor = (index: number): ModeReason[] => {
      const t = targets[index] as EncounterCombatant;
      const out: ModeReason[] = [];
      const help = e.helps.find(
        (h) =>
          h.on === t.id &&
          h.skill === null &&
          h.by !== c.id &&
          alliesOf(e, h.by, c) &&
          !used.helps.includes(h),
      );
      if (help) {
        used.helps.push(help);
        out.push({ mode: "advantage", reason: `${find(help.by).name} Helps against ${t.name}` });
      }
      const fresh = (m: MasteryMark) => !used.masteries.includes(m);
      const vex = e.masteries.find(
        (m) => m.mastery === "vex" && m.by === c.id && m.on === t.id && fresh(m),
      );
      if (vex) {
        used.masteries.push(vex);
        out.push({ mode: "advantage", reason: `Vex (${c.name}'s last hit on ${t.name})` });
      }
      const sap = e.masteries.find((m) => m.mastery === "sap" && m.on === c.id && fresh(m));
      if (sap) {
        used.masteries.push(sap);
        out.push({ mode: "disadvantage", reason: `Sap (${find(sap.by).name}'s hit)` });
      }
      const mark = e.marks.find((m) => m.on === t.id && !used.marks.includes(m));
      if (mark) {
        used.marks.push(mark);
        out.push({ mode: "advantage", reason: markReason(mark) });
      }
      return out;
    };
    let r: SpellCastResult;
    try {
      r = castSpell(encounterCombatant(e, c.id, ctx), spell, views, {
        ...cast,
        rng,
        decide,
        modes,
        modesFor,
        within_5ft,
        nearby: nearbyViews,
      });
    } catch (error) {
      if (error instanceof RangeError) fail(error.message);
      throw error;
    }
    e.helps = e.helps.filter((h) => !used.helps.includes(h));
    e.masteries = e.masteries.filter((m) => !used.masteries.includes(m));
    e.marks = e.marks.filter((m) => !used.marks.includes(m));
    c.extended = true;
    const level =
      r.slot_level !== null && r.slot_level > spell.level ? ` at level ${r.slot_level}` : "";
    notes.push(`${c.name} casts ${spell.name}${level}.`, ...r.notes);
    applyTo(c, r.caster_actions);
    for (const hit of r.targets) {
      const t = targets[hit.target] as EncounterCombatant;
      useInspiration(c, hit.attack?.inspiration);
      spendLegendaryResistance(t, hit.save);
      notes.push(targetNote(t.name, hit, views[hit.target]?.armor_class));
      applyTo(t, hit.actions);
      if (hit.on_hit.includes("advantage_against") && !outOfFight(ctx, t)) {
        e.marks = e.marks.filter((m) => !(m.on === t.id && m.label === spell.name));
        e.marks.push({
          kind: "advantage_against",
          label: spell.name,
          by: c.id,
          on: t.id,
          ends: until("end"),
        });
        notes.push(`${spell.name}: the next attack roll against ${t.name} has Advantage.`);
      }
    }
    if (r.follow_up) {
      const all = [...targets, ...nearby];
      const what = r.follow_up.targets.length ? "" : ": no creature is in it";
      notes.push(
        `${spell.name}'s saving throw (${ABILITY_NAMES[r.follow_up.ability]} DC ${r.follow_up.dc})${what}.`,
      );
      for (const hit of r.follow_up.targets) {
        const t = all[hit.target] as EncounterCombatant;
        spendLegendaryResistance(t, hit.save);
        notes.push(targetNote(t.name, hit));
        applyTo(t, hit.actions);
      }
    }
    // A hold that an action's check ends (Black Tentacles, Web).
    const hold = spell.mechanics?.conditions.find((x) => x.escape)?.escape ?? null;
    const escapeDc = hold ? r.save_dc : null;
    // Conditions with a duration in the spell's text end at the start or end of the caster's
    // next turn; a Concentration spell's others last while it concentrates, up to its duration.
    const timed = new Map(
      (spell.mechanics?.conditions ?? []).flatMap((x) => (x.until ? [[x.condition, x.until]] : [])),
    );
    const rounds = durationRounds(spell);
    for (const hit of r.targets) {
      const t = targets[hit.target] as EncounterCombatant;
      for (const at of ["start", "end"] as const) {
        const conditions = hit.conditions.filter((x) => timed.get(x) === `${at}_of_your_next_turn`);
        if (conditions.length) {
          addEffects(t, conditions, {
            source: c.id,
            label: spell.name,
            concentration: false,
            ends: until(at),
          });
        }
      }
      const lasting = hit.conditions.filter((x) => !timed.has(x));
      if (spell.concentration && lasting.length) {
        addEffects(t, lasting, {
          source: c.id,
          label: spell.name,
          concentration: true,
          ends: rounds ? { at: "start", of: c.id, count: rounds, skip_current: false } : null,
          escape_dc: escapeDc,
          escape_skill: hold,
        });
      }
    }
    if (zone && spell.mechanics?.area) {
      const m = spell.mechanics;
      const id = `zone-${e.next_effect++}`;
      const followsCaster = m.area?.shape === "emanation" && zone.anchor === "caster";
      const until = m.conditions.find((x) => x.until === "end_of_its_turn")
        ? "end_of_its_turn"
        : null;
      e.zones.push({
        id,
        spell: spell.id,
        label: spell.name,
        by: c.id,
        area: m.area as SpellArea,
        point: followsCaster ? null : (options.point ?? null),
        save: m.save ? { ...m.save, dc: r.save_dc ?? 0 } : null,
        damage: [...r.damage_parts],
        conditions: m.conditions.filter((x) => x.on === "failed_save").map((x) => x.condition),
        escape_dc: escapeDc,
        escape_skill: hold,
        until,
        triggers: [...zone.triggers],
        once_per_turn: zone.once_per_turn,
        optional: zone.optional,
        space: zone.space,
        ram: zone.ram,
        difficult: zone.difficult,
        on_fail: [...zone.on_fail],
        unaffected: [...(options.unaffected ?? [])].map((x) => find(x).id),
        concentration: spell.concentration,
        ends: rounds ? { at: "start", of: c.id, count: rounds, skip_current: false } : null,
        // The save on casting counts as this turn's.
        saved: r.targets.map((x) => (targets[x.target] as EncounterCombatant).id),
      });
      const WHEN = {
        enter: "enter it",
        start_turn: "start their turn there",
        end_turn: "end their turn there",
      } as const;
      const when = zone.triggers.flatMap((t) => (t === "move" ? [] : [WHEN[t]])).join(" or ");
      const lasts = `${spell.name} lasts (${id})`;
      if (when) notes.push(`${lasts}: creatures save when they ${when}.`);
      if (zone.triggers.includes("move")) {
        notes.push(`${lasts}: creatures take its damage for every 5 feet they move in it.`);
      }
    }
    return r;

    /** Until the start or end of `c`'s next turn. */
    function until(at: "start" | "end"): EffectEnd {
      return { at, of: c.id, count: 1, skip_current: at === "end" && current()?.id === c.id };
    }
  };
  /**
   * A follow-up saving throw's other creatures (Ice Knife): those given, else the positioned
   * creatures within its radius of the target.
   */
  const followUpNearby = (
    spell: SpellDef,
    targets: readonly EncounterCombatant[],
    ids: readonly string[] | undefined,
  ): EncounterCombatant[] => {
    const f = spell.mechanics?.follow_up;
    if (!f) {
      if (ids?.length) fail(`${spell.name} has no saving throw for creatures near its target`);
      return [];
    }
    if (ids) return ids.map(find);
    const target = targets[0];
    if (!target?.position) return [];
    return e.combatants.filter((x) => {
      if (targets.includes(x) || outOfFight(ctx, x) || !x.position) return false;
      const d = feetBetween(target, x);
      return d !== null && d <= f.radius;
    });
  };
  /** A monster action's daily uses ("(2/Day)"): refused when spent, else counted. */
  const spendDaily = (c: EncounterCombatant, key: string, perDay: number | null, what: string) => {
    if (perDay === null) return;
    const used = c.daily_used[key] ?? 0;
    if (used >= perDay)
      fail(`${c.name} has used ${what} ${perDay} time${perDay > 1 ? "s" : ""} today`);
    c.daily_used[key] = used + 1;
  };
  /** After every action: Concentration effects whose source stopped concentrating end. */
  const sweep = (): void => {
    const present = (id: string) => e.combatants.some((c) => c.id === id);
    e.masteries = e.masteries.filter((m) => present(m.by) && present(m.on));
    // A spell's mark stays when its caster leaves: the light is on the target.
    e.marks = e.marks.filter((m) => present(m.on));
    for (const z of [...e.zones]) {
      const source = e.combatants.find((c) => c.id === z.by);
      if (z.concentration && !source) endZone(z, "its caster left");
      else if (z.concentration && source && concentrationOf(source) !== z.label) {
        endZone(z, "Concentration ended");
      }
    }
    for (const effect of [...e.effects]) {
      const target = e.combatants.find((c) => c.id === effect.target);
      const source = effect.source ? e.combatants.find((c) => c.id === effect.source) : null;
      if (!target) endEffect(effect, "its target left");
      else if (!conditionsOf(ctx, target).has(effect.condition)) {
        // The condition was removed some other way (remove_condition, a rest): forget it.
        e.effects = e.effects.filter((x) => x.id !== effect.id);
      } else if (effect.source && !source) endEffect(effect, "its source left");
      else if (
        effect.condition === "grappled" &&
        source &&
        conditionsOf(ctx, source).has("incapacitated")
      ) {
        // SRD "Grappling": the condition ends if the grappler has the Incapacitated condition.
        endEffect(effect, `${source.name} is Incapacitated`);
      } else if (effect.concentration && source && concentrationOf(source) !== effect.label) {
        endEffect(effect, "Concentration ended");
      }
    }
  };
  /** Why an attack roll has Advantage from a spell's mark: `Guiding Bolt (Ilse's hit on Goblin)`. */
  const markReason = (mark: SpellMark): string => {
    const by = e.combatants.find((x) => x.id === mark.by)?.name ?? mark.by;
    return `${mark.label} (${by}'s hit on ${find(mark.on).name})`;
  };
  const find = (id: string) =>
    e.combatants.find((c) => c.id === id) ?? fail(`No combatant '${id}' in the encounter`);
  const current = () => currentCombatant(e);
  const onTurn = (c: EncounterCombatant, what: string) => {
    if (e.round === 0) fail("The fight hasn't started");
    if (current()?.id !== c.id) fail(`It isn't ${c.name}'s turn: only a reaction can ${what}`);
  };
  const canAct = (c: EncounterCombatant) => {
    if (c.defeated) fail(`${c.name} is defeated`);
    if (conditionsOf(ctx, c).has("incapacitated")) fail(`${c.name} is Incapacitated`);
  };
  /** One attack's place in the economy: the Attack action (and its extra attacks) or a reaction. */
  const spendAttack = (c: EncounterCombatant, reaction: boolean | undefined): void => {
    if (reaction) {
      if (e.round === 0) fail("The fight hasn't started");
      if (c.used.reaction) fail(`${c.name} has already used its reaction`);
      c.used.reaction = true;
      return;
    }
    onTurn(c, "attack");
    if (c.attacks_left > 0) c.attacks_left -= 1;
    else if (c.used.action) fail(`${c.name} has no attacks left this turn`);
    else {
      // The Attack action: Extra Attack or Multiattack give more attacks with it.
      c.used.action = true;
      c.attacks_left = encounterCombatant(e, c.id, ctx).attacks_per_action - 1;
    }
  };
  /** An action on its turn (or a Bonus Action, when a feature allows it: Cunning Action). */
  const takeAction = (c: EncounterCombatant, name: string, bonus?: boolean): void => {
    onTurn(c, name);
    canAct(c);
    const what = bonus ? "bonus_action" : "action";
    if (c.used[what]) fail(`${c.name} has already used its ${what.replace("_", " ")} this turn`);
    c.used[what] = true;
    if (bonus) c.extended = true; // a Bonus Action extends Rage
  };
  /** Help on `c`'s next check with `skill`, used up by it. */
  const helpOnCheck = (c: EncounterCombatant, skill: string | null): ModeReason[] => {
    const help = skill ? e.helps.find((h) => h.on === c.id && h.skill === skill) : undefined;
    if (!help) return [];
    e.helps = e.helps.filter((h) => h !== help);
    return [{ mode: "advantage", reason: `${find(help.by).name} Helps` }];
  };

  switch (action.type) {
    case "add_monster": {
      const def =
        lookup(ctx.catalog.monsters, action.monster) ?? fail(`Unknown monster '${action.monster}'`);
      const id = action.id ?? freeId(e, def.id);
      if (e.combatants.some((c) => c.id === id)) fail(`'${id}' is already in the encounter`);
      let hp = action.hp ?? def.hit_points;
      if (action.roll_hp && action.hp === undefined && def.hit_dice) {
        hp = Math.max(1, roll(def.hit_dice, rng).total);
      }
      const numbered = id === def.id ? def.name : `${def.name} ${id.slice(def.id.length + 1)}`;
      e.combatants.push(
        combatant({
          id,
          name: action.name ?? numbered,
          monster: def.id,
          side: action.side,
          hp,
          in_lair: action.in_lair ?? false,
          auto_legendary_resistance: action.auto_legendary_resistance ?? true,
          decisions: action.decisions ?? null,
        }),
      );
      notes.push(`${action.name ?? numbered} joins with ${hp} HP.`);
      break;
    }
    case "add_character": {
      const ref =
        ctx.characters?.[action.character] ?? fail(`No character '${action.character}' given`);
      const id = action.id ?? freeId(e, slugify(ref.build.name || action.character));
      if (e.combatants.some((c) => c.id === id)) fail(`'${id}' is already in the encounter`);
      if (e.combatants.some((c) => c.character === action.character)) {
        fail(`'${action.character}' is already in the encounter`);
      }
      const name = action.name ?? (ref.build.name || action.character);
      e.combatants.push(
        combatant({
          id,
          name,
          character: action.character,
          side: action.side ?? "party",
          decisions: action.decisions ?? null,
        }),
      );
      notes.push(`${name} joins.`);
      break;
    }
    case "decide":
      return fail("There's no decision to make");
    case "set_decisions": {
      if (action.id !== undefined) find(action.id).decisions = action.mode;
      else e.decisions = action.mode ?? fail("The encounter's mode is ask or auto");
      break;
    }
    case "remove": {
      const c = find(action.id);
      const index = e.order.indexOf(c.id);
      e.combatants = e.combatants.filter((x) => x.id !== c.id);
      if (index >= 0) {
        e.order.splice(index, 1);
        if (index < e.turn) e.turn -= 1;
        if (e.turn >= e.order.length) e.turn = 0;
      }
      notes.push(`${c.name} leaves the encounter.`);
      break;
    }
    case "roll_initiative": {
      const ids = action.ids ?? e.combatants.filter((c) => c.initiative === null).map((c) => c.id);
      const surprised = new Set(action.surprised ?? []);
      const groupRolls = new Map<string, number>();
      for (const id of ids) {
        const c = find(id);
        const bonus = initiativeBonus(ctx, c);
        const key = action.group && c.monster ? c.monster : null;
        let d20 = key !== null ? groupRolls.get(key) : undefined;
        if (d20 === undefined) {
          // Surprised: Disadvantage; conditions too (Invisible: Advantage, Incapacitated:
          // Disadvantage); features (Feral Instinct: Advantage).
          const view = encounterCombatant(e, c.id, ctx);
          const reasons: ModeReason[] = view.condition_rolls.initiative.map((x) => ({
            mode: x.mode,
            reason: `${c.name} is ${x.condition}`,
          }));
          if (view.advantages.includes("initiative")) {
            reasons.push({ mode: "advantage", reason: `${c.name}'s features` });
          }
          if (surprised.has(c.id)) reasons.push({ mode: "disadvantage", reason: "surprised" });
          d20 = rollD20({ mode: resolveMode("normal", reasons).mode, rng }).d20;
          if (key !== null) groupRolls.set(key, d20);
        }
        c.initiative = d20 + bonus;
        notes.push(`${c.name}: Initiative ${c.initiative} (${d20} ${signedText(bonus)}).`);
      }
      if (e.round > 0) reorder(e, ctx);
      break;
    }
    case "set_initiative": {
      find(action.id).initiative = action.value;
      if (e.round > 0) reorder(e, ctx);
      break;
    }
    case "set_order": {
      const everyone = e.combatants.map((c) => c.id);
      const same =
        action.ids.length === everyone.length && everyone.every((id) => action.ids.includes(id));
      if (!same) fail("set_order needs every combatant's id, once each");
      const now = current()?.id;
      const byId = new Map(e.combatants.map((c) => [c.id, c]));
      // Only ties can be reordered: the Initiative counts must still go down.
      const counts = action.ids.map((id) => byId.get(id)?.initiative ?? null);
      for (let i = 1; i < counts.length; i++) {
        const [a, b] = [counts[i - 1], counts[i]];
        if (a != null && b != null && b > a) fail("set_order can only reorder tied Initiatives");
      }
      e.order = [...action.ids];
      if (now) e.turn = e.order.indexOf(now);
      break;
    }
    case "start": {
      if (e.round > 0) fail("The fight has already started");
      if (!e.combatants.length) fail("No combatants");
      const missing = e.combatants.filter((c) => c.initiative === null).map((c) => c.name);
      if (missing.length) fail(`Roll Initiative first: ${missing.join(", ")}`);
      e.round = 1;
      e.order = [];
      reorder(e, ctx);
      for (const c of e.combatants) resetTurn(c);
      e.turn = 0;
      const first = skipToActive(e, ctx, notes, false);
      notes.push(`Round 1: ${first.name}'s turn.`);
      startTurn(first);
      break;
    }
    case "next_turn": {
      if (e.round === 0) fail("The fight hasn't started");
      const ending = current();
      if (ending) endTurn(ending);
      const next = skipToActive(e, ctx, notes, true);
      notes.push(`Round ${e.round}: ${next.name}'s turn.`);
      startTurn(next);
      break;
    }
    case "end": {
      if (e.round === 0) fail("The fight hasn't started");
      e.round = 0;
      e.turn = 0;
      e.order = [];
      for (const c of e.combatants) resetTurn(c);
      notes.push("The fight ends.");
      break;
    }
    case "use": {
      const c = find(action.id);
      if (action.what === "reaction") {
        if (e.round === 0) fail("The fight hasn't started");
      } else onTurn(c, "act");
      canAct(c);
      const label = action.what.replace("_", " ");
      if (c.used[action.what]) {
        fail(
          action.what === "reaction"
            ? `${c.name} has already used its reaction (it returns at the start of its turn)`
            : `${c.name} has already used its ${label} this turn`,
        );
      }
      c.used[action.what] = true;
      // A Bonus Action extends Rage.
      if (action.what === "bonus_action") c.extended = true;
      break;
    }
    case "move": {
      const c = find(action.id);
      onTurn(c, "move");
      if (c.defeated) fail(`${c.name} is defeated`);
      const from = c.position;
      if ((action.to || action.path) && !from) fail(`${c.name} has no position: place it first`);
      if (action.to && action.path) fail("Give a square to move to or a path, not both");
      const budget = speedOf(ctx, c, e) + c.extra_movement;
      const left = Math.max(0, budget - c.moved);
      const planned = from && (action.to || action.path) ? planMove(e, ctx, c, action) : null;
      const path = planned?.path ?? null;
      const steps = planned?.steps ?? [];
      const feet =
        action.feet ??
        (path
          ? steps.reduce((a, b) => a + b, 0)
          : fail("Give the feet moved or a square to move to"));
      if (c.moved + feet > budget) {
        fail(`${c.name} can move ${left} more feet this turn`);
      }
      if (!path) {
        c.moved += feet;
        break;
      }
      // Square by square: zones entered on the way, and damage for moving in some (Spike Growth);
      // leaving an enemy's reach, at the step it happens.
      const reachOf = new Map(
        e.combatants
          .filter((x) => x.id !== c.id && !x.defeated && !alliesOf(e, x.id, c) && x.position)
          .map((x) => [x, meleeReach(ctx, e, x)] as const),
      );
      const inReach = (x: EncounterCombatant, reach: number | null) => {
        const d = feetBetween(c, x);
        return reach !== null && d !== null && d <= reach;
      };
      const wasIn = new Map([...reachOf].map(([x, reach]) => [x, inReach(x, reach)]));
      const leftReach: EncounterCombatant[] = [];
      let zonesBefore = zoneOccupants();
      const zoneSteps = new Map<string, number>();
      let walked = 0;
      for (const [i, square] of path.entries()) {
        if (i === path.length - 1) occupy(c, square);
        else c.position = { ...square };
        walked += steps[i] ?? 5;
        for (const [x, reach] of reachOf) {
          const now = inReach(x, reach);
          if (wasIn.get(x) && !now && !leftReach.includes(x)) leftReach.push(x);
          wasIn.set(x, now);
        }
        for (const z of e.zones) {
          if (z.triggers.includes("move") && inZoneNow(z, zoneSquares(z), c)) {
            zoneSteps.set(z.id, (zoneSteps.get(z.id) ?? 0) + 1);
          }
        }
        zoneEntries(zonesBefore);
        zonesBefore = zoneOccupants();
        // Held on the way (Web) or out of the fight: it stops there.
        if (i < path.length - 1 && (outOfFight(ctx, c) || speedOf(ctx, c, e) === 0)) {
          notes.push(`${c.name} stops at ${square.x},${square.y}.`);
          break;
        }
      }
      c.moved += walked;
      zoneMoveDamage(c, zoneSteps);
      // Enemies whose reach it left can make an Opportunity Attack (not after Disengage).
      for (const x of reachOf.keys()) {
        if (leftReach.includes(x) && !c.disengaged && !x.used.reaction) {
          notes.push(
            `${c.name} leaves ${x.name}'s reach: ${x.name} can make an Opportunity Attack.`,
          );
        }
      }
      break;
    }
    case "set_terrain": {
      const keys = new Set(action.squares.map(squareKey));
      const others = (list: readonly GridPoint[]) => list.filter((p) => !keys.has(squareKey(p)));
      e.map.difficult = others(e.map.difficult);
      e.map.blocked = others(e.map.blocked);
      if (action.kind !== "clear") {
        e.map[action.kind].push(...action.squares.map((p) => ({ x: p.x, y: p.y })));
      }
      const what = { difficult: "Difficult Terrain", blocked: "blocked", clear: "clear" }[
        action.kind
      ];
      notes.push(
        `${action.squares.length} square${action.squares.length > 1 ? "s" : ""}: ${what}.`,
      );
      break;
    }
    case "add_wall":
    case "remove_wall": {
      const { from, to } = action;
      if (from.x === to.x && from.y === to.y) fail("A wall goes from one corner to another");
      const same = (w: { from: GridPoint; to: GridPoint }) =>
        (squareKey(w.from) === squareKey(from) && squareKey(w.to) === squareKey(to)) ||
        (squareKey(w.from) === squareKey(to) && squareKey(w.to) === squareKey(from));
      if (action.type === "add_wall") {
        if (e.map.walls.some(same)) fail("That wall is already there");
        e.map.walls.push({ from: { ...from }, to: { ...to } });
        notes.push(`A wall from ${from.x},${from.y} to ${to.x},${to.y}.`);
      } else {
        if (!e.map.walls.some(same)) fail(`No wall from ${from.x},${from.y} to ${to.x},${to.y}`);
        e.map.walls = e.map.walls.filter((w) => !same(w));
        notes.push(`The wall from ${from.x},${from.y} to ${to.x},${to.y} is gone.`);
      }
      break;
    }
    case "place": {
      occupy(find(action.id), { x: action.x, y: action.y });
      break;
    }
    case "dash": {
      const c = find(action.id);
      takeAction(c, "Dash", action.bonus_action);
      c.extra_movement += speedOf(ctx, c, e);
      notes.push(`${c.name} Dashes: ${speedOf(ctx, c, e) + c.extra_movement - c.moved} feet left.`);
      break;
    }
    case "disengage": {
      const c = find(action.id);
      takeAction(c, "Disengage", action.bonus_action);
      c.disengaged = true;
      notes.push(
        `${c.name} Disengages: its movement doesn't provoke Opportunity Attacks this turn.`,
      );
      break;
    }
    case "dodge": {
      const c = find(action.id);
      takeAction(c, "Dodge", action.bonus_action);
      c.dodging = true;
      notes.push(
        `${c.name} Dodges: until the start of its next turn, attack rolls against it have Disadvantage and it has Advantage on Dexterity saving throws.`,
      );
      break;
    }
    case "help": {
      const c = find(action.id);
      const t = find(action.target);
      if (t.id === c.id) fail(`${c.name} can't Help itself`);
      if (action.skill) {
        if (!alliesOf(e, c.id, t)) fail(`${t.name} isn't ${c.name}'s ally`);
        if (!proficientIn(ctx, c, action.skill)) {
          fail(`${c.name} isn't proficient in ${action.skill}: Help assists with a proficiency`);
        }
      } else {
        if (c.side && c.side === t.side) fail(`${t.name} is on ${c.name}'s side`);
        // "You momentarily distract an enemy within 5 feet of you."
        const d = feetBetween(c, t);
        if (d !== null && d > 5)
          fail(`${t.name} is ${d} feet away: Help distracts an enemy within 5 ft`);
      }
      takeAction(c, "Help");
      e.helps.push({ by: c.id, on: t.id, skill: action.skill ?? null });
      notes.push(
        action.skill
          ? `${c.name} Helps ${t.name}: Advantage on its next ${action.skill} check before the start of ${c.name}'s next turn.`
          : `${c.name} Helps against ${t.name}: Advantage on an ally's next attack roll against it before the start of ${c.name}'s next turn.`,
      );
      break;
    }
    case "unarmed": {
      const c = find(action.id);
      const t = find(action.target);
      canAct(c);
      if (action.option === "shove" && !action.shove)
        fail("A shove pushes or knocks Prone: `shove`");
      const user = encounterCombatant(e, c.id, ctx);
      const target = encounterCombatant(e, t.id, ctx);
      // "possible only if the target is no more than one size larger than you"
      const sizes = ["tiny", "small", "medium", "large", "huge", "gargantuan"];
      const [mine, theirs] = [sizes.indexOf(user.size ?? ""), sizes.indexOf(target.size ?? "")];
      if (mine >= 0 && theirs > mine + 1) {
        fail(`${t.name} is too large for ${c.name} to ${action.option}`);
      }
      const d = feetBetween(c, t);
      if (d !== null && d > 5) fail(`${t.name} is ${d} feet away: an Unarmed Strike reaches 5 ft`);
      spendAttack(c, action.reaction);
      c.extended = true; // forcing a saving throw extends Rage
      const dc = 8 + user.modifiers.str + user.proficiency_bonus;
      // The target chooses Strength or Dexterity: by default, its better bonus.
      const ability =
        action.save ?? (target.saving_throws.dex > target.saving_throws.str ? "dex" : "str");
      const save = rollSavingThrow(target, ability, dc, { rng, decide });
      result = save;
      const verb = action.option === "grapple" ? "grapple" : "shove";
      const outcome = save.success ? "succeeds on" : "fails";
      notes.push(
        `${c.name} tries to ${verb} ${t.name}: ${t.name} ${outcome} a ${ABILITY_NAMES[ability]} saving throw (${saveText(save)}).`,
      );
      spendLegendaryResistance(t, save);
      if (save.success) break;
      if (action.option === "grapple") {
        applyTo(t, [{ type: "add_condition", condition: "grappled" }]);
        addEffects(t, ["grappled"], {
          source: c.id,
          label: "Grapple",
          concentration: false,
          ends: null,
          escape_dc: dc,
        });
        if (conditionsOf(ctx, t).has("grappled")) {
          notes.push(`${t.name} is Grappled by ${c.name} (escape DC ${dc}).`);
        }
      } else if (action.shove === "prone") {
        applyTo(t, [{ type: "add_condition", condition: "prone" }]);
      } else notes.push(`${t.name} is pushed 5 feet away from ${c.name}.`);
      break;
    }
    case "escape": {
      const c = find(action.id);
      const holds = e.effects.filter((x) => x.target === c.id && x.escape_dc !== null);
      const hold = action.effect
        ? (holds.find((x) => x.id === action.effect) ??
          fail(`${action.effect} isn't a grapple or hold on ${c.name}`))
        : holds.length === 1
          ? (holds[0] as EncounterEffect)
          : holds.length
            ? fail(`Choose what to escape: ${holds.map((x) => x.id).join(", ")}`)
            : fail(`${c.name} has no grapple or hold with an escape DC`);
      if (action.skill && hold.escape_skill && action.skill !== hold.escape_skill) {
        fail(`Escaping ${hold.label} takes an ${skillName(hold.escape_skill)} check`);
      }
      takeAction(c, "escape");
      const me = encounterCombatant(e, c.id, ctx);
      const bonus = (skill: "athletics" | "acrobatics") =>
        me.skills[skill] ?? me.ability_checks[skill === "athletics" ? "str" : "dex"];
      const skill =
        hold.escape_skill ??
        action.skill ??
        (bonus("acrobatics") > bonus("athletics") ? "acrobatics" : "athletics");
      const check = rollAbilityCheck(me, { skill }, hold.escape_dc, {
        rng,
        decide,
        modes: helpOnCheck(c, skill),
      });
      result = check;
      useInspiration(c, check.inspiration);
      const why = check.reasons.length ? `; ${check.reasons.join("; ")}` : "";
      const condition = lookup(ctx.catalog.conditions, hold.condition)?.name ?? hold.condition;
      const outcome = check.success ? "escapes" : `stays ${condition}`;
      notes.push(
        `${c.name} tries to escape (${skill} ${check.total} vs DC ${hold.escape_dc}${why}): ${outcome}.`,
      );
      if (check.success) endEffect(hold, "escaped");
      break;
    }
    case "stand": {
      const c = find(action.id);
      onTurn(c, "stand up");
      if (c.defeated) fail(`${c.name} is defeated`);
      const own = c.monster !== null ? c.conditions : characterRef(ctx, c).state.conditions;
      if (!own.includes("prone")) fail(`${c.name} isn't Prone`);
      const speed = speedOf(ctx, c, e);
      if (speed === 0) fail(`${c.name} can't right itself at Speed 0`);
      // "spend an amount of movement equal to half your Speed (round down)"
      const cost = Math.floor(speed / 2);
      const budget = speed + c.extra_movement;
      if (c.moved + cost > budget) fail(`${c.name} needs ${cost} feet of movement to stand up`);
      c.moved += cost;
      applyTo(c, [{ type: "remove_condition", condition: "prone" }]);
      notes.push(`${c.name} stands up (${cost} feet of movement).`);
      break;
    }
    case "effects": {
      const c = find(action.id);
      applyTo(c, action.actions);
      const source = action.source;
      if (source !== undefined) find(source);
      const ends = endsFrom(c.id, source, action.rounds, action.until);
      // Tracked when it has a duration, depends on Concentration, or has a known source (a
      // grapple: Grappled's Disadvantage doesn't apply against the grappler).
      if (ends || action.concentration || source !== undefined) {
        if (action.concentration && !source) fail("A Concentration effect needs its source");
        const conditions = action.actions.flatMap((a) =>
          a.type === "add_condition" ? [a.condition] : [],
        );
        const label =
          action.label ??
          (action.concentration ? (concentrationOf(find(source as string)) ?? "") : "effect");
        if (action.concentration && !label)
          fail(`${find(source as string).name} isn't concentrating`);
        if (action.escape_dc !== undefined && !source) fail("A grapple needs its source");
        addEffects(c, conditions, {
          source: source ?? null,
          label,
          concentration: action.concentration ?? false,
          ends,
          escape_dc: action.escape_dc,
        });
      }
      break;
    }
    case "zone_save": {
      const z = e.zones.find((x) => x.id === action.zone) ?? fail(`No zone '${action.zone}'`);
      for (const id of action.targets) {
        const t = find(id);
        if (z.once_per_turn && z.saved.includes(t.id)) {
          notes.push(`${t.name} has already saved against ${z.label} this turn.`);
        }
      }
      zoneSave(z, action.targets, action.targets.length > 1 ? "save" : "saves");
      break;
    }
    case "move_zone": {
      const z = e.zones.find((x) => x.id === action.zone) ?? fail(`No zone '${action.zone}'`);
      if (!z.point) fail(`${z.label} moves with its caster`);
      if (action.onto && !z.ram) fail(`${z.label} doesn't make a creature save by moving into it`);
      const before = zoneOccupants();
      z.point = { ...action.point };
      notes.push(`${z.label} moves to ${action.point.x},${action.point.y}.`);
      zoneEntries(before);
      if (action.onto) zoneSave(z, [action.onto], "is in its way");
      break;
    }
    case "end_zone": {
      const z = e.zones.find((x) => x.id === action.zone) ?? fail(`No zone '${action.zone}'`);
      endZone(z, "ended");
      break;
    }
    case "end_effect": {
      const effect =
        e.effects.find((x) => x.id === action.effect) ?? fail(`No effect '${action.effect}'`);
      endEffect(effect, "ended");
      break;
    }
    case "check": {
      const c = find(action.id);
      if (c.defeated) fail(`${c.name} is defeated`);
      const what = action.skill
        ? { skill: action.skill }
        : { ability: action.ability ?? fail("A check needs a skill or an ability") };
      const check = rollAbilityCheck(encounterCombatant(e, c.id, ctx), what, action.dc ?? null, {
        rng,
        decide,
        mode: action.mode,
        modes: helpOnCheck(c, action.skill ?? null),
      });
      result = check;
      useInspiration(c, check.inspiration);
      const label = check.skill ? skillName(check.skill as Skill) : ABILITY_NAMES[check.ability];
      const dc = check.dc === null ? "" : ` vs DC ${check.dc}`;
      const why = check.reasons.length ? `; ${check.reasons.join("; ")}` : "";
      const outcome = check.success === null ? "" : check.success ? ": success" : ": failure";
      notes.push(`${c.name}'s ${label} check: ${check.total}${dc}${why}${outcome}.`);
      break;
    }
    case "extend": {
      find(action.id).extended = true;
      break;
    }
    case "attack": {
      const c = find(action.id);
      const t = find(action.target);
      canAct(c);
      const attacker = encounterCombatant(e, c.id, ctx);
      const line = attacker.attacks.find((a) => a.name === action.attack);
      const light = line?.properties.includes("light") ?? false;
      if (action.granted) {
        // An attack a feature granted this turn (Flurry of Blows), without spending an action.
        onTurn(c, "attack");
        const granted = c.granted_attacks;
        if (!granted || granted.count === 0)
          fail(`${c.name} has no granted attacks left this turn`);
        if (granted.attack !== action.attack) fail(`The granted attacks are ${granted.attack}s`);
        granted.count -= 1;
      } else if (action.cleave) {
        // SRD "Cleave": after a melee hit with this weapon, an attack against a second creature
        // within 5 feet of the first, once per turn; it isn't one of the Attack action's attacks.
        onTurn(c, "attack");
        if (c.cleave_used) fail(`${c.name} has already made its Cleave attack this turn`);
        const from =
          c.cleave ?? fail(`${c.name} hasn't hit a creature with a Cleave weapon this turn`);
        if (from.attack !== action.attack) fail(`The Cleave attack is made with ${from.attack}`);
        if (from.target === t.id) fail("The Cleave attack is against a second creature");
        c.cleave = null;
        c.cleave_used = true;
      } else if (action.light_extra) {
        // SRD "Light": after attacking with a Light weapon in the Attack action, one extra attack
        // as a Bonus Action with a different Light weapon.
        onTurn(c, "attack");
        if (!light) fail(`${action.attack} isn't a Light weapon`);
        if (!c.light_attacks.length) {
          fail(`${c.name} hasn't attacked with a Light weapon in the Attack action this turn`);
        }
        const same = attacker.attacks.filter((a) => a.name === action.attack).length;
        if (same < 2 && c.light_attacks.every((name) => name === action.attack)) {
          fail(`The extra attack must be made with a different Light weapon than ${action.attack}`);
        }
        // Nick: "as part of the Attack action instead of as a Bonus Action", once per turn.
        if (line?.mastery === "Nick" && action.mastery !== false && !c.nick_used) {
          c.nick_used = true;
          notes.push(`Nick: ${c.name}'s extra attack is part of the Attack action.`);
        } else {
          if (c.used.bonus_action) fail(`${c.name} has already used its bonus action this turn`);
          c.used.bonus_action = true;
        }
      } else {
        const reaction = action.reaction || action.opportunity;
        if (action.opportunity) {
          if (line && line.kind !== "melee") fail("An Opportunity Attack is a melee attack");
          if (t.disengaged)
            fail(`${t.name} Disengaged: its movement doesn't provoke Opportunity Attacks`);
        }
        spendAttack(c, reaction);
        if (light && !reaction) c.light_attacks.push(action.attack);
      }
      if (c.monster !== null)
        spendDaily(c, action.attack, dailyUses(ctx, c, action.attack), action.attack);
      result = attackOn(c, t, action.attack, action);
      break;
    }
    case "save_action": {
      const c = find(action.id);
      onTurn(c, "act");
      canAct(c);
      if (c.expended.includes(action.ability))
        fail(`${c.name}'s ${action.ability} hasn't recharged`);
      if (c.used.action) fail(`${c.name} has already used its action this turn`);
      const user = encounterCombatant(e, c.id, ctx);
      const line = user.save_actions.find((a) => a.name === action.ability);
      if (c.monster !== null)
        spendDaily(c, action.ability, dailyUses(ctx, c, action.ability), action.ability);
      const targets = line
        ? saveTargets(c, line, action.area, action.targets)
        : (action.targets ?? []);
      result = saveEffectOn(c, user, action.ability, targets, action.cover, !!action.area);
      c.used.action = true;
      if (line?.recharge) c.expended.push(action.ability);
      break;
    }
    case "legendary": {
      const c = find(action.id);
      if (c.monster === null) fail(`${c.name} has no legendary actions`);
      if (e.round === 0) fail("The fight hasn't started");
      if (current()?.id === c.id) {
        fail(`${c.name} takes legendary actions after another creature's turn, not on its own`);
      }
      canAct(c);
      const def = monsterDef(ctx, c);
      const perRound = def.legendary_uses
        ? c.in_lair && def.legendary_uses.in_lair !== null
          ? def.legendary_uses.in_lair
          : def.legendary_uses.uses
        : 0;
      if (c.legendary_used >= perRound) {
        fail(`${c.name} has no legendary action uses left until the start of its turn`);
      }
      const user = encounterCombatant(e, c.id, ctx);
      const line =
        user.legendary_actions.find((a) => a.name === action.action) ??
        fail(
          `${c.name} has no legendary action '${action.action}' (${user.legendary_actions.map((a) => a.name).join(", ")})`,
        );
      if (line.once_per_round && c.legendary_taken.includes(line.name)) {
        fail(`${c.name} can't take ${line.name} again until the start of its next turn`);
      }
      c.legendary_used += 1;
      if (line.once_per_round) c.legendary_taken.push(line.name);
      notes.push(
        `${c.name} takes a legendary action: ${line.name} (${perRound - c.legendary_used} left this round).`,
      );
      const needTarget = () => find(action.target ?? fail(`${line.name} needs a target`));
      const attackable = (name: string) => user.attacks.some((a) => a.name === name);
      if (line.attacks.length) {
        const attack =
          action.attack ??
          (line.attacks.length === 1
            ? (line.attacks[0] as string)
            : fail(`${line.name}: choose the attack (${line.attacks.join(" or ")})`));
        if (!line.attacks.includes(attack)) {
          fail(`${line.name} makes one ${line.attacks.join(" or ")} attack, not ${attack}`);
        }
        if (!attackable(attack)) fail(`${attack} has no attack roll to resolve: see its text`);
        result = attackOn(c, needTarget(), attack, action);
      } else if (line.uses && attackable(line.uses)) {
        result = attackOn(c, needTarget(), line.uses, action);
      } else if (line.uses && user.save_actions.some((a) => a.name === line.uses)) {
        const used = user.save_actions.find((a) => a.name === line.uses) as SaveActionLine;
        result = saveEffectOn(
          c,
          user,
          line.uses,
          saveTargets(c, used, action.area, action.targets),
          undefined,
          !!action.area,
        );
      } else if (def.legendary_actions.find((a) => a.name === line.name)?.casts) {
        // "uses Spellcasting to cast Fear": the spell, at its listed level, through this action.
        const cast = monsterSpells(def).find(
          (x) => x.section === "legendary_actions" && x.action === line.name,
        ) as ReturnType<typeof monsterSpells>[number];
        const spell =
          lookup(ctx.catalog.spells, cast.spell) ?? fail(`Unknown spell '${cast.spell}'`);
        const area = action.area ? spellArea(c, spell, action.area) : null;
        const targets = area ?? action.targets ?? (action.target ? [action.target] : []);
        result = castBy(c, spell, targets, {
          slot_level: spell.level === 0 ? undefined : (cast.level ?? spell.level),
          mode: action.mode,
          spellcasting: line.name,
          area: area !== null,
        });
      } else if (line.save) {
        result = saveEffectOn(
          c,
          { ...user, save_actions: [line.save] },
          line.name,
          saveTargets(c, line.save, action.area, action.targets),
          undefined,
          !!action.area,
        );
      } else {
        notes.push(`${line.name}: its effect is in the stat block's text.`);
      }
      break;
    }
    case "feature": {
      const c = find(action.id);
      if (c.character === null) fail(`${c.name} has no class features`);
      const ref = characterRef(ctx, c);
      const f =
        computePlaySheet(ref.build, ref.state, ctx.catalog).actions.find(
          (a) => a.key === action.feature || a.name === action.feature,
        ) ?? fail(`${c.name} has no feature '${action.feature}'`);
      if (f.halves_attack_damage) {
        fail(`${f.name} is offered when an attack hits ${c.name}`);
      }
      const t = action.target ? find(action.target) : c;
      if (f.target === "self" && t !== c) fail(`${f.name} is used on yourself`);
      if (f.target === "other" && t === c) fail(`${f.name} is used on another creature`);
      if (f.economy === "reaction") {
        if (e.round === 0) fail("The fight hasn't started");
        canAct(c);
        if (c.used.reaction) fail(`${c.name} has already used its reaction`);
        c.used.reaction = true;
      } else if (f.economy === "free") {
        onTurn(c, `use ${f.name}`);
        canAct(c);
      } else takeAction(c, f.name, f.economy === "bonus_action");
      if (f.once_per_turn && c.features_used.includes(f.key)) {
        fail(`${c.name} has already used ${f.name} this turn`);
      }
      if (f.after_hit && !c.hits.includes(t.id)) fail(`${c.name} hasn't hit ${t.name} this turn`);
      if (f.extra_action && !c.used.action) {
        fail(`Take your action first: ${f.name} gives one additional action`);
      }
      notes.push(`${c.name} uses ${f.name}${t === c ? "" : ` on ${t.name}`}.`);
      play(c, { type: "use_feature", key: f.key, amount: action.amount });
      if (f.once_per_turn) c.features_used.push(f.key);
      if (f.heal && f.target !== "self") {
        const amount = f.heal.pooled
          ? (action.amount as number)
          : rollDamage([{ dice: f.heal.dice, bonus: f.heal.bonus, type: "healing" }], { rng })
              .total;
        applyTo(t, [{ type: "heal", amount }]);
        notes.push(`${t.name} regains ${amount} Hit Points.`);
      }
      if (f.extra_action) {
        c.used.action = false;
        c.attacks_left = 0;
        c.surged = true;
      }
      for (const also of f.also) {
        if (also === "dash") c.extra_movement += speedOf(ctx, c, e);
        if (also === "disengage") c.disengaged = true;
        if (also === "dodge") c.dodging = true;
      }
      if (f.attacks) c.granted_attacks = { ...f.attacks };
      if (f.save) {
        const save = rollSavingThrow(encounterCombatant(e, t.id, ctx), f.save.ability, f.save.dc, {
          rng,
          decide,
        });
        result = save;
        notes.push(`${t.name} ${save.success ? "succeeds" : "fails"} (${saveText(save)}).`);
        spendLegendaryResistance(t, save);
        if (!save.success && f.save.conditions.length) {
          applyTo(
            t,
            f.save.conditions.map((condition) => ({ type: "add_condition", condition }) as const),
          );
          addEffects(t, f.save.conditions, {
            source: c.id,
            label: f.name,
            concentration: false,
            ends: { at: "start", of: c.id, count: 1, skip_current: false },
          });
        }
      }
      if (f.inspiration_die) {
        t.inspiration = { die: f.inspiration_die, by: c.id };
        notes.push(`${t.name} has a Bardic Inspiration die (d${f.inspiration_die}).`);
      }
      break;
    }
    case "cast": {
      const c = find(action.id);
      canAct(c);
      const spell =
        lookup(ctx.catalog.spells, action.spell) ?? fail(`Unknown spell '${action.spell}'`);
      let what: "action" | "bonus_action" | "reaction" = "action";
      let slot_level = action.slot_level;
      let spellcasting: string | undefined;
      let line: ReturnType<typeof monsterSpells>[number] | undefined;
      if (c.character !== null) {
        const ref = characterRef(ctx, c);
        const known = computePlaySheet(ref.build, ref.state, ctx.catalog).spells;
        if (!known.some((x) => x.id === spell.id)) fail(`${c.name} can't cast ${spell.name}`);
        what = castingEconomy(spell);
      } else {
        // A monster casts it through an action that lists it (legendary ones: `legendary`).
        const lines = monsterSpells(monsterDef(ctx, c)).filter(
          (x) =>
            x.spell === spell.id &&
            x.section !== "legendary_actions" &&
            (action.via === undefined || x.action === action.via),
        );
        if (!lines.length) {
          fail(`${c.name} can't cast ${spell.name}${action.via ? ` with ${action.via}` : ""}`);
        }
        if (lines.length > 1) {
          fail(
            `${c.name} casts ${spell.name} with ${lines.map((x) => x.action).join(" or ")}: give \`via\``,
          );
        }
        line = lines[0] as (typeof lines)[number];
        if (!/^(Action|Bonus Action|Reaction)\b/.test(spell.casting_time)) {
          fail(
            `${spell.name} takes ${spell.casting_time}: a monster casts it with the Magic action on each of its turns, which isn't modeled`,
          );
        }
        what =
          line.section === "bonus_actions"
            ? "bonus_action"
            : line.section === "reactions"
              ? "reaction"
              : "action";
        // "always cast at its lowest possible level and can't be cast at a higher level"
        const fixed = spell.level === 0 ? undefined : (line.level ?? spell.level);
        if (action.slot_level !== undefined && action.slot_level !== fixed) {
          fail(`${c.name} casts ${spell.name} at level ${fixed ?? 0} only`);
        }
        slot_level = fixed;
        spellcasting = line.action;
        if (line.recharge && c.expended.includes(line.action)) {
          fail(`${c.name}'s ${line.action} hasn't recharged`);
        }
      }
      if (what === "reaction") {
        if (e.round === 0) fail("The fight hasn't started");
      } else onTurn(c, "cast");
      if (c.used[what]) fail(`${c.name} has already used its ${what.replace("_", " ")}`);
      if (what === "action" && c.surged) {
        fail("Action Surge's additional action can't be the Magic action (casting a spell)");
      }
      if (action.area && action.targets?.length) fail("Give targets or an area, not both");
      // A zone that makes no save when it appears (Spirit Guardians, Web) only takes its place.
      const placeOnly = action.area && spell.mechanics?.zone && !spell.mechanics.zone.on_cast;
      if (placeOnly) checkZonePoint(c, spell, action.area?.point);
      const area = placeOnly ? [] : action.area ? spellArea(c, spell, action.area) : null;
      result = castBy(c, spell, area ?? action.targets ?? [], {
        slot_level,
        pact: action.pact,
        mode: action.mode,
        spellcasting,
        cover: action.cover,
        area: area !== null,
        nearby: action.nearby,
        damage_type: action.damage_type,
        point: action.area?.point,
        unaffected: action.unaffected,
      });
      c.used[what] = true;
      // A refused action throws, and the working copy of the encounter is dropped.
      if (line) {
        spendDaily(c, line.action, line.action_per_day, line.action);
        spendDaily(c, `${line.action}#${line.spell}`, line.per_day, spell.name);
        if (line.recharge) c.expended.push(line.action);
      }
      break;
    }
  }
  sweep();
  return { encounter: EncounterSchema.parse(e), states, notes, result };
}

// --- helpers ------------------------------------------------------------------------------------

function fail(message: string): never {
  throw new EncounterError([message]);
}

function combatant(fields: Partial<EncounterCombatant>): EncounterCombatant {
  return EncounterCombatantSchema.parse(fields);
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "character"
  );
}

/** `goblin-warrior`, then `goblin-warrior-2`, `-3`… */
function freeId(e: Encounter, base: string): string {
  const taken = new Set(e.combatants.map((c) => c.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function signedText(n: number): string {
  return n < 0 ? `- ${-n}` : `+ ${n}`;
}

export function monsterDef(ctx: EncounterContext, c: EncounterCombatant): MonsterDef {
  return lookup(ctx.catalog.monsters, c.monster) ?? fail(`Unknown monster '${c.monster}'`);
}

export function characterRef(ctx: EncounterContext, c: EncounterCombatant): CharacterRef {
  return (
    ctx.characters?.[c.character ?? ""] ??
    fail(`${c.name}: the character '${c.character}' wasn't given`)
  );
}

function initiativeBonus(ctx: EncounterContext, c: EncounterCombatant): number {
  if (c.monster !== null) return monsterDef(ctx, c).initiative;
  const ref = characterRef(ctx, c);
  return computePlaySheet(ref.build, ref.state, ctx.catalog).initiative.total;
}

/** Active conditions, implied ones included. */
export function conditionsOf(ctx: EncounterContext, c: EncounterCombatant): Set<string> {
  if (c.monster === null) {
    const ref = characterRef(ctx, c);
    const sheet = computePlaySheet(ref.build, ref.state, ctx.catalog);
    return new Set(sheet.play.conditions.map((x) => x.id));
  }
  const out = new Set<string>();
  const add = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    for (const next of lookup(ctx.catalog.conditions, id)?.implies ?? []) add(next);
  };
  for (const id of c.conditions) add(id);
  return out;
}

/** Walking Speed now (0 while a condition sets it to 0: Grappled, Restrained…). */
export function speedOf(ctx: EncounterContext, c: EncounterCombatant, e: Encounter): number {
  let speed: number;
  if (c.monster === null) {
    const ref = characterRef(ctx, c);
    speed = computePlaySheet(ref.build, ref.state, ctx.catalog).speed.total;
  } else {
    const stopped = [...conditionsOf(ctx, c)].some(
      (id) => lookup(ctx.catalog.conditions, id)?.speed_zero,
    );
    speed = stopped ? 0 : (monsterDef(ctx, c).speed.walk ?? 0);
  }
  // Slow: −10 feet, however many times it was hit by Slow weapons.
  const slowed = e.masteries.some((m) => m.mastery === "slow" && m.on === c.id);
  return slowed ? Math.max(0, speed - 10) : speed;
}

/** Out of the fight: a defeated monster, or a dead character. */
export function outOfFight(ctx: EncounterContext, c: EncounterCombatant): boolean {
  if (c.monster !== null) return c.defeated;
  return characterRef(ctx, c).state.dead;
}

/** The start of a creature's turn: action, Bonus Action, reaction and movement come back. */
function resetTurn(c: EncounterCombatant): void {
  c.used = { action: false, bonus_action: false, reaction: false };
  c.moved = 0;
  c.extra_movement = 0;
}

/**
 * Sort by Initiative, highest first. Ties: the higher Initiative bonus, then the order in the
 * current turn order or, for newcomers, the order they joined (the GM can change ties with
 * `set_order`). Keeps whose turn it is.
 */
function reorder(e: Encounter, ctx: EncounterContext): void {
  const now = currentCombatant(e)?.id;
  const place = (id: string) => {
    const i = e.order.indexOf(id);
    return i >= 0 ? i : e.order.length + e.combatants.findIndex((c) => c.id === id);
  };
  const ready = e.combatants.filter((c) => c.initiative !== null);
  const bonus = new Map(ready.map((c) => [c.id, initiativeBonus(ctx, c)]));
  e.order = ready
    .map((c) => c.id)
    .sort((a, b) => {
      const [ca, cb] = [e.combatants.find((c) => c.id === a), e.combatants.find((c) => c.id === b)];
      return (
        (cb?.initiative ?? 0) - (ca?.initiative ?? 0) ||
        (bonus.get(b) ?? 0) - (bonus.get(a) ?? 0) ||
        place(a) - place(b)
      );
    });
  if (now) e.turn = Math.max(0, e.order.indexOf(now));
}

/**
 * Move to the next combatant who can take a turn (from the current one if `advance` is false),
 * starting a new round after the last, and reset what it spent. Notes a character at 0 HP.
 */
function skipToActive(
  e: Encounter,
  ctx: EncounterContext,
  notes: string[],
  advance: boolean,
): EncounterCombatant {
  for (let step = advance ? 1 : 0; step <= e.order.length; step++) {
    const index = (e.turn + step) % e.order.length;
    if (advance && step > 0 && index === 0) e.round += 1;
    const c = e.combatants.find((x) => x.id === e.order[index]);
    if (!c || outOfFight(ctx, c)) {
      if (c) notes.push(`${c.name} is out of the fight: turn skipped.`);
      continue;
    }
    e.turn = index;
    resetTurn(c);
    return c;
  }
  return fail("No one is left to take a turn");
}

/** A play action applied to a monster in the encounter. */
function monsterEffect(ctx: EncounterContext, c: EncounterCombatant, a: PlayAction): string[] {
  const def = monsterDef(ctx, c);
  const hp = c.hp ?? def.hit_points;
  switch (a.type) {
    case "damage": {
      if (c.defeated) fail(`${c.name} is already defeated`);
      const petrified = conditionsOf(ctx, c).has("petrified");
      const result = takeDamage(
        { hp, temp: c.temp_hp, max: def.hit_points },
        a.instances ?? [{ amount: a.amount ?? 0, type: a.damage_type ?? null }],
        {
          resistances: petrified ? [...def.resistances, "all"] : def.resistances,
          vulnerabilities: def.vulnerabilities,
          immunities: def.immunities,
        },
        { critical: a.critical },
      );
      c.hp = result.hp;
      c.temp_hp = result.temp;
      // Massive Damage and Death Saving Throws are for characters: a monster just dies at 0 HP.
      const notes = result.notes.filter((n) => !/^(Massive damage|Damage at 0 HP)/.test(n));
      // SRD "Monster Death": a monster dies the instant it drops to 0 Hit Points.
      if (result.hp === 0) {
        c.defeated = true;
        notes.push(`${c.name} drops to 0 Hit Points and dies.`);
      }
      return notes;
    }
    case "heal": {
      if (c.defeated) fail(`${c.name} is dead: healing can't help`);
      c.hp = Math.min(def.hit_points, hp + Math.max(0, a.amount));
      return [];
    }
    case "set_temp_hp": {
      c.temp_hp = a.replace === false ? Math.max(c.temp_hp, a.amount) : a.amount;
      return [];
    }
    case "add_condition": {
      const condition =
        lookup(ctx.catalog.conditions, a.condition) ?? fail(`Unknown condition '${a.condition}'`);
      if (def.condition_immunities.includes(condition.id)) {
        return [`${c.name} is immune to ${condition.name}.`];
      }
      if (!c.conditions.includes(condition.id)) c.conditions.push(condition.id);
      return [];
    }
    case "remove_condition": {
      if (!c.conditions.includes(a.condition)) fail(`${c.name} isn't ${a.condition}`);
      c.conditions = c.conditions.filter((x) => x !== a.condition);
      return [];
    }
    case "set_concentration": {
      const previous = c.concentration;
      c.concentration = a.spell;
      return previous && a.spell ? [`Concentration on ${previous} ends.`] : [];
    }
    case "spend_slot":
    case "spend_pact_slot":
      return []; // a monster's spell slots aren't tracked
    default:
      return fail(`A monster can't take the play action '${a.type}'`);
  }
}

/** "14 vs DC 13", or "fails automatically: Paralyzed". */
/** One target's share of a spell or saving throw effect: "Brakka: fails (12 vs DC 14): 28 fire." */
function targetNote(name: string, hit: SpellTargetResult, ac?: number): string {
  const parts: string[] = [];
  if (hit.save) parts.push(`${hit.save.success ? "succeeds" : "fails"} (${saveText(hit.save)})`);
  if (hit.attack) {
    const crit = hit.critical ? "Critical Hit, " : "";
    const roll = `${hit.attack.total} vs AC${ac === undefined ? "" : ` ${ac}`}`;
    parts.push(hit.attack.hit ? `${crit}hit (${roll})` : `missed (${roll})`);
  }
  const damage = hit.instances.map((d) => `${d.amount} ${d.type}`).join(" + ");
  const effects = [
    damage,
    hit.healing ? `regains ${hit.healing} HP` : "",
    hit.conditions.length ? hit.conditions.join(", ") : "",
  ].filter(Boolean);
  const head = parts.length ? `${name}: ${parts.join(", ")}` : name;
  return effects.length
    ? `${head}: ${effects.join("; ")}.`
    : `${head}${parts.length ? "." : ": no effect."}`;
}

function saveText(save: SaveResult): string {
  if (save.automatic_failure) return `fails automatically: ${save.automatic_failure}`;
  const mode = save.roll.mode === "normal" ? "" : `, ${save.roll.mode}`;
  return `${save.total} vs DC ${save.dc}${mode}`;
}

/** A given path: each square next to the one before it (diagonals included). */
export function checkedPath(from: GridPoint, path: readonly GridPoint[]): GridPoint[] {
  let at = from;
  for (const square of path) {
    if (Math.max(Math.abs(square.x - at.x), Math.abs(square.y - at.y)) !== 1) {
      fail(`The path jumps from ${at.x},${at.y} to ${square.x},${square.y}: give every square`);
    }
    at = square;
  }
  return path.map((p) => ({ ...p }));
}

/** The action economy a spell's casting time uses. */
export function castingEconomy(spell: SpellDef): "action" | "bonus_action" | "reaction" {
  if (/^Action/i.test(spell.casting_time)) return "action";
  if (/^Bonus Action/i.test(spell.casting_time)) return "bonus_action";
  if (/^Reaction/i.test(spell.casting_time)) return "reaction";
  return fail(`${spell.name} takes ${spell.casting_time} to cast: not in combat`);
}

/** A spell's range in feet ("60 feet"), or `null` (Self, Touch, Sight, Unlimited…). */
export function spellRangeFeet(spell: SpellDef): number | null {
  const feet = /^(\d+) feet$/.exec(spell.range)?.[1];
  return feet ? Number(feet) : null;
}

/** How far a spell's target can be: its range in feet, 5 for Touch, else `null` (unchecked). */
export function spellTargetRange(spell: SpellDef): number | null {
  return spell.range === "Touch" ? 5 : spellRangeFeet(spell);
}

/** Feet between two positioned combatants (nearest squares of their spaces), else `null`. */
export function feetApart(
  ctx: EncounterContext,
  a: EncounterCombatant,
  b: EncounterCombatant,
): number | null {
  if (!a.position || !b.position) return null;
  return gridDistance(a.position, spaceOf(ctx, a), b.position, spaceOf(ctx, b));
}

/** Positioned enemies of `c` within 5 feet that aren't Incapacitated (close combat). */
export function enemiesWithin5(
  e: Encounter,
  ctx: EncounterContext,
  c: EncounterCombatant,
): EncounterCombatant[] {
  return e.combatants.filter((x) => {
    if (x.id === c.id || x.defeated || alliesOf(e, x.id, c)) return false;
    const d = feetApart(ctx, c, x);
    return d !== null && d <= 5 && !conditionsOf(ctx, x).has("incapacitated");
  });
}

/** "Concentration, up to 1 minute" → 10 rounds; `null` when it isn't counted in rounds. */
function durationRounds(spell: SpellDef): number | null {
  const m = /(?:up to )?(\d+) (round|minute|hour)s?/i.exec(spell.duration);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "round" ? n : m[2] === "minute" ? n * 10 : n * 600;
}

/** Whether `c` is an ally of combatant `id`: on its side (combatants without a side are all allies). */
export function alliesOf(e: Encounter, id: string, c: EncounterCombatant): boolean {
  const other = e.combatants.find((x) => x.id === id);
  return !!other && other.side === c.side;
}

/** Proficient in a skill: a character's sheet, or a skill a monster's stat block lists. */
export function proficientIn(ctx: EncounterContext, c: EncounterCombatant, skill: string): boolean {
  if (c.monster !== null) return Object.hasOwn(monsterDef(ctx, c).skills, skill);
  const ref = characterRef(ctx, c);
  const sheet = computePlaySheet(ref.build, ref.state, ctx.catalog);
  return sheet.skills.some((line) => line.skill === skill && line.proficient_from !== null);
}

/** A monster action's uses per day ("(1/Day)" in its name), or `null`. */
export function dailyUses(
  ctx: EncounterContext,
  c: EncounterCombatant,
  name: string,
): number | null {
  const def = monsterDef(ctx, c);
  const all = [...def.actions, ...def.bonus_actions, ...def.reactions];
  return all.find((a) => a.name === name)?.per_day ?? null;
}

export type Cover = "half" | "three_quarters" | "total";

/** A target behind cover: +2 or +5 to AC and Dexterity saves; Total Cover can't be targeted. */
function withCover(view: Combatant, cover: Cover | undefined): Combatant {
  if (!cover) return view;
  if (cover === "total") fail(`${view.name} has Total Cover: it can't be targeted`);
  const bonus = cover === "half" ? 2 : 5;
  return {
    ...view,
    armor_class: view.armor_class + bonus,
    saving_throws: { ...view.saving_throws, dex: view.saving_throws.dex + bonus },
  };
}

/** Squares on a side of a creature's space (SRD "Creature Size and Space"); Tiny counts as one. */
const SPACE: Readonly<Record<string, number>> = { large: 2, huge: 3, gargantuan: 4 };
export function spaceOf(ctx: EncounterContext, c: EncounterCombatant): number {
  return SPACE[sizeOf(ctx, c) ?? ""] ?? 1;
}

/** Its size, lowercase (`medium`; a monster's first size when it lists two). */
function sizeOf(ctx: EncounterContext, c: EncounterCombatant): string | null | undefined {
  return c.monster !== null
    ? monsterDef(ctx, c).size.split(" ")[0]?.toLowerCase()
    : computePlaySheet(characterRef(ctx, c).build, characterRef(ctx, c).state, ctx.catalog).size;
}

const SIZES = ["tiny", "small", "medium", "large", "huge", "gargantuan"];

/**
 * What `x`'s space is to `mover` (SRD "Moving around Other Creatures"): it can pass through an
 * ally, an Incapacitated creature, a Tiny one or one two sizes larger or smaller; another
 * creature's space is Difficult Terrain unless that creature is Tiny or an ally.
 */
function occupantFor(
  ctx: EncounterContext,
  e: Encounter,
  mover: EncounterCombatant,
  x: EncounterCombatant,
): Occupant {
  const size = sizeOf(ctx, x);
  if (size === "tiny" || alliesOf(e, x.id, mover)) return "pass";
  const gap = Math.abs(
    SIZES.indexOf(size ?? "medium") - SIZES.indexOf(sizeOf(ctx, mover) ?? "medium"),
  );
  if (gap >= 2 || conditionsOf(ctx, x).has("incapacitated")) return "difficult";
  return "block";
}

export { gridDistance };

/** Another creature whose space overlaps `c`'s if it stood at `to`. */
export function spaceTakenBy(
  e: Encounter,
  ctx: EncounterContext,
  c: EncounterCombatant,
  to: GridPoint,
): EncounterCombatant | undefined {
  const size = spaceOf(ctx, c);
  return e.combatants.find(
    (x) =>
      x.id !== c.id &&
      !x.defeated &&
      x.position &&
      gridDistance(to, size, x.position, spaceOf(ctx, x)) === 0,
  );
}

/** The grid as `c` moves on it: walls, blocked and difficult squares, other creatures. */
export function terrainOf(e: Encounter, ctx: EncounterContext, c: EncounterCombatant): Terrain {
  const difficult = new Set(e.map.difficult.map(squareKey));
  for (const z of e.zones) {
    if (z.difficult) for (const sq of zoneArea(e, ctx, z) ?? []) difficult.add(sq);
  }
  const creatures = new Map<string, Occupant>();
  for (const x of e.combatants) {
    if (x.id === c.id || !x.position || x.defeated || outOfFight(ctx, x)) continue;
    const what = occupantFor(ctx, e, c, x);
    const size = spaceOf(ctx, x);
    for (let dx = 0; dx < size; dx++) {
      for (let dy = 0; dy < size; dy++) {
        const k = `${x.position.x + dx},${x.position.y + dy}`;
        // Overlapping creatures: the strictest says.
        if (creatures.get(k) !== "block")
          creatures.set(k, what === "pass" ? (creatures.get(k) ?? what) : what);
      }
    }
  }
  return {
    walls: e.map.walls,
    blocked: new Set(e.map.blocked.map(squareKey)),
    difficult,
    creatures,
  };
}

/**
 * The squares a positioned `c` moves through for a `move` with `to` or `path`, and each step's
 * cost; `EncounterError` when a step can't be taken or `to` can't be reached with the movement
 * left. `to` goes straight when nothing blocks it, else along the cheapest path.
 */
export function planMove(
  e: Encounter,
  ctx: EncounterContext,
  c: EncounterCombatant,
  move: { to?: GridPoint; path?: readonly GridPoint[] },
): { path: GridPoint[]; steps: number[] } {
  const from = c.position ?? fail(`${c.name} has no position: place it first`);
  if (move.to && move.path) fail("Give a square to move to or a path, not both");
  const left = Math.max(0, speedOf(ctx, c, e) + c.extra_movement - c.moved);
  const size = spaceOf(ctx, c);
  const terrain = terrainOf(e, ctx, c);
  const costs = (squares: readonly GridPoint[]): number[] => {
    let at = from;
    return squares.map((square) => {
      const why = stepBlocked(terrain, at, square, size);
      if (why) fail(`${c.name} can't move to ${square.x},${square.y}: ${why}`);
      const cost = stepCost(terrain, at, square, size);
      at = square;
      return cost;
    });
  };
  if (move.path) {
    const path = checkedPath(from, move.path);
    return { path, steps: costs(path) };
  }
  const to = move.to ?? fail("Give a square to move to or a path");
  const taken = spaceTakenBy(e, ctx, c, to);
  if (taken) fail(`${taken.name} is in that space`);
  const straight = straightPath(from, to);
  let at = from;
  const clear = straight.every((square) => {
    const ok = !stepBlocked(terrain, at, square, size);
    at = square;
    return ok;
  });
  if (clear) return { path: straight, steps: costs(straight) };
  // Around the obstacle: the cheapest path (looking a little past the movement left, to say how
  // far it is).
  const found = findPath(terrain, from, to, { size, maxCost: left + 300 });
  if (!found) fail(`${c.name} can't reach ${to.x},${to.y}: something blocks every path`);
  if (found.cost > left) {
    fail(`${c.name} can't reach ${to.x},${to.y} (needs ${found.cost} ft, ${left} left)`);
  }
  return { path: found.path, steps: costs(found.path) };
}

/**
 * An area placed by `c` (rules/areas.ts), after checking that its point is within `range` feet
 * (a Cube "originating from" `c`, with no range, must touch its space): its squares (with a clear
 * line from its point of origin), the positioned creatures in it with their cover from that
 * point, and those it misses for Total Cover.
 */
export function placeArea(
  e: Encounter,
  ctx: EncounterContext,
  c: EncounterCombatant,
  area: SpellArea,
  placement: AreaPlacement,
  range: number | null,
  label: string,
): {
  squares: Set<string>;
  ids: string[];
  cover: Map<string, MapCover>;
  total: string[];
} {
  if (!c.position) fail(`${c.name} has no position: an area needs positions`);
  const origin = { position: c.position, size: spaceOf(ctx, c) };
  const point = placement.point;
  if ((area.shape === "sphere" || area.shape === "cylinder") && point && range !== null) {
    const d = distanceToPoint(origin, point);
    if (d > range) fail(`That point is ${d} feet away: out of ${label}'s range (${range} ft)`);
  }
  if (area.shape === "cube" && point) {
    const d = gridDistance(point, area.size / 5, origin.position, origin.size);
    if (range === null && d !== 5) fail(`${label}'s Cube must start next to ${c.name}`);
    if (range !== null && d > range) fail(`That Cube is ${d} feet away: out of ${label}'s range`);
  }
  let squares: Set<string>;
  try {
    squares = areaSquares(area, origin, placement);
  } catch (error) {
    if (error instanceof RangeError) fail(`${label}: ${error.message}`);
    throw error;
  }
  // Squares with no clear line from the point of origin aren't in it (SRD "Area of Effect").
  const from = areaOriginPoint(area, origin, placement);
  squares = inLineOfEffect(e, squares, from);
  // A Sphere or Cylinder can include its creator; the other shapes start outside it.
  const includesOrigin = area.shape === "sphere" || area.shape === "cylinder";
  const inside = e.combatants
    .filter((x) => !outOfFight(ctx, x) && x.position && (includesOrigin || x.id !== c.id))
    .filter((x) => inArea(squares, { position: x.position as GridPoint, size: spaceOf(ctx, x) }));
  // Cover from the point of origin: Dexterity saves; Total Cover keeps a creature out.
  const cover = new Map<string, MapCover>();
  const ids: string[] = [];
  const total: string[] = [];
  for (const x of inside) {
    const found = mapCover(e, ctx, [from], x, [c.id]);
    if (found.degree === "total") total.push(x.id);
    else {
      ids.push(x.id);
      cover.set(x.id, found);
    }
  }
  return { squares, ids, cover, total };
}

/**
 * A zone's squares (`"x,y"`), or `null` when positions don't place it. Its origin is its point,
 * or for an Emanation its caster's space, or the space at its point (`space` squares wide).
 * Squares the point of origin has no clear line to aren't in it.
 */
export function zoneArea(e: Encounter, ctx: EncounterContext, z: Zone): Set<string> | null {
  let origin: GridSpace | null;
  if (z.area.shape === "emanation" && !z.point) {
    const by = e.combatants.find((x) => x.id === z.by);
    origin = by?.position ? { position: by.position, size: spaceOf(ctx, by) } : null;
  } else origin = z.point ? { position: z.point, size: z.space } : null;
  if (!origin) return null;
  const placement = { point: z.point ?? undefined };
  const squares = areaSquares(z.area, origin, placement);
  return inLineOfEffect(e, squares, areaOriginPoint(z.area, origin, placement));
}

/**
 * An area's point of origin, for lines of effect and cover (flagged): a Sphere's or Cylinder's
 * grid intersection, the center of a Cube, or the center of the space an Emanation, Cone or Line
 * comes from.
 */
export function areaOriginPoint(
  area: SpellArea,
  origin: GridSpace,
  placement: AreaPlacement,
): GridPoint {
  const center = (p: GridPoint, size: number) => ({ x: p.x + size / 2, y: p.y + size / 2 });
  if ((area.shape === "sphere" || area.shape === "cylinder") && placement.point) {
    return placement.point;
  }
  if (area.shape === "cube" && placement.point) return center(placement.point, area.size / 5);
  return center(origin.position, origin.size);
}

/** The squares of an area the point `from` has a clear line to (blocked squares left out). */
export function inLineOfEffect(
  e: Encounter,
  squares: ReadonlySet<string>,
  from: GridPoint,
): Set<string> {
  const { walls, blocked } = e.map;
  if (!walls.length && !blocked.length) return new Set(squares);
  const solid = new Set(blocked.map(squareKey));
  const lines = obstacles(walls, solid);
  return new Set(
    [...squares].filter((k) => {
      if (solid.has(k)) return false;
      const [x, y] = k.split(",").map(Number) as [number, number];
      return lineClear(from, { x: x + 0.5, y: y + 0.5 }, lines);
    }),
  );
}

export interface MapCover {
  readonly degree: CoverDegree;
  /** The creature giving Half Cover, when that's what decided it. */
  readonly by: string | null;
}

/**
 * `t`'s cover from `origins` (an attacker's corners, an area's point of origin), worked out
 * from the map's walls and blocked squares and the creatures in between (not `t`, nor those in
 * `exclude`).
 */
export function mapCover(
  e: Encounter,
  ctx: EncounterContext,
  origins: readonly GridPoint[],
  t: EncounterCombatant,
  exclude: readonly string[] = [],
): MapCover {
  if (!t.position) return { degree: "none", by: null };
  const others = e.combatants.filter(
    (x) =>
      x.id !== t.id && !exclude.includes(x.id) && x.position && !x.defeated && !outOfFight(ctx, x),
  );
  const lines = obstacles(e.map.walls, e.map.blocked.map(squareKey));
  const r = coverDegree(
    origins,
    { position: t.position, size: spaceOf(ctx, t) },
    lines,
    others.map((x) => ({ position: x.position as GridPoint, size: spaceOf(ctx, x) })),
  );
  return { degree: r.degree, by: r.by === null ? null : (others[r.by]?.name ?? null) };
}

/** The longest reach of a combatant's melee attacks, or `null` without one. */
export function meleeReach(
  ctx: EncounterContext,
  e: Encounter,
  c: EncounterCombatant,
): number | null {
  const reaches = encounterCombatant(e, c.id, ctx)
    .attacks.filter((a) => a.kind === "melee")
    .map((a) => a.reach ?? 5);
  return reaches.length ? Math.max(...reaches) : null;
}
