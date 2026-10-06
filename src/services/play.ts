/**
 * Play: the character at the table. A `CharacterState` records what changes during play (HP,
 * spent slots and uses, conditions, inventory, today's prepared spells…); the build stays the
 * character's characteristics. Every change is an action applied by `applyAction`, which checks
 * it against the rules and the build, like the builder's setters do for the build.
 *
 * Actions are plain JSON (`{ type: "damage", amount: 7, damage_type: "fire" }`), so they can be
 * sent over HTTP, logged, replayed, or synced between players.
 */

import { type Catalog, lookup } from "../content/catalog";
import type { CharacterBuild } from "../models/build";
import type { ConditionDef, MagicItemDef } from "../models/content";
import {
  type CharacterState,
  CURRENCIES,
  type ItemInstance,
  MAX_ATTUNED,
  type PlayAction,
  parseState,
} from "../models/state";
import { type Resolution, resolve } from "../rules/build-resolution";
import { choiceIssues } from "../rules/build-validation";
import { type Combatant, conditionRolls } from "../rules/combatant";
import { type Defenses, rollDamage, takeDamage } from "../rules/damage";
import { roll } from "../rules/dice";
import { mathRng, type Rng } from "../rules/rng";
import {
  type CarriedItem,
  computeSheet,
  type DerivedSheet,
  type PlayContext,
} from "../rules/sheet";
import { setChoice } from "./builder";

export class PlayError extends Error {
  override name = "PlayError";
  readonly messages: readonly string[];

  constructor(messages: readonly string[]) {
    super(messages.join("; "));
    this.messages = messages;
  }
}

export interface PlayResult {
  readonly state: CharacterState;
  /** What happened, for the player to read ("Concentration: Constitution save, DC 10"). */
  readonly notes: readonly string[];
}

// --- the sheet in play --------------------------------------------------------------------

export interface PlaySheet extends DerivedSheet {
  readonly play: {
    readonly hp: { readonly current: number; readonly max: number; readonly temp: number };
    readonly dying: boolean;
    readonly stable: boolean;
    readonly dead: boolean;
    readonly death_saves: { readonly successes: number; readonly failures: number };
    readonly hit_dice: readonly { die: number; total: number; spent: number }[];
    readonly exhaustion: number;
    /** Active conditions, including implied ones (Unconscious → Incapacitated, Prone). */
    readonly conditions: readonly {
      id: string;
      name: string;
      description: string;
      implied: boolean;
    }[];
    readonly concentration: string | null;
    readonly heroic_inspiration: boolean;
    readonly spell_slots: readonly { level: number; total: number; spent: number }[];
    readonly pact_magic: {
      readonly slots: number;
      readonly slot_level: number;
      readonly spent: number;
    } | null;
    readonly uses: readonly {
      key: string;
      name: string;
      max: number;
      spent: number;
      recharge: "short" | "long";
    }[];
    readonly inventory: readonly {
      id: string;
      item: string;
      name: string;
      category: string;
      qty: number;
      equipped: boolean;
      attuned: boolean;
      requires_attunement: boolean;
      active: boolean;
      charges: number | null;
      charges_spent: number;
      weight: number | null;
    }[];
    readonly attuned: number;
    readonly currency: CharacterState["currency"];
    /** Known weights only (gear without a listed weight isn't counted). */
    readonly carried_weight: number;
    readonly carrying_capacity: number;
    /** Choice keys whose picks come from the state (today's prepared spells…). */
    readonly rest_choices: readonly string[];
  };
}

/** The build as played today: rest-changeable choices use the state's picks. */
export function playBuild(
  build: CharacterBuild,
  state: CharacterState,
  catalog: Catalog,
): CharacterBuild {
  const keys = restChoiceKeys(resolve(build, catalog));
  const overrides = Object.fromEntries(Object.entries(state.choices).filter(([k]) => keys.has(k)));
  if (!Object.keys(overrides).length) return build;
  return { ...build, choices: { ...build.choices, ...overrides } };
}

function restChoiceKeys(res: Resolution): Set<string> {
  return new Set(res.choices.filter((c) => c.definition.rest_change !== null).map((c) => c.key));
}

/** Resolve inventory entries against the catalog: names, bases, whether their magic works. */
export function carriedItems(state: CharacterState, catalog: Catalog): CarriedItem[] {
  return state.inventory.map((i) => {
    const magic = lookup(catalog.magic_items, i.item) ?? null;
    const base = magic ? (i.base ?? onlyBase(magic)) : i.item;
    const active = magic
      ? (magic.active_when === "carried" || i.equipped) && (!magic.attunement || i.attuned)
      : false;
    return {
      id: i.id,
      name: itemName(catalog, i, magic, base),
      base,
      magic,
      qty: i.qty,
      equipped: i.equipped,
      active,
      attuned: i.attuned,
      variant: i.variant,
    };
  });
}

function onlyBase(magic: MagicItemDef): string | null {
  return magic.base?.ids?.length === 1 ? (magic.base.ids[0] ?? null) : null;
}

