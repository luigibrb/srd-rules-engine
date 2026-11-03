/**
 * What limits a creature's spells and actions on a turn, and what Metamagic does to a spell (SRD
 * 5.2.1 "One Spell with a Spell Slot per Turn", Sorcerer "Metamagic Options", Rogue "Devious
 * Strikes"' Daze). Pure: the functions take plain facts and return the refusals or the changed
 * spell; `applyEncounterAction` applies them.
 */

import type { DamageType, SpellDef } from "../models/content";
import { METAMAGIC_COST, type MetamagicOption } from "../models/encounter";
import type { Message } from "../models/messages";
import { message } from "../rules/messages";

/** Transmuted Spell's types: "Acid, Cold, Fire, Lightning, Poison, Thunder". */
export const TRANSMUTABLE: readonly DamageType[] = [
  "acid",
  "cold",
  "fire",
  "lightning",
  "poison",
  "thunder",
];

/** What a caster has for a Metamagic option. */
export interface MetamagicFacts {
  readonly caster: string;
  /** It has chosen the option (the feature `<option>-spell`). */
  readonly known: boolean;
  /** Sorcery Points left, and their resource's name and key; `null` without the pool. */
  readonly points: { readonly key: string; readonly name: string; readonly left: number } | null;
  /** The Charisma modifier (Careful Spell's count). */
  readonly cha: number;
}

/** A Metamagic option asked for on a cast. */
export interface MetamagicRequest {
  readonly option: MetamagicOption;
  readonly targets?: readonly string[];
  readonly damage_type?: DamageType;
}

export type MetamagicPlan =
  | {
      readonly ok: true;
      /** The spell as the option changes it (Distant's range, Subtle's components, Transmuted). */
      readonly spell: SpellDef;
      /** The damage type picked for the spell, as Transmuted Spell changes it. */
      readonly damage_type: DamageType | undefined;
      readonly cost: number;
      readonly pool: string;
      readonly name: Message;
      /** Not enough Sorcery Points: a refusal a GM can override (nothing is spent then). */
      readonly short: Message | null;
    }
  | { readonly ok: false; readonly reason: Message };

/**
 * Whether a Metamagic option applies to a spell (SRD Sorcerer "Metamagic Options"), and the spell
 * as it changes it. `chosenType` is the damage type picked for a spell that offers several.
 */
