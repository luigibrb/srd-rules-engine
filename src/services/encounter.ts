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
import { ABILITY_NAMES, type MonsterDef, type SpellDef } from "../models/content";
import {
  type EffectEnd,
  type Encounter,
  type EncounterAction,
  type EncounterCombatant,
  EncounterCombatantSchema,
  type EncounterEffect,
  EncounterSchema,
} from "../models/encounter";
import type { CharacterState, PlayAction } from "../models/state";
import {
  castSpell,
  type SaveActionResult,
  type SpellCastResult,
  useSaveAction,
} from "../rules/casting";
import {
  type AttackResult,
  type CheckResult,
  type Combatant,
  combatantFromMonster,
  type ModeReason,
  makeAttack,
  monsterSpells,
  type RollMode,
  resolveMode,
  rollAbilityCheck,
  rollD20,
  rollSavingThrow,
  type SaveResult,
} from "../rules/combatant";
import { rollDamage, takeDamage } from "../rules/damage";
import { roll } from "../rules/dice";
import { mathRng, type Rng } from "../rules/rng";
import type { AttackLine } from "../rules/sheet";
import { applyAction, combatantFromCharacter, computePlaySheet, PlayError } from "./play";

export class EncounterError extends Error {
  override name = "EncounterError";
  readonly messages: readonly string[];
  constructor(messages: readonly string[]) {
    super(messages.join("; "));
    this.messages = messages;
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
}

/** A new encounter. `auto_death_saves: false` leaves Death Saving Throws to the players. */
export function createEncounter(options: { auto_death_saves?: boolean } = {}): Encounter {
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
      name: c.name,
      inspiration_die: c.inspiration?.die ?? null,
      attacks: base.attacks.filter((a) => ready(a.name)),
      save_actions: base.save_actions.filter((a) => ready(a.name)),
    });
  }
  const ref = characterRef(ctx, c);
  return withDodge(ctx, encounter, c, {
    ...combatantFromCharacter(ref.build, ref.state, ctx.catalog),
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
): EncounterResult {
  const e = structuredClone(encounter) as Encounter;
  const notes: string[] = [];
  const states: Record<string, CharacterState> = {};
  // A working copy of the characters: several can change in one action (attacker and target).
  const chars: Record<string, CharacterRef> = { ...(outer.characters ?? {}) };
  const ctx: EncounterContext = { ...outer, characters: chars };
  const rng = ctx.rng ?? mathRng;
  let result: EncounterResult["result"] = null;
  const play = (c: EncounterCombatant, a: PlayAction): void => {
    const ref = characterRef(ctx, c);
    let r: ReturnType<typeof applyAction>;
    try {
      r = applyAction(ref.build, ref.state, ctx.catalog, a, { rng });
    } catch (error) {
      if (error instanceof PlayError) throw new EncounterError(error.messages);
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
        const save = rollSavingThrow(encounterCombatant(e, c.id, ctx), "con", dc, { rng });
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
  };
  /** The end of `c`'s turn: effects, and toggles that weren't extended (Rage). */
  const endTurn = (c: EncounterCombatant): void => {
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
  /** The name of `t`'s feature that halves an attack's damage as its reaction, if it can use it. */
  const defenderFeature = (t: EncounterCombatant, key: string): string => {
    if (t.character === null) fail(`${t.name} has no class features`);
    const ref = characterRef(ctx, t);
    const f = computePlaySheet(ref.build, ref.state, ctx.catalog).actions.find(
      (a) => (a.key === key || a.name === key) && a.halves_attack_damage,
    );
    if (!f) fail(`${t.name} has no feature '${key}' that halves an attack's damage`);
    if (t.used.reaction) fail(`${t.name} has already used its reaction`);
    if (conditionsOf(ctx, t).has("incapacitated")) fail(`${t.name} is Incapacitated`);
    return f.name;
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
      target_feature?: string;
    },
  ): AttackResult => {
    const attacker = encounterCombatant(e, c.id, ctx);
    const line = attacker.attacks.find((a) => a.name === attackName);
    const riders = options.riders ?? [];
    const onceIds = riders.flatMap((r) => {
      const rider = line?.riders.find((x) => x.id === r.rider || x.name === r.rider);
      return rider?.once_per_turn ? [rider.id] : [];
    });
    const again = onceIds.find((id) => c.riders_used.includes(id));
    if (again) fail(`${c.name} has already used ${again} this turn`);
    const target = encounterCombatant(e, t.id, ctx);
    // A feature the target uses as its reaction if hit (Uncanny Dodge): checked before rolling.
    const dodge = options.target_feature ? defenderFeature(t, options.target_feature) : null;
    // Help: Advantage on the next attack roll by one of the helper's allies against the target.
    const help = e.helps.find(
      (h) => h.on === t.id && h.skill === null && h.by !== c.id && alliesOf(e, h.by, c),
    );
    const modes: ModeReason[] = help
      ? [{ mode: "advantage", reason: `${find(help.by).name} Helps against ${t.name}` }]
      : [];
    // Vex: Advantage on c's next attack roll against t; Sap: Disadvantage on c's next attack roll.
    const vex = e.masteries.find((m) => m.mastery === "vex" && m.by === c.id && m.on === t.id);
    const sap = e.masteries.find((m) => m.mastery === "sap" && m.on === c.id);
    if (vex) modes.push({ mode: "advantage", reason: `Vex (${c.name}'s last hit on ${t.name})` });
    if (sap) modes.push({ mode: "disadvantage", reason: `Sap (${find(sap.by).name}'s hit)` });
    let hit: AttackResult;
    try {
      // The attacker's conditions caused by this target (Grappled by it), from the effects.
      const against_source_of = e.effects
        .filter((x) => x.target === c.id && x.source === t.id)
        .map((x) => x.condition);
      hit = makeAttack(attacker, attackName, target, {
        rng,
        mode: options.mode,
        two_handed: options.two_handed,
        riders,
        ally_adjacent: options.ally_adjacent,
        within_5ft: options.within_5ft,
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
      if (dodge) {
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
      const save = rollSavingThrow(encounterCombatant(e, t.id, ctx), "con", dc, { rng });
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
  ): SaveActionResult => {
    const targets = targetIds.map(find);
    let r: SaveActionResult;
    try {
      const combatants = targets.map((t) => encounterCombatant(e, t.id, ctx));
      r = useSaveAction(user, name, combatants, { rng });
    } catch (error) {
      if (error instanceof RangeError) fail(error.message);
      throw error;
    }
    c.extended = true; // forcing a saving throw extends Rage
    for (const hit of r.targets) {
      const t = targets[hit.target] as EncounterCombatant;
      const outcome = hit.save?.success ? "succeeds" : "fails";
      notes.push(`${t.name}: ${outcome} (${hit.save ? saveText(hit.save) : ""}).`);
      spendLegendaryResistance(t, hit.save);
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
    options: { slot_level?: number; pact?: boolean; mode?: RollMode; spellcasting?: string },
  ): SpellCastResult => {
    const targets = targetIds.map(find);
    let r: SpellCastResult;
    try {
      r = castSpell(
        encounterCombatant(e, c.id, ctx),
        spell,
        targets.map((t) => encounterCombatant(e, t.id, ctx)),
        { ...options, rng },
      );
    } catch (error) {
      if (error instanceof RangeError) fail(error.message);
      throw error;
    }
    c.extended = true;
    const level =
      r.slot_level !== null && r.slot_level > spell.level ? ` at level ${r.slot_level}` : "";
    notes.push(`${c.name} casts ${spell.name}${level}.`, ...r.notes);
    applyTo(c, r.caster_actions);
    for (const hit of r.targets) {
      const t = targets[hit.target] as EncounterCombatant;
      useInspiration(c, hit.attack?.inspiration);
      spendLegendaryResistance(t, hit.save);
      applyTo(t, hit.actions);
    }
    // A Concentration spell's conditions last while the caster concentrates, up to its duration.
    if (spell.concentration) {
      const rounds = durationRounds(spell);
      for (const hit of r.targets) {
        const t = targets[hit.target] as EncounterCombatant;
        addEffects(t, hit.conditions, {
          source: c.id,
          label: spell.name,
          concentration: true,
          ends: rounds ? { at: "start", of: c.id, count: rounds, skip_current: false } : null,
        });
      }
    }
    return r;
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
        combatant({ id, name, character: action.character, side: action.side ?? "party" }),
      );
      notes.push(`${name} joins.`);
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
      const budget = speedOf(ctx, c, e) + c.extra_movement;
      if (c.moved + action.feet > budget) {
        fail(`${c.name} can move ${Math.max(0, budget - c.moved)} more feet this turn`);
      }
      c.moved += action.feet;
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
      } else if (c.side && c.side === t.side) fail(`${t.name} is on ${c.name}'s side`);
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
      spendAttack(c, action.reaction);
      c.extended = true; // forcing a saving throw extends Rage
      const dc = 8 + user.modifiers.str + user.proficiency_bonus;
      // The target chooses Strength or Dexterity: by default, its better bonus.
      const ability =
        action.save ?? (target.saving_throws.dex > target.saving_throws.str ? "dex" : "str");
      const save = rollSavingThrow(target, ability, dc, { rng });
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
      const grapples = e.effects.filter(
        (x) => x.target === c.id && x.condition === "grappled" && x.escape_dc !== null,
      );
      const grapple = action.effect
        ? (grapples.find((x) => x.id === action.effect) ??
          fail(`${action.effect} isn't a grapple on ${c.name}`))
        : grapples.length === 1
          ? (grapples[0] as EncounterEffect)
          : grapples.length
            ? fail(`Choose the grapple to escape: ${grapples.map((x) => x.id).join(", ")}`)
            : fail(`${c.name} has no grapple with an escape DC`);
      takeAction(c, "escape");
      const me = encounterCombatant(e, c.id, ctx);
      const bonus = (skill: "athletics" | "acrobatics") =>
        me.skills[skill] ?? me.ability_checks[skill === "athletics" ? "str" : "dex"];
      const skill =
        action.skill ?? (bonus("acrobatics") > bonus("athletics") ? "acrobatics" : "athletics");
      const check = rollAbilityCheck(me, { skill }, grapple.escape_dc, {
        rng,
        modes: helpOnCheck(c, skill),
      });
      result = check;
      useInspiration(c, check.inspiration);
      const why = check.reasons.length ? `; ${check.reasons.join("; ")}` : "";
      const outcome = check.success ? "escapes" : "stays Grappled";
      notes.push(
        `${c.name} tries to escape (${skill} ${check.total} vs DC ${grapple.escape_dc}${why}): ${outcome}.`,
      );
      if (check.success) endEffect(grapple, "escaped");
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
        mode: action.mode,
        modes: helpOnCheck(c, action.skill ?? null),
      });
      result = check;
      useInspiration(c, check.inspiration);
      const label = check.skill ?? check.ability;
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
      result = saveEffectOn(c, user, action.ability, action.targets);
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
        result = saveEffectOn(c, user, line.uses, action.targets ?? []);
      } else if (def.legendary_actions.find((a) => a.name === line.name)?.casts) {
        // "uses Spellcasting to cast Fear": the spell, at its listed level, through this action.
        const cast = monsterSpells(def).find(
          (x) => x.section === "legendary_actions" && x.action === line.name,
        ) as ReturnType<typeof monsterSpells>[number];
        const spell =
          lookup(ctx.catalog.spells, cast.spell) ?? fail(`Unknown spell '${cast.spell}'`);
        const targets = action.targets ?? (action.target ? [action.target] : []);
        result = castBy(c, spell, targets, {
          slot_level: spell.level === 0 ? undefined : (cast.level ?? spell.level),
          mode: action.mode,
          spellcasting: line.name,
        });
      } else if (line.save) {
        result = saveEffectOn(
          c,
          { ...user, save_actions: [line.save] },
          line.name,
          action.targets ?? [],
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
        fail(`${f.name} is used when an attack hits: give it as the attack's \`target_feature\``);
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
      result = castBy(c, spell, action.targets ?? [], {
        slot_level,
        pact: action.pact,
        mode: action.mode,
        spellcasting,
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

function monsterDef(ctx: EncounterContext, c: EncounterCombatant): MonsterDef {
  return lookup(ctx.catalog.monsters, c.monster) ?? fail(`Unknown monster '${c.monster}'`);
}

function characterRef(ctx: EncounterContext, c: EncounterCombatant): CharacterRef {
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
function conditionsOf(ctx: EncounterContext, c: EncounterCombatant): Set<string> {
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
function speedOf(ctx: EncounterContext, c: EncounterCombatant, e: Encounter): number {
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
function outOfFight(ctx: EncounterContext, c: EncounterCombatant): boolean {
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
      const notes = [...result.notes];
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
function saveText(save: SaveResult): string {
  if (save.automatic_failure) return `fails automatically: ${save.automatic_failure}`;
  const mode = save.roll.mode === "normal" ? "" : `, ${save.roll.mode}`;
  return `${save.total} vs DC ${save.dc}${mode}`;
}

/** The action economy a spell's casting time uses. */
function castingEconomy(spell: SpellDef): "action" | "bonus_action" | "reaction" {
  if (/^Action/i.test(spell.casting_time)) return "action";
  if (/^Bonus Action/i.test(spell.casting_time)) return "bonus_action";
  if (/^Reaction/i.test(spell.casting_time)) return "reaction";
  return fail(`${spell.name} takes ${spell.casting_time} to cast: not in combat`);
}

/** "Concentration, up to 1 minute" → 10 rounds; `null` when it isn't counted in rounds. */
function durationRounds(spell: SpellDef): number | null {
  const m = /up to (\d+) (round|minute|hour)s?/i.exec(spell.duration);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "round" ? n : m[2] === "minute" ? n * 10 : n * 600;
}

/** Whether `c` is an ally of combatant `id`: on its side (combatants without a side are all allies). */
function alliesOf(e: Encounter, id: string, c: EncounterCombatant): boolean {
  const other = e.combatants.find((x) => x.id === id);
  return !!other && other.side === c.side;
}

/** Proficient in a skill: a character's sheet, or a skill a monster's stat block lists. */
function proficientIn(ctx: EncounterContext, c: EncounterCombatant, skill: string): boolean {
  if (c.monster !== null) return Object.hasOwn(monsterDef(ctx, c).skills, skill);
  const ref = characterRef(ctx, c);
  const sheet = computePlaySheet(ref.build, ref.state, ctx.catalog);
  return sheet.skills.some((line) => line.skill === skill && line.proficient_from !== null);
}

/** A monster action's uses per day ("(1/Day)" in its name), or `null`. */
function dailyUses(ctx: EncounterContext, c: EncounterCombatant, name: string): number | null {
  const def = monsterDef(ctx, c);
  const all = [...def.actions, ...def.bonus_actions, ...def.reactions];
  return all.find((a) => a.name === name)?.per_day ?? null;
}