function itemName(
  catalog: Catalog,
  i: ItemInstance,
  magic: MagicItemDef | null,
  base: string | null,
): string {
  if (!magic) return mundaneName(catalog, i.item) ?? i.item;
  const baseName = base ? mundaneName(catalog, base) : null;
  // "Weapon, +1" on a Longsword reads "Longsword, +1".
  let name = magic.name;
  const generic = /^(Weapon|Armor|Shield|Ammunition)(, \+\d)$/.exec(magic.name);
  if (generic && baseName) name = `${baseName}${generic[2]}`;
  else if (baseName && magic.base && !magic.base.ids) name = `${magic.name} (${baseName})`;
  const variant = magic.variants.find((v) => v.id === i.variant);
  return variant ? `${name} (${variant.name})` : name;
}

function mundaneName(catalog: Catalog, id: string): string | undefined {
  return (
    lookup(catalog.weapons, id)?.name ??
    lookup(catalog.armor, id)?.name ??
    lookup(catalog.gear, id)?.name ??
    lookup(catalog.tools, id)?.name
  );
}

/** Active conditions with the ones they imply. */
function activeConditions(state: CharacterState, catalog: Catalog): Map<string, boolean> {
  const out = new Map<string, boolean>(); // id → implied?
  const add = (id: string, implied: boolean) => {
    if (out.has(id)) return;
    out.set(id, implied);
    for (const next of lookup(catalog.conditions, id)?.implies ?? []) add(next, true);
  };
  for (const id of state.conditions) add(id, false);
  if (state.exhaustion > 0) out.set("exhaustion", false);
  return out;
}

export function computePlaySheet(
  build: CharacterBuild,
  state: CharacterState,
  catalog: Catalog,
): PlaySheet {
  const played = playBuild(build, state, catalog);
  const res = resolve(played, catalog);
  const items = carriedItems(state, catalog);
  const conditions = activeConditions(state, catalog);
  const context: PlayContext = {
    items,
    conditions: new Set(conditions.keys()),
    exhaustion: state.exhaustion,
    active: new Set(state.active),
  };
  const sheet = computeSheet(played, catalog, res, context);
  const max = sheet.max_hp?.total ?? 0;
  const current = Math.min(state.hp.current ?? max, max);
  const weightOf = (id: string | null) => {
    const w = id
      ? (lookup(catalog.weapons, id)?.weight ?? lookup(catalog.armor, id)?.weight)
      : undefined;
    const n = w ? Number.parseFloat(w) : Number.NaN;
    return Number.isFinite(n) ? n : null;
  };
  const inventory = state.inventory.map((i, n) => {
    const carried = items[n] as CarriedItem;
    const magic = carried.magic;
    return {
      id: i.id,
      item: i.item,
      name: carried.name,
      category: magic ? magic.category : itemCategory(catalog, i.item),
      qty: i.qty,
      equipped: i.equipped,
      attuned: i.attuned,
      requires_attunement: magic?.attunement ?? false,
      active: carried.active,
      charges: magic?.charges ?? null,
      charges_spent: i.charges_spent,
      weight: weightOf(carried.base),
    };
  });
  return {
    ...sheet,
    play: {
      hp: { current, max, temp: state.hp.temp },
      dying: current === 0 && !state.stable && !state.dead,
      stable: state.stable,
      dead: state.dead,
      death_saves: { ...state.death_saves },
      hit_dice: Object.entries(sheet.hit_dice).map(([die, total]) => ({
        die: Number(die),
        total,
        spent: state.hit_dice_spent[die] ?? 0,
      })),
      exhaustion: state.exhaustion,
      conditions: [...conditions].map(([id, implied]) => {
        const def = lookup(catalog.conditions, id) as ConditionDef | undefined;
        return { id, name: def?.name ?? id, description: def?.description ?? "", implied };
      }),
      concentration: state.concentration,
      heroic_inspiration: state.heroic_inspiration,
      spell_slots: sheet.spell_slots.map((total, i) => ({
        level: i + 1,
        total,
        spent: state.spell_slots_spent[i] ?? 0,
      })),
      pact_magic: sheet.pact_magic ? { ...sheet.pact_magic, spent: state.pact_slots_spent } : null,
      uses: sheet.limited_uses.map((u) => ({
        key: u.key,
        name: u.name,
        max: u.max,
        spent: state.uses_spent[u.key] ?? 0,
        recharge: u.recharge,
      })),
      inventory,
      attuned: state.inventory.filter((i) => i.attuned).length,
      currency: { ...state.currency },
      carried_weight: inventory.reduce((sum, i) => sum + (i.weight ?? 0) * i.qty, 0),
      carrying_capacity: sheet.scores.str * 15,
      rest_choices: Object.keys(state.choices).filter((k) => restChoiceKeys(res).has(k)),
    },
  };
}

/** Damage defenses from the sheet and the active conditions (Petrified: Resistance to all). */
function characterDefenses(
  sheet: DerivedSheet,
  conditions: ReadonlySet<string>,
): Required<Defenses> {
  const resistances = conditions.has("petrified")
    ? [...sheet.resistances, "all"]
    : [...sheet.resistances];
  return { resistances, vulnerabilities: [], immunities: [] };
}

/**
 * The character as a combatant: AC, HP, saves, attack lines and defenses from its play sheet.
 * Resolve attacks with `makeAttack`, then apply the damage to the target's state with the play
 * action `{ type: "damage", instances, critical }`.
 */
