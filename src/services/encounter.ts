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
import type { MonsterDef } from "../models/content";
import {
  type Encounter,
  type EncounterAction,
  type EncounterCombatant,
  EncounterCombatantSchema,
  EncounterSchema,
} from "../models/encounter";
import type { CharacterState, PlayAction } from "../models/state";
import { type Combatant, combatantFromMonster, rollD20 } from "../rules/combatant";
import { takeDamage } from "../rules/damage";
import { roll } from "../rules/dice";
import { mathRng, type Rng } from "../rules/rng";
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
}

export function createEncounter(): Encounter {
  return EncounterSchema.parse({});
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
    const base = combatantFromMonster(def, {
      hp: c.hp ?? def.hit_points,
      temp_hp: c.temp_hp,
      conditions: c.conditions,
    });
    return { ...base, name: c.name };
  }
  const ref = characterRef(ctx, c);
  return { ...combatantFromCharacter(ref.build, ref.state, ctx.catalog), name: c.name };
}

export function applyEncounterAction(
  encounter: Encounter,
  action: EncounterAction,
  ctx: EncounterContext,
): EncounterResult {
  const e = structuredClone(encounter) as Encounter;
  const notes: string[] = [];
  const states: Record<string, CharacterState> = {};
  const rng = ctx.rng ?? mathRng;
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
        combatant({ id, name: action.name ?? numbered, monster: def.id, side: action.side, hp }),
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
          d20 = rollD20({ mode: surprised.has(c.id) ? "disadvantage" : "normal", rng }).d20;
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
      break;
    }
    case "next_turn": {
      if (e.round === 0) fail("The fight hasn't started");
      const next = skipToActive(e, ctx, notes, true);
      notes.push(`Round ${e.round}: ${next.name}'s turn.`);
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
      break;
    }
    case "move": {
      const c = find(action.id);
      onTurn(c, "move");
      if (c.defeated) fail(`${c.name} is defeated`);
      const budget = speedOf(ctx, c) + c.extra_movement;
      if (c.moved + action.feet > budget) {
        fail(`${c.name} can move ${Math.max(0, budget - c.moved)} more feet this turn`);
      }
      c.moved += action.feet;
      break;
    }
    case "dash": {
      const c = find(action.id);
      onTurn(c, "Dash");
      canAct(c);
      if (c.used.action) fail(`${c.name} has already used its action this turn`);
      c.used.action = true;
      c.extra_movement += speedOf(ctx, c);
      notes.push(`${c.name} Dashes: ${speedOf(ctx, c) + c.extra_movement - c.moved} feet left.`);
      break;
    }
    case "effects": {
      const c = find(action.id);
      if (c.monster !== null) {
        for (const a of action.actions) notes.push(...monsterEffect(ctx, c, a));
      } else {
        const ref = characterRef(ctx, c);
        let state = ref.state;
        try {
          for (const a of action.actions) {
            const r = applyAction(ref.build, state, ctx.catalog, a, { rng });
            state = r.state;
            notes.push(...r.notes);
          }
        } catch (error) {
          if (error instanceof PlayError) throw new EncounterError(error.messages);
          throw error;
        }
        states[c.character as string] = state;
      }
      break;
    }
  }
  return { encounter: EncounterSchema.parse(e), states, notes };
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
function speedOf(ctx: EncounterContext, c: EncounterCombatant): number {
  if (c.monster === null) {
    const ref = characterRef(ctx, c);
    return computePlaySheet(ref.build, ref.state, ctx.catalog).speed.total;
  }
  const stopped = [...conditionsOf(ctx, c)].some(
    (id) => lookup(ctx.catalog.conditions, id)?.speed_zero,
  );
  return stopped ? 0 : (monsterDef(ctx, c).speed.walk ?? 0);
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
    if (c.character !== null) {
      const ref = characterRef(ctx, c);
      const play = computePlaySheet(ref.build, ref.state, ctx.catalog).play;
      if (play.dying) notes.push(`${c.name} is at 0 Hit Points: make a Death Saving Throw.`);
    }
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
    default:
      return fail(`A monster can't take the play action '${a.type}'`);
  }
}