export function planMetamagic(
  spell: SpellDef,
  request: MetamagicRequest,
  facts: MetamagicFacts,
  chosenType?: DamageType,
): MetamagicPlan {
  const name = message(`metamagic.${request.option}`);
  const no = (reason: Message): MetamagicPlan => ({ ok: false, reason });
  if (!facts.known || !facts.points)
    return no(message("refusal.no_metamagic", { name: facts.caster, option: name }));
  const cost = METAMAGIC_COST[request.option];
  const short =
    facts.points.left < cost
      ? message("refusal.uses_left_count", { name: facts.points.name, left: facts.points.left })
      : null;
  const m = spell.mechanics;
  const not = (detail: Message) =>
    no(message("refusal.metamagic_spell", { option: name, spell: spell.name, detail }));
  const count = request.targets?.length ?? 0;
  let changed: SpellDef = spell;
  let damage_type: DamageType | undefined;
  switch (request.option) {
    case "careful": {
      // "a spell that forces other creatures to make a saving throw … up to your Charisma
      // modifier (minimum of one creature)"
      if (!m?.save) return not(message("metamagic.needs_save"));
      const most = Math.max(1, facts.cha);
      if (!count || count > most)
        return no(message("refusal.metamagic_count", { option: name, most }));
      break;
    }
    case "heightened":
      // "give one target of the spell Disadvantage on saves against the spell"
      if (!m?.save) return not(message("metamagic.needs_save"));
      if (count !== 1) return no(message("refusal.metamagic_count", { option: name, most: 1 }));
      break;
    case "distant": {
      // "a range of at least 5 feet … double the spell's range … a range of Touch … 30 feet"
      const feet = /^(\d+) feet$/.exec(spell.range)?.[1];
      if (spell.range === "Touch") changed = { ...spell, range: "30 feet" };
      else if (feet && Number(feet) >= 5) changed = { ...spell, range: `${Number(feet) * 2} feet` };
      else return not(message("metamagic.needs_range"));
      break;
    }
    case "extended":
      // "a spell that has a duration of 1 minute or longer"
      if (!/\b(minute|hour|day)s?\b/i.test(spell.duration))
        return not(message("metamagic.needs_duration"));
      break;
    case "quickened":
      break;
    case "subtle": {
      // "without any Verbal, Somatic, or Material components, except Material components that
      // are consumed by the spell or that have a cost specified in the spell"
      const material = /\bM \(([^)]*)\)/.exec(spell.components)?.[1] ?? "";
      const kept = /consume|GP/.test(material);
      changed = { ...spell, components: kept ? `M (${material})` : "" };
      break;
    }
    case "transmuted": {
      // "change that damage type to one of the other listed types"
      const to = request.damage_type;
      if (!to || !TRANSMUTABLE.includes(to))
        return no(message("refusal.metamagic_type", { option: name }));
      const types = [
        ...(m?.damage ?? []).map((d) => d.type),
        ...(m?.damage_types ?? []),
        ...(m?.follow_up?.damage ?? []).map((d) => d.type),
      ];
      if (!m || !types.some((t) => TRANSMUTABLE.includes(t)))
        return not(message("metamagic.needs_type"));
      const swap = <T extends { type: DamageType }>(x: T): T =>
        TRANSMUTABLE.includes(x.type) ? { ...x, type: to } : x;
      changed = {
        ...spell,
        mechanics: {
          ...m,
          damage: m.damage.map(swap),
          damage_types: m.damage_types.map((t) => (TRANSMUTABLE.includes(t) ? to : t)),
          upcast: m.upcast && { ...m.upcast, damage: m.upcast.damage.map(swap) },
          follow_up: m.follow_up && {
            ...m.follow_up,
            damage: m.follow_up.damage.map(swap),
            upcast: m.follow_up.upcast.map(swap),
          },
        },
      };
      if (chosenType && TRANSMUTABLE.includes(chosenType)) damage_type = to;
      break;
    }
    case "twinned":
      // "a spell … that can be cast with a higher-level spell slot to target an additional
      // creature … increase the spell's effective level by 1"
      if (spell.level === 0 || !m?.upcast?.targets) return not(message("metamagic.needs_targets"));
      break;
  }
  return { ok: true, spell: changed, damage_type, cost, pool: facts.points.key, name, short };
}

/** The spells a creature cast on the current turn (its own or another's). */
export interface CastThisTurn {
  readonly slot: boolean;
  readonly leveled: boolean;
  readonly quickened: boolean;
}

/**
 * Why a cast is refused by what the creature already cast this turn: "On a turn, you can expend
 * only one spell slot to cast a spell", and Quickened Spell ("You can't modify a spell in this
 * way if you've already cast a level 1+ spell on the current turn, nor can you cast a level 1+
 * spell on this turn after modifying a spell in this way").
 */
export function castTurnRefusals(
  name: string,
  turn: CastThisTurn,
  cast: { readonly level: number; readonly slotted: boolean; readonly quickened: boolean },
): Message[] {
  const out: Message[] = [];
  if (cast.quickened && turn.leveled)
    out.push(message("refusal.quickened_after_leveled", { name }));
  if (cast.level > 0 && turn.quickened)
    out.push(message("refusal.leveled_after_quickened", { name }));
  if (cast.slotted && turn.slot) out.push(message("refusal.one_slot_per_turn", { name }));
  return out;
}

/** What a cast adds to the creature's spells this turn. */
export function afterCast(
  turn: CastThisTurn,
  cast: { readonly level: number; readonly slotted: boolean; readonly quickened: boolean },
): CastThisTurn {
  return {
    slot: turn.slot || cast.slotted,
    leveled: turn.leveled || cast.level > 0,
    quickened: turn.quickened || cast.quickened,
  };
}

/** How many of moving, its action and its Bonus Action a creature used this turn (Daze). */
export function turnUses(c: {
  readonly used: { readonly action: boolean; readonly bonus_action: boolean };
  readonly moved: number;
}): number {
  return Number(c.used.action) + Number(c.used.bonus_action) + Number(c.moved > 0);
}

/**
 * Daze (Devious Strikes): "on its next turn, it can do only one of the following: move or take
 * an action or a Bonus Action". An action that made a dazed creature use a second one is refused.
 */
export function dazeRefusal(
  name: string,
  dazed: boolean,
  before: number,
  after: number,
): Message | null {
  return dazed && after > 1 && after > before ? message("refusal.dazed", { name }) : null;
}