export function combatantFromCharacter(
  build: CharacterBuild,
  state: CharacterState,
  catalog: Catalog,
): Combatant {
  const sheet = computePlaySheet(build, state, catalog);
  const conditions = sheet.play.conditions.map((c) => c.id);
  const saves = Object.fromEntries(
    Object.entries(sheet.saving_throws).map(([a, line]) => [a, line.modifier]),
  ) as Combatant["saving_throws"];
  return {
    name: build.name || "Character",
    level: sheet.level,
    armor_class: sheet.armor_class.total,
    hp: sheet.play.hp.current,
    temp_hp: sheet.play.hp.temp,
    max_hp: sheet.play.hp.max,
    proficiency_bonus: sheet.proficiency_bonus,
    modifiers: sheet.modifiers,
    saving_throws: saves,
    ability_checks: sheet.ability_checks,
    skills: Object.fromEntries(sheet.skills.map((line) => [line.skill, line.modifier])),
    defenses: characterDefenses(sheet, new Set(conditions)),
    conditions,
    attacks: sheet.attacks,
    critical_hit_on: sheet.critical_hit_on,
    attacks_per_action: sheet.attacks_per_action,
    advantages: sheet.advantages.map((a) => a.target),
    no_spells: sheet.toggles.some((t) => t.active && t.no_spells),
    condition_immunities: [],
    save_actions: [],
    condition_rolls: conditionRolls(conditions, catalog.conditions),
    legendary_actions: [],
    legendary_resistance: 0,
    size: sheet.size,
    rules: sheet.rules,
    proficient_skills: sheet.skills.flatMap((line) => (line.proficient_from ? [line.skill] : [])),
    spell_damage: sheet.spell_damage,
    inspiration_die: null,
    // Indomitable (a named rule): the Fighter level, while a use is left.
    indomitable: sheet.rules.includes("indomitable") ? indomitableBonus(sheet) : null,
    spellcasting: sheet.spellcasting.flatMap((line) =>
      line.ability === null || line.save_dc === null || line.attack_bonus === null
        ? []
        : [
            {
              source: line.source,
              list: line.list,
              ability: line.ability,
              save_dc: line.save_dc,
              attack_bonus: line.attack_bonus,
              modifier: sheet.modifiers[line.ability],
            },
          ],
    ),
  };
}

function itemCategory(catalog: Catalog, id: string): string {
  if (lookup(catalog.weapons, id)) return "weapon";
  if (lookup(catalog.armor, id))
    return lookup(catalog.armor, id)?.category === "shield" ? "shield" : "armor";
  if (lookup(catalog.tools, id)) return "tool";
  return "gear";
}

// --- creating, checking and repairing a state ---------------------------------------------

/**
 * A fresh state for a build: full HP, nothing spent, and the starting equipment in the
 * inventory (wearing the armor and Shield the sheet picks) with the starting gold.
 */
export function createState(build: CharacterBuild, catalog: Catalog): CharacterState {
  const sheet = computeSheet(build, catalog);
  const worn = new Set(sheet.armor_class.parts.map((part) => part.source));
  const inventory: ItemInstance[] = [];
  let n = 1;
  for (const [item, qty] of Object.entries(sheet.equipment)) {
    const armor = lookup(catalog.armor, item);
    const equipped =
      !!armor &&
      (armor.category === "shield" ? worn.has(armor.name) : armor.name === sheet.armor_worn);
    inventory.push({
      id: `i${n++}`,
      item,
      base: null,
      variant: null,
      qty,
      equipped,
      attuned: false,
      charges_spent: 0,
      notes: "",
    });
  }
  return parseState({ inventory, currency: { gp: sheet.gp }, next_item: n });
}

export interface StateIssue {
  readonly severity: "error" | "warning";
  readonly message: string;
}

/** Everything in a state that doesn't fit the build or the rules. */
export function validateState(
  build: CharacterBuild,
  state: CharacterState,
  catalog: Catalog,
): StateIssue[] {
  const issues: StateIssue[] = [];
  const error = (message: string) => issues.push({ severity: "error", message });
  const res = resolve(build, catalog);
  const restKeys = restChoiceKeys(res);
  const played = playBuild(build, state, catalog);
  const playedRes = resolve(played, catalog);
  for (const key of Object.keys(state.choices)) {
    if (!restKeys.has(key)) {
      error(`'${key}' isn't a choice you can change after a rest`);
      continue;
    }
    const choice = playedRes.choice(key);
    if (choice) {
      for (const i of choiceIssues(playedRes, choice)) if (i.severity === "error") error(i.message);
    }
  }
  const sheet = computePlaySheet(build, state, catalog);
  const p = sheet.play;
  if ((state.hp.current ?? 0) > p.hp.max)
    error(`Hit Points ${state.hp.current} are above the maximum ${p.hp.max}`);
  for (const d of p.hit_dice)
    if (d.spent > d.total) error(`${d.spent} d${d.die} Hit Dice spent, only ${d.total}`);
  for (const [die, spent] of Object.entries(state.hit_dice_spent)) {
    if (spent && !p.hit_dice.some((d) => String(d.die) === die))
      error(`No d${die} Hit Dice to spend`);
  }
  state.spell_slots_spent.forEach((spent, i) => {
    const total = sheet.spell_slots[i] ?? 0;
    if (spent > total) error(`${spent} level ${i + 1} slots spent, only ${total}`);
  });
  if (state.pact_slots_spent > (sheet.pact_magic?.slots ?? 0))
    error("More Pact Magic slots spent than you have");
  for (const [key, spent] of Object.entries(state.uses_spent)) {
    const use = p.uses.find((u) => u.key === key);
    if (!use) error(`No limited use '${key}'`);
    else if (spent > use.max) error(`${use.name}: ${spent} used, only ${use.max}`);
  }
  for (const id of state.conditions)
    if (!lookup(catalog.conditions, id)) error(`Unknown condition '${id}'`);
  const items = carriedItems(state, catalog);
  for (const [n, i] of state.inventory.entries()) {
    const carried = items[n] as CarriedItem;
    const magic = carried.magic;
    if (!magic && !mundaneName(catalog, i.item)) error(`Unknown item '${i.item}'`);
    if (magic) {
      if (magic.base && !carried.base)
        error(`${magic.name}: choose which ${magic.base.kind} it is`);
      if (magic.base && carried.base && !allowedBases(catalog, magic).includes(carried.base)) {
        error(`${magic.name} can't be a ${mundaneName(catalog, carried.base) ?? carried.base}`);
      }
      if (magic.variants.length && !magic.variants.some((v) => v.id === i.variant)) {
        error(`${magic.name}: choose its kind (${magic.variants.map((v) => v.name).join(", ")})`);
      }
      if (magic.charges !== null && i.charges_spent > magic.charges)
        error(`${carried.name}: too many charges spent`);
    }
    if (i.attuned && !magic?.attunement) error(`${carried.name} doesn't need Attunement`);
    if (i.attuned && magic) {
      const reason = attunementBlocker(res, magic);
      if (reason) error(`${carried.name}: ${reason}`);
    }
  }
  if (state.inventory.filter((i) => i.attuned).length > MAX_ATTUNED) {
    error(`Attuned to more than ${MAX_ATTUNED} magic items`);
  }
  for (const kind of ["armor", "shield"] as const) {
    const worn = items.filter((i) => i.equipped && wornKind(catalog, i.base) === kind);
    if (worn.length > 1)
      error(`Wearing more than one ${kind === "armor" ? "suit of armor" : "Shield"}`);
  }
  return issues;
}

/**
 * Make a state fit its build again after the build changed (a level removed, an override edit):
 * clamp HP, slots, uses and Hit Dice, drop picks that are no longer legal, and unattune what
 * can't stay attuned. Returns notes for what changed.
 */
export function reconcileState(
  build: CharacterBuild,
  state: CharacterState,
  catalog: Catalog,
): PlayResult {
  const notes: string[] = [];
  let s = structuredClone(state) as CharacterState;
  const res = resolve(build, catalog);
  const restKeys = restChoiceKeys(res);
  for (const key of Object.keys(s.choices)) {
    let drop = !restKeys.has(key);
    if (!drop) {
      const trial = resolve(playBuild(build, s, catalog), catalog);
      const choice = trial.choice(key);
      drop = !choice || choiceIssues(trial, choice).some((i) => i.severity === "error");
    }
    if (drop) {
      delete s.choices[key];
      notes.push(`${res.choice(key)?.label ?? key}: back to the build's picks.`);
    }
  }
  s.conditions = s.conditions.filter((id) => lookup(catalog.conditions, id));
  // Toggles end when the feature is gone, or when armor or a condition blocks them (Rage:
  // Heavy armor, Incapacitated).
  const before = computePlaySheet(build, s, catalog);
  s.active = s.active.filter((key) => {
    const toggle = before.toggles.find((t) => t.key === key);
    if (toggle && !toggle.blocked) return true;
    notes.push(
      toggle
        ? `${toggle.name} ends (${(toggle.blocked ?? "").replaceAll("_", " ")}).`
        : `'${key}' ends: the feature is gone.`,
    );
    return false;
  });
  if (s.concentration && before.toggles.some((t) => t.no_spells && s.active.includes(t.key))) {
    notes.push(`Concentration on ${s.concentration} ends.`);
    s.concentration = null;
  }
  const sheet = computePlaySheet(build, s, catalog);
  const p = sheet.play;
  if (s.hp.current !== null && s.hp.current > p.hp.max) s.hp.current = null;
  const dice: Record<string, number> = {};
  for (const d of p.hit_dice) if (d.spent) dice[d.die] = Math.min(d.spent, d.total);
  s.hit_dice_spent = dice;
  s.spell_slots_spent = sheet.spell_slots.map((total, i) =>
    Math.min(s.spell_slots_spent[i] ?? 0, total),
  );
  while (s.spell_slots_spent.length && s.spell_slots_spent.at(-1) === 0) s.spell_slots_spent.pop();
  s.pact_slots_spent = Math.min(s.pact_slots_spent, sheet.pact_magic?.slots ?? 0);
  const uses: Record<string, number> = {};
  for (const u of p.uses)
    if (s.uses_spent[u.key]) uses[u.key] = Math.min(s.uses_spent[u.key] ?? 0, u.max);
  s.uses_spent = uses;
  let attuned = 0;
  for (const i of s.inventory) {
    const magic = lookup(catalog.magic_items, i.item);
    const blocked =
      i.attuned &&
      (!magic?.attunement || (magic && attunementBlocker(res, magic)) || attuned >= MAX_ATTUNED);
    if (blocked) {
      i.attuned = false;
      notes.push(`No longer attuned to ${magic?.name ?? i.item}.`);
    } else if (i.attuned) attuned++;
  }
  s = parseState(s);
  return { state: s, notes };
}

/** Which mundane items a magic item can be made from. */
export function allowedBases(catalog: Catalog, magic: MagicItemDef): string[] {
  const base = magic.base;
  if (!base) return [];
  const fits = (id: string, category: string) =>
    (!base.ids || base.ids.includes(id)) &&
    (!base.categories || base.categories.includes(category)) &&
    !base.except.includes(id);
  switch (base.kind) {
    case "weapon":
      return Object.values(catalog.weapons)
        .filter((w) => fits(w.id, w.category) && (!base.weapon_kind || w.kind === base.weapon_kind))
        .map((w) => w.id);
    case "armor":
      return Object.values(catalog.armor)
        .filter((a) => a.category !== "shield" && fits(a.id, a.category))
        .map((a) => a.id);
    case "shield":
      return Object.values(catalog.armor)
        .filter((a) => a.category === "shield")
        .map((a) => a.id);
    case "ammunition":
      return Object.keys(catalog.gear);
  }
}

function wornKind(catalog: Catalog, base: string | null): "armor" | "shield" | null {
  const armor = lookup(catalog.armor, base);
  if (!armor) return null;
  return armor.category === "shield" ? "shield" : "armor";
}

/** Why this character can't attune to an item, or `null`. */
function attunementBlocker(res: Resolution, magic: MagicItemDef): string | null {
  if (magic.attunement_classes.length) {
    const classes = res.classLevels();
    if (!magic.attunement_classes.some((c) => classes.has(c))) {
      return `Attunement requires ${magic.attunement_by}`;
    }
  }
  if (
    magic.attunement_spellcaster &&
    !res.sources.some((s) => s.grants.spellcasting?.progression)
  ) {
    return "Attunement requires a spellcaster";
  }
  return null;
}

// --- actions ------------------------------------------------------------------------------

/**
 * Apply one action. Throws `PlayError` (with readable messages) if the action isn't possible;
 * otherwise returns the new state (the old one is untouched) and notes.
 */
export function applyAction(
  build: CharacterBuild,
  state: CharacterState,
  catalog: Catalog,
  action: PlayAction,
  { rng = mathRng }: { rng?: Rng } = {},
): PlayResult {
  const sheet = computePlaySheet(build, state, catalog);
  const p = sheet.play;
  const s = structuredClone(state) as CharacterState;
  const notes: string[] = [];
  const fail = (message: string): never => {
    throw new PlayError([message]);
  };
  const needItem = (id: string) =>
    s.inventory.find((i) => i.id === id) ?? fail(`No item '${id}' in the inventory`);
  const conditionsNow = new Set(p.conditions.map((c) => c.id));
  const dropConcentration = (why: string) => {
    if (s.concentration) notes.push(`Concentration on ${s.concentration} ends (${why}).`);
    s.concentration = null;
  };
  const current = p.hp.current;

  switch (action.type) {
    case "damage": {
      if (s.dead) fail("The character is dead");
      if ((action.amount === undefined) === (action.instances === undefined)) {
        fail("Give either an amount or a list of damage instances");
      }
      const hit = takeDamage(
        { hp: current, temp: s.hp.temp, max: p.hp.max },
        action.instances ?? [{ amount: action.amount ?? 0, type: action.damage_type ?? null }],
        characterDefenses(sheet, conditionsNow),
        { critical: action.critical },
      );
      notes.push(...hit.notes);
      s.hp.temp = hit.temp;
      if (current > 0) s.hp.current = hit.hp;
      if (hit.death_save_failures) {
        s.stable = false;
        s.death_saves.failures = Math.min(3, s.death_saves.failures + hit.death_save_failures);
        if (s.death_saves.failures >= 3) {
          s.dead = true;
          notes.push("Three failures: the character dies.");
        }
      }
      if (hit.died) s.dead = true;
      if (hit.dropped_to_zero) {
        if (!s.conditions.includes("unconscious")) s.conditions.push("unconscious");
        s.death_saves = { successes: 0, failures: 0 };
        s.stable = false;
        notes.push("Down to 0 Hit Points: Unconscious, making Death Saving Throws.");
      }
      if (current > 0 && hit.hp === 0) dropConcentration("down to 0 HP");
      if (current > 0 && hit.concentration_dc !== null && s.concentration) {
        notes.push(
          `Concentration on ${s.concentration}: Constitution saving throw, DC ${hit.concentration_dc}.`,
        );
      }
      break;
    }
    case "heal": {
      if (s.dead) fail("The character is dead");
      const amount = Math.max(0, Math.floor(action.amount));
      s.hp.current = Math.min(p.hp.max, current + amount);
      if (s.hp.current >= p.hp.max) s.hp.current = null;
      if (current === 0 && amount > 0) regainConsciousness(s, notes);
      break;
    }
    case "set_hp": {
      if (action.current < 0 || action.current > p.hp.max)
        fail(`Hit Points go from 0 to ${p.hp.max}`);
      s.hp.current = action.current >= p.hp.max ? null : action.current;
      if (current === 0 && action.current > 0) regainConsciousness(s, notes);
      break;
    }
    case "set_temp_hp": {
      const amount = Math.max(0, Math.floor(action.amount));
      if (action.replace || amount > s.hp.temp) s.hp.temp = amount;
      else notes.push(`Temporary Hit Points don't stack: keeping ${s.hp.temp}.`);
      break;
    }
    case "death_save": {
      if (current !== 0 || s.stable || s.dead)
        fail("Death Saving Throws are made at 0 Hit Points, while dying");
      const d20 = action.roll ?? rng.int(1, 20);
      if (d20 === 20) {
        s.hp.current = 1;
        regainConsciousness(s, notes);
        notes.push("Natural 20: you regain 1 Hit Point.");
        break;
      }
      if (d20 === 1) s.death_saves.failures = Math.min(3, s.death_saves.failures + 2);
      else if (d20 >= 10) s.death_saves.successes += 1;
      else s.death_saves.failures += 1;
      notes.push(
        `Death Saving Throw: ${d20} (${s.death_saves.successes} successes, ${s.death_saves.failures} failures).`,
      );
      if (s.death_saves.failures >= 3) {
        s.dead = true;
        notes.push("Three failures: the character dies.");
      } else if (s.death_saves.successes >= 3) {
        s.stable = true;
        s.death_saves = { successes: 0, failures: 0 };
        notes.push("Three successes: Stable.");
      }
      break;
    }
    case "stabilize": {
      if (current !== 0 || s.dead) fail("Only a dying character can be stabilized");
      s.stable = true;
      s.death_saves = { successes: 0, failures: 0 };
      break;
    }
    case "short_rest": {
      if (s.dead || current < 1) fail("You need at least 1 Hit Point to start a Short Rest");
      endToggles(s, sheet, notes, "rest");
      let hp = current;
      for (const spend of action.hit_dice ?? []) {
        const pool = p.hit_dice.find((d) => d.die === spend.die);
        const spent = s.hit_dice_spent[String(spend.die)] ?? 0;
        if (!pool || spent >= pool.total) fail(`No d${spend.die} Hit Point Dice left`);
        const d = spend.roll ?? rng.int(1, spend.die);
        if (d < 1 || d > spend.die) fail(`A d${spend.die} roll is between 1 and ${spend.die}`);
        const gained = Math.max(1, d + sheet.modifiers.con);
        hp = Math.min(p.hp.max, hp + gained);
        s.hit_dice_spent[String(spend.die)] = spent + 1;
        notes.push(`Hit Point Die d${spend.die}: ${d} + Con → ${gained} HP.`);
      }
      s.hp.current = hp >= p.hp.max ? null : hp;
      for (const u of sheet.limited_uses) {
        const spent = s.uses_spent[u.key] ?? 0;
        if (!spent) continue;
        if (u.recharge === "short") delete s.uses_spent[u.key];
        else if (u.short_rest_regain)
          s.uses_spent[u.key] = Math.max(0, spent - u.short_rest_regain);
      }
      s.pact_slots_spent = 0;
      notes.push("Short Rest: Pact Magic slots and short-rest features recharged.");
      break;
    }
    case "long_rest": {
      if (s.dead || current < 1) fail("You need at least 1 Hit Point to start a Long Rest");
      endToggles(s, sheet, notes, "rest");
      s.hp = { current: null, temp: 0 };
      s.hit_dice_spent = {};
      s.death_saves = { successes: 0, failures: 0 };
      s.stable = false;
      s.spell_slots_spent = [];
      s.pact_slots_spent = 0;
      s.uses_spent = {};
      if (s.exhaustion > 0) {
        s.exhaustion -= 1;
        notes.push(`Exhaustion reduced to ${s.exhaustion}.`);
      }
      const played = resolve(playBuild(build, state, catalog), catalog);
      if (played.sources.some((src) => src.grants.on_long_rest.includes("heroic_inspiration"))) {
        s.heroic_inspiration = true;
        notes.push("Heroic Inspiration gained.");
      }
      notes.push("Long Rest: all Hit Points, Hit Point Dice, spell slots and features recovered.");
      break;
    }
    case "spend_slot": {
      const slot = p.spell_slots.find((x) => x.level === action.level);
      if (!slot || slot.spent >= slot.total) fail(`No level ${action.level} spell slots left`);
      s.spell_slots_spent[action.level - 1] = (s.spell_slots_spent[action.level - 1] ?? 0) + 1;
      for (let i = 0; i < s.spell_slots_spent.length; i++) s.spell_slots_spent[i] ??= 0;
      break;
    }
    case "restore_slot": {
      if (!(s.spell_slots_spent[action.level - 1] ?? 0))
        fail(`No spent level ${action.level} slot to restore`);
      s.spell_slots_spent[action.level - 1] = (s.spell_slots_spent[action.level - 1] ?? 1) - 1;
      break;
    }
    case "spend_pact_slot": {
      if (!p.pact_magic || p.pact_magic.spent >= p.pact_magic.slots)
        fail("No Pact Magic slots left");
      s.pact_slots_spent += 1;
      break;
    }
    case "restore_pact_slot": {
      if (!s.pact_slots_spent) fail("No spent Pact Magic slot to restore");
      s.pact_slots_spent -= 1;
      break;
    }
    case "use": {
      const use =
        p.uses.find((u) => u.key === action.key) ?? fail(`No limited use '${action.key}'`);
      const amount = action.amount ?? 1;
      if (use.spent + amount > use.max) fail(`${use.name}: ${use.max - use.spent} left`);
      s.uses_spent[use.key] = use.spent + amount;
      break;
    }
    case "use_feature": {
      const feature =
        sheet.actions.find((a) => a.key === action.key) ?? fail(`No feature '${action.key}'`);
      if (feature.pool && action.amount === undefined) fail(`${feature.name}: how much? (amount)`);
      const amount = feature.pool ? (action.amount as number) : feature.cost;
      if (feature.uses) {
        const use = p.uses.find((u) => u.key === feature.uses) ?? fail(`${feature.name}: no uses`);
        if (use.spent + amount > use.max) fail(`${feature.name}: ${use.max - use.spent} left`);
        s.uses_spent[use.key] = use.spent + amount;
      }
      if (feature.heal && feature.target === "self") {
        if (s.dead) fail("The character is dead");
        const healed = feature.heal.pooled
          ? amount
          : rollDamage([{ dice: feature.heal.dice, bonus: feature.heal.bonus, type: "healing" }], {
              rng,
            }).total;
        const after = Math.min(p.hp.max, current + healed);
        s.hp.current = after >= p.hp.max ? null : after;
        if (current === 0 && healed > 0) regainConsciousness(s, notes);
        const capped = after - current < healed ? ` (rolled ${healed})` : "";
        notes.push(`${feature.name}: regains ${after - current} Hit Points${capped}.`);
      }
      break;
    }
    case "restore_use": {
      const use =
        p.uses.find((u) => u.key === action.key) ?? fail(`No limited use '${action.key}'`);
      s.uses_spent[use.key] = Math.max(0, use.spent - (action.amount ?? 1));
      break;
    }
    case "add_condition": {
      const def =
        lookup(catalog.conditions, action.condition) ??
        fail(`Unknown condition '${action.condition}'`);
      if (def.levels) fail("Use set_exhaustion for Exhaustion levels");
      if (!s.conditions.includes(def.id)) s.conditions.push(def.id);
      const incapacitated = def.id === "incapacitated" || def.implies.includes("incapacitated");
      if (incapacitated) dropConcentration(def.name);
      break;
    }
    case "remove_condition": {
      if (!s.conditions.includes(action.condition)) fail(`Not ${action.condition}`);
      s.conditions = s.conditions.filter((c) => c !== action.condition);
      break;
    }
    case "set_exhaustion": {
      if (action.level < 0 || action.level > 6) fail("Exhaustion levels go from 0 to 6");
      s.exhaustion = action.level;
      if (action.level === 6) {
        s.dead = true;
        notes.push("Exhaustion 6: the character dies.");
      }
      break;
    }
    case "set_concentration": {
      if (action.spell && conditionsNow.has("incapacitated"))
        fail("You can't concentrate while Incapacitated");
      const blocking = sheet.toggles.find((t) => t.active && t.no_spells);
      if (action.spell && blocking) fail(`You can't concentrate during ${blocking.name}`);
      if (action.spell && s.concentration) notes.push(`Concentration on ${s.concentration} ends.`);
      s.concentration = action.spell;
      break;
    }
    case "activate": {
      const toggle =
        sheet.toggles.find((t) => t.key === action.key) ?? fail(`No feature '${action.key}'`);
      if (toggle.active) fail(`${toggle.name} is already active`);
      if (toggle.blocked)
        fail(`${toggle.name} can't start: ${toggle.blocked.replaceAll("_", " ")}`);
      if (toggle.uses) {
        const use = p.uses.find((u) => u.key === toggle.uses);
        if (!use || use.spent >= use.max) fail(`No uses of ${toggle.name} left`);
        s.uses_spent[toggle.uses] = (use?.spent ?? 0) + 1;
      }
      s.active.push(toggle.key);
      if (toggle.no_spells) dropConcentration(toggle.name);
      break;
    }
    case "deactivate": {
      if (!s.active.includes(action.key)) fail(`'${action.key}' isn't active`);
      s.active = s.active.filter((k) => k !== action.key);
      break;
    }
    case "set_inspiration": {
      s.heroic_inspiration = action.value;
      break;
    }
    case "set_choice": {
      const res = resolve(build, catalog);
      const choice = res.choice(action.key);
      if (!choice?.definition.rest_change)
        fail(`'${action.key}' isn't a choice you can change after a rest`);
      // Check the picks the way the builder would, against the build as played today.
      const played = playBuild(build, state, catalog);
      try {
        setChoice(played, catalog, action.key, action.values);
      } catch (error) {
        if (error instanceof Error && "messages" in error) {
          throw new PlayError((error as { messages: string[] }).messages);
        }
        throw error;
      }
      s.choices[action.key] = [...action.values];
      break;
    }
    case "reset_choice": {
      delete s.choices[action.key];
      break;
    }
    case "add_item": {
      const qty = Math.max(1, Math.floor(action.qty ?? 1));
      const magic = lookup(catalog.magic_items, action.item);
      if (!magic && !mundaneName(catalog, action.item)) fail(`Unknown item '${action.item}'`);
      let base: string | null = null;
      if (magic?.base) {
        const allowed = allowedBases(catalog, magic);
        base = action.base ?? (allowed.length === 1 ? (allowed[0] as string) : null);
        if (!base) fail(`${magic.name}: say which ${magic.base.kind} it is (base)`);
        if (!allowed.includes(base as string))
          fail(`${magic.name} can't be a ${mundaneName(catalog, base as string) ?? base}`);
      }
      const variant = magic?.variants.length ? (action.variant ?? null) : null;
      if (magic?.variants.length && !magic.variants.some((v) => v.id === variant)) {
        fail(`${magic.name}: choose its kind (${magic.variants.map((v) => v.id).join(", ")})`);
      }
      const same = !magic && s.inventory.find((i) => i.item === action.item && !i.equipped);
      if (same) same.qty += qty;
      else {
        s.inventory.push({
          id: `i${s.next_item++}`,
          item: action.item,
          base,
          variant,
          qty,
          equipped: false,
          attuned: false,
          charges_spent: 0,
          notes: "",
        });
      }
      break;
    }
    case "remove_item": {
      const item = needItem(action.id);
      const qty = action.qty ?? item.qty;
      if (qty >= item.qty) s.inventory = s.inventory.filter((i) => i.id !== action.id);
      else item.qty -= qty;
      break;
    }
    case "equip": {
      const item = needItem(action.id);
      item.equipped = action.equipped;
      const kind = wornKind(
        catalog,
        carriedItems(s, catalog).find((c) => c.id === item.id)?.base ?? null,
      );
      if (action.equipped && kind) {
        // One suit of armor and one Shield at a time: take the other one off.
        const carried = carriedItems(s, catalog);
        for (const other of s.inventory) {
          const otherKind = wornKind(catalog, carried.find((c) => c.id === other.id)?.base ?? null);
          if (other.id !== item.id && other.equipped && otherKind === kind) {
            other.equipped = false;
            notes.push(`Took off ${carried.find((c) => c.id === other.id)?.name}.`);
          }
        }
      }
      break;
    }
    case "attune": {
      const item = needItem(action.id);
      const magic = lookup(catalog.magic_items, item.item);
      if (action.attuned) {
        if (!magic?.attunement) fail(`${magic?.name ?? item.item} doesn't require Attunement`);
        const reason = attunementBlocker(resolve(build, catalog), magic as MagicItemDef);
        if (reason) fail(reason);
        const count = s.inventory.filter((i) => i.attuned && i.id !== item.id).length;
        if (count >= MAX_ATTUNED) fail(`You can be attuned to at most ${MAX_ATTUNED} magic items`);
        notes.push("Attuning takes a Short Rest focused on the item.");
      }
      item.attuned = action.attuned;
      break;
    }
    case "use_item": {
      const item = needItem(action.id);
      const magic = lookup(catalog.magic_items, item.item);
      if (magic?.charges != null) {
        if (item.charges_spent >= magic.charges) fail(`${magic.name} has no charges left`);
        item.charges_spent += 1;
        break;
      }
      if (!magic?.consumable) fail(`${magic?.name ?? item.item} isn't used up`);
      const def = magic as MagicItemDef;
      if (def.heal) {
        const healed = action.roll ?? roll(def.heal, rng).total;
        if (s.dead) fail("The character is dead");
        s.hp.current = Math.min(p.hp.max, current + healed);
        if (s.hp.current >= p.hp.max) s.hp.current = null;
        if (current === 0 && healed > 0) regainConsciousness(s, notes);
        notes.push(`${def.name}: ${healed} Hit Points.`);
      }
      if (item.qty > 1) item.qty -= 1;
      else s.inventory = s.inventory.filter((i) => i.id !== item.id);
      break;
    }
    case "set_charges": {
      const item = needItem(action.id);
      const magic = lookup(catalog.magic_items, item.item);
      if (magic?.charges == null) fail("This item has no charges");
      if (action.spent < 0 || action.spent > (magic?.charges ?? 0))
        fail(`Charges go from 0 to ${magic?.charges}`);
      item.charges_spent = action.spent;
      break;
    }
    case "adjust_currency": {
      for (const c of CURRENCIES) {
        const next = s.currency[c] + (action.changes[c] ?? 0);
        if (next < 0) fail(`Not enough ${c.toUpperCase()} (${s.currency[c]})`);
        s.currency[c] = next;
      }
      break;
    }
    default:
      fail(`Unknown action '${(action as { type: string }).type}'`);
  }
  const repaired = reconcileState(build, parseState(s), catalog);
  return { state: repaired.state, notes: [...notes, ...repaired.notes] };
}

/** Every active toggle ends (a rest lasts longer than Rage's 10 minutes). */
function endToggles(s: CharacterState, sheet: PlaySheet, notes: string[], why: string): void {
  for (const key of s.active) {
    const name = sheet.toggles.find((t) => t.key === key)?.name ?? key;
    notes.push(`${name} ends (${why}).`);
  }
  s.active = [];
}

function regainConsciousness(s: CharacterState, notes: string[]): void {
  s.death_saves = { successes: 0, failures: 0 };
  s.stable = false;
  if (s.conditions.includes("unconscious")) {
    s.conditions = s.conditions.filter((c) => c !== "unconscious");
    if (!s.conditions.includes("prone")) s.conditions.push("prone");
    notes.push("Conscious again (still Prone).");
  }
}

/** Indomitable's reroll bonus (the Fighter level) while a use is left, else `null`. */
function indomitableBonus(sheet: PlaySheet): number | null {
  const use = sheet.play.uses.find((u) => u.key.endsWith(":indomitable"));
  if (!use || use.spent >= use.max) return null;
  return sheet.classes.find((c) => c.class_id === "fighter")?.level ?? null;
}
