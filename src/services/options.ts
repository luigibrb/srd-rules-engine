/**
 * What a combatant can do now: every attack, spell, feature, monster ability and standard action
 * as an encounter action ready to send, with its cost, candidate targets and, when the engine
 * would refuse it, the reason. Legality comes from `checkAction`, a dry run of
 * `applyEncounterAction` with fixed dice, so the options and the engine never disagree.
 */

import { lookup } from "../content/catalog";
import type { SpellDef } from "../models/content";
import type { Encounter, EncounterAction, EncounterCombatant } from "../models/encounter";
import type {
  ActionCheck,
  CombatantOptions,
  OptionCost,
  OptionEntry,
  TargetSpec,
} from "../models/options";
import { monsterSpells } from "../rules/combatant";
import { formatDamage } from "../rules/damage";
import type { Rng } from "../rules/rng";
import type { AttackLine } from "../rules/sheet";
import {
  alliesOf,
  applyEncounterAction,
  castingEconomy,
  characterRef,
  conditionsOf,
  currentCombatant,
  type EncounterContext,
  EncounterError,
  encounterCombatant,
  feetApart,
  monsterDef,
  outOfFight,
  speedOf,
  spellRangeFeet,
  spellTargetRange,
} from "./encounter";
import { computePlaySheet } from "./play";

/** Dice that always land in the middle: a dry run checks legality, not outcomes. */
const middle: Rng = { int: (min, max) => Math.floor((min + max) / 2) };

/**
 * Whether the engine would take `action` now: a dry run of `applyEncounterAction` with fixed
 * dice, nothing returned or kept. An action that stops for a decision counts as taken. The dice
 * don't tell whether an attack would hit: only whether it's allowed.
 */
export function checkAction(
  encounter: Encounter,
  action: EncounterAction,
  ctx: EncounterContext,
): ActionCheck {
  try {
    applyEncounterAction(encounter, action, { ...ctx, rng: middle });
    return { ok: true, reasons: [] };
  } catch (error) {
    if (error instanceof EncounterError) return { ok: false, reasons: [...error.messages] };
    throw error;
  }
}

export interface OptionsSettings {
  /** Dry-run every option for `available` and `reason` (default true); `false` lists them only. */
  readonly check?: boolean;
}

/** Everything combatant `id` can do now (see `CombatantOptions`). */
export function combatantOptions(
  encounter: Encounter,
  id: string,
  ctx: EncounterContext,
  { check = true }: OptionsSettings = {},
): CombatantOptions {
  const e = encounter;
  const c =
    e.combatants.find((x) => x.id === id) ??
    (() => {
      throw new EncounterError([`No combatant '${id}' in the encounter`]);
    })();
  const view = encounterCombatant(e, id, ctx);
  const turn = e.round > 0 && currentCombatant(e)?.id === c.id;
  const movement = Math.max(0, speedOf(ctx, c, e) + c.extra_movement - c.moved);
  const legendaryMax = c.monster !== null ? legendaryUses(monsterDef(ctx, c), c.in_lair) : 0;

  /** An option, judged by a dry run unless `why` already says why not. */
  const entry = (
    action: EncounterAction,
    label: string,
    cost: OptionCost,
    targets: TargetSpec | null,
    extra: Partial<OptionEntry> = {},
    why: string | null = null,
  ): OptionEntry => {
    let reason = why;
    if (reason === null && check) {
      // No candidate: judge it against the nearest creature, for the engine's reason (out of reach).
      const fallback = candidates(null)[0];
      const probe =
        "target" in action && action.target === "" && fallback
          ? ({ ...action, target: fallback } as EncounterAction)
          : action;
      if ("target" in probe && probe.target === "") reason = "No creature to target";
      else {
        const result = checkAction(e, probe, ctx);
        reason = result.ok ? null : result.reasons.join("; ");
      }
    }
    // Allowed, but there's no one in range to aim it at.
    if (reason === null && targets?.kind === "creature" && !targets.ids.length) {
      reason =
        targets.range === null ? "No creature to target" : `No creature within ${targets.range} ft`;
    }
    return {
      action,
      label,
      cost,
      available: reason === null,
      reason,
      targets,
      slot_levels: [],
      pact_slot: null,
      uses: null,
      note: null,
      ...extra,
    };
  };

  /** Creatures it could aim at: enemies first, then nearest first; within `range` with positions. */
  const candidates = (
    range: number | null,
    { self = false, near }: { self?: boolean; near?: EncounterCombatant } = {},
  ): string[] => {
    const from = near ?? c;
    const rows = e.combatants
      .filter((x) => (self || x.id !== c.id) && !x.defeated && !outOfFight(ctx, x))
      .map((x, i) => ({ x, i, d: x.id === c.id ? 0 : feetApart(ctx, from, x) }))
      .filter(({ d }) => range === null || d === null || d <= range);
    const rank = (x: EncounterCombatant) => (x.id === c.id ? 2 : alliesOf(e, x.id, c) ? 1 : 0);
    rows.sort(
      (a, b) =>
        rank(a.x) - rank(b.x) ||
        (a.d ?? Number.POSITIVE_INFINITY) - (b.d ?? Number.POSITIVE_INFINITY) ||
        a.i - b.i,
    );
    return rows.map(({ x }) => x.id);
  };
  const creature = (range: number | null, ids: string[], count: number | null = 1): TargetSpec => ({
    kind: "creature",
    count,
    range,
    ids,
    area: null,
  });

  // --- attacks ---------------------------------------------------------------------------------
  const attacks: OptionEntry[] = [];
  const seen = new Set<string>();
  for (const line of view.attacks) {
    if (seen.has(line.name)) continue;
    seen.add(line.name);
    const base = { type: "attack", id: c.id, attack: line.name } as const;
    const label = attackLabel(line);
    const reach = line.kind === "melee" ? (line.reach ?? 5) : (line.range?.long ?? null);
    const ids = candidates(reach);
    const first = ids[0] ?? "";
    attacks.push(entry({ ...base, target: first }, label, "attack", creature(reach, ids)));
    if (line.kind === "melee" && line.properties.includes("thrown") && line.range) {
      const far = candidates(line.range.long);
      attacks.push(
        entry(
          { ...base, target: far[0] ?? "", thrown: true },
          `${label} (thrown, ${line.range.normal}/${line.range.long} ft)`,
          "attack",
          creature(line.range.long, far),
        ),
      );
    }
    if (line.kind === "melee" && !turn) {
      attacks.push(
        entry(
          { ...base, target: first, opportunity: true },
          `${label} (Opportunity Attack)`,
          "reaction",
          creature(reach, ids),
        ),
      );
    }
    if (!turn) continue;
    if (line.properties.includes("light") && c.light_attacks.length) {
      const nick = line.mastery === "Nick" && !c.nick_used;
      attacks.push(
        entry(
          { ...base, target: first, light_extra: true },
          `${label} (Light extra attack)`,
          nick ? "attack" : "bonus_action",
          creature(reach, ids),
        ),
      );
    }
    if (c.cleave?.attack === line.name) {
      const hit = e.combatants.find((x) => x.id === c.cleave?.target);
      const near = hit ? candidates(5, { near: hit }).filter((x) => x !== hit.id) : [];
      const inReach = new Set(ids);
      const cleaved = near.filter((x) => inReach.has(x));
      attacks.push(
        entry(
          { ...base, target: cleaved[0] ?? "", cleave: true },
          `${label} (Cleave)`,
          "free",
          creature(reach, cleaved),
        ),
      );
    }
    if (c.granted_attacks?.attack === line.name && c.granted_attacks.count > 0) {
      attacks.push(
        entry(
          { ...base, target: first, granted: true },
          `${label} (granted)`,
          "free",
          creature(reach, ids),
          {
            uses: { left: c.granted_attacks.count, max: c.granted_attacks.count },
          },
        ),
      );
    }
  }

  // --- spells ----------------------------------------------------------------------------------
  const spells: OptionEntry[] = [];
  const concentrating =
    c.monster !== null ? c.concentration : characterRef(ctx, c).state.concentration;
  const spellNote = (spell: SpellDef) =>
    spell.concentration && concentrating
      ? `Casting it ends Concentration on ${concentrating}`
      : null;
  const spellTargets = (spell: SpellDef): TargetSpec => {
    const m = spell.mechanics;
    if (m?.area) {
      return { kind: "area", count: null, range: spellRangeFeet(spell), ids: [], area: m.area };
    }
    if (spell.range.startsWith("Self")) {
      return { kind: "self", count: null, range: null, ids: [c.id], area: null };
    }
    const range = spellTargetRange(spell);
    const count = m?.targets ?? m?.projectiles?.count ?? (m?.attack || m?.save ? 1 : null);
    return creature(range, candidates(range, { self: true }), count);
  };
  /** The cast's targets for the template: the first candidate, or none (an area, the caster). */
  const spellAim = (t: TargetSpec): string[] =>
    t.kind === "creature" && t.ids[0] ? [t.ids[0]] : [];
  const spellCost = (spell: SpellDef): OptionCost => {
    try {
      return castingEconomy(spell);
    } catch {
      return "action";
    }
  };
  if (c.character !== null) {
    const ref = characterRef(ctx, c);
    const sheet = computePlaySheet(ref.build, ref.state, ctx.catalog);
    const play = sheet.play;
    for (const known of sheet.spells) {
      const spell = lookup(ctx.catalog.spells, known.id);
      if (!spell) continue;
      const cantrip = spell.level === 0;
      const slot_levels = cantrip
        ? []
        : play.spell_slots
            .filter((s) => s.level >= spell.level && s.spent < s.total)
            .map((s) => s.level);
      const pact = play.pact_magic;
      const pact_slot =
        !cantrip && pact && pact.slot_level >= spell.level && pact.spent < pact.slots
          ? pact.slot_level
          : null;
      const targets = spellTargets(spell);
      const slot = cantrip
        ? {}
        : slot_levels[0] !== undefined
          ? { slot_level: slot_levels[0] }
          : pact_slot !== null
            ? { slot_level: pact_slot, pact: true }
            : { slot_level: spell.level };
      spells.push(
        entry(
          { type: "cast", id: c.id, spell: spell.id, targets: spellAim(targets), ...slot },
          spellLabel(spell),
          spellCost(spell),
          targets,
          { slot_levels, pact_slot, note: spellNote(spell) },
        ),
      );
    }
  } else {
    const def = monsterDef(ctx, c);
    for (const line of monsterSpells(def)) {
      if (line.section === "legendary_actions") continue;
      const spell = lookup(ctx.catalog.spells, line.spell);
      if (!spell) continue;
      const fixed = spell.level === 0 ? null : (line.level ?? spell.level);
      const targets = spellTargets(spell);
      const limits = [
        line.per_day === null
          ? null
          : {
              left: line.per_day - (c.daily_used[`${line.action}#${line.spell}`] ?? 0),
              max: line.per_day,
            },
        line.action_per_day === null
          ? null
          : {
              left: line.action_per_day - (c.daily_used[line.action] ?? 0),
              max: line.action_per_day,
            },
      ].filter((x) => x !== null);
      const uses = limits.sort((a, b) => a.left - b.left)[0] ?? null;
      const economy =
        line.section === "bonus_actions"
          ? "bonus_action"
          : line.section === "reactions"
            ? "reaction"
            : "action";
      const via = line.action === "Spellcasting" ? "" : ` via ${line.action}`;
      spells.push(
        entry(
          {
            type: "cast",
            id: c.id,
            spell: spell.id,
            via: line.action,
            targets: spellAim(targets),
            ...(fixed === null ? {} : { slot_level: fixed }),
          },
          `${spellLabel(spell, fixed)}${via}`,
          economy,
          targets,
          { slot_levels: fixed === null ? [] : [fixed], uses, note: spellNote(spell) },
        ),
      );
    }
  }

  // --- features --------------------------------------------------------------------------------
  const features: OptionEntry[] = [];
  if (c.character !== null) {
    const ref = characterRef(ctx, c);
    const sheet = computePlaySheet(ref.build, ref.state, ctx.catalog);
    for (const f of sheet.actions) {
      const use = sheet.play.uses.find((u) => u.key === f.uses);
      const uses = use ? { left: use.max - use.spent, max: use.max } : null;
      const cost: OptionCost = f.economy;
      let targets: TargetSpec | null = null;
      let target: string | undefined;
      if (f.after_hit) {
        const hit = candidates(null).filter((x) => c.hits.includes(x));
        targets = creature(null, hit);
        target = hit[0] ?? "";
      } else if (f.target === "other") {
        targets = creature(null, candidates(null));
        target = targets.ids[0] ?? "";
      } else if (f.target === "creature") {
        targets = creature(null, candidates(null, { self: true }));
      } else targets = { kind: "self", count: null, range: null, ids: [c.id], area: null };
      const action: EncounterAction = {
        type: "feature",
        id: c.id,
        feature: f.key,
        ...(target !== undefined ? { target } : {}),
        ...(f.pool ? { amount: 1 } : {}),
      };
      const made = entry(action, f.name, cost, targets, { uses });
      // "hasn't hit X this turn" said of its placeholder target: no hit at all.
      if (f.after_hit && !c.hits.length && made.reason?.includes("hasn't hit")) {
        made.reason = `${c.name} hasn't hit a creature this turn`;
      }
      features.push(made);
    }
  }

  // --- a monster's saving throw effects and legendary actions ----------------------------------
  const save_actions: OptionEntry[] = [];
  const legendary: OptionEntry[] = [];
  if (c.monster !== null) {
    const def = monsterDef(ctx, c);
    const daily = (name: string) => {
      const max = [...def.actions, ...def.bonus_actions, ...def.reactions].find(
        (a) => a.name === name,
      )?.per_day;
      return max ? { left: max - (c.daily_used[name] ?? 0), max } : null;
    };
    for (const line of view.save_actions) {
      const targets: TargetSpec = line.area
        ? { kind: "area", count: null, range: line.range ?? null, ids: [], area: line.area }
        : creature(line.range ?? null, candidates(line.range ?? null), null);
      save_actions.push(
        entry(
          {
            type: "save_action",
            id: c.id,
            ability: line.name,
            targets: targets.kind === "creature" && targets.ids[0] ? [targets.ids[0]] : [],
          },
          `${line.name}: DC ${line.dc} ${line.ability.toUpperCase()} save`,
          "action",
          targets,
          { uses: daily(line.name) },
        ),
      );
    }
    // Abilities waiting for their Recharge aren't in the view: listed, refused.
    const listed = new Set([...view.attacks, ...view.save_actions].map((a) => a.name));
    for (const name of c.expended) {
      if (listed.has(name) || monsterSpells(def).some((x) => x.action === name)) continue;
      save_actions.push(
        entry(
          { type: "save_action", id: c.id, ability: name, targets: [] },
          name,
          "action",
          null,
          {},
          `${c.name}'s ${name} hasn't recharged`,
        ),
      );
    }
    for (const line of view.legendary_actions) {
      const attackName =
        line.attacks[0] ??
        (line.uses && view.attacks.some((a) => a.name === line.uses) ? line.uses : null);
      const attack = attackName ? view.attacks.find((a) => a.name === attackName) : undefined;
      const save = line.save ?? view.save_actions.find((a) => a.name === line.uses) ?? null;
      const cast = monsterSpells(def).find(
        (x) => x.section === "legendary_actions" && x.action === line.name,
      );
      const spell = cast ? lookup(ctx.catalog.spells, cast.spell) : undefined;
      let targets: TargetSpec | null = null;
      let action: EncounterAction = { type: "legendary", id: c.id, action: line.name };
      if (attack) {
        const reach = attack.kind === "melee" ? (attack.reach ?? 5) : (attack.range?.long ?? null);
        targets = creature(reach, candidates(reach));
        action = {
          ...action,
          target: targets.ids[0] ?? "",
          ...(line.attacks.length > 1 ? { attack: attack.name } : {}),
        };
      } else if (save) {
        targets = save.area
          ? { kind: "area", count: null, range: save.range ?? null, ids: [], area: save.area }
          : creature(save.range ?? null, candidates(save.range ?? null), null);
        action = { ...action, targets: targets.ids[0] ? [targets.ids[0]] : [] };
      } else if (spell) {
        targets = spellTargets(spell);
        action = { ...action, targets: spellAim(targets) };
      }
      legendary.push(
        entry(action, line.name, "legendary", targets, {
          uses: { left: Math.max(0, legendaryMax - c.legendary_used), max: legendaryMax },
          note: line.once_per_round ? "Once per round" : null,
        }),
      );
    }
  }

  // --- standard actions ------------------------------------------------------------------------
  const standard: OptionEntry[] = [];
  const near = candidates(5);
  const enemiesNear = near.filter(
    (x) => !(c.side && e.combatants.find((y) => y.id === x)?.side === c.side),
  );
  standard.push(
    entry({ type: "dash", id: c.id }, "Dash", "action", null),
    entry({ type: "disengage", id: c.id }, "Disengage", "action", null),
    entry({ type: "dodge", id: c.id }, "Dodge", "action", null),
    entry(
      { type: "help", id: c.id, target: enemiesNear[0] ?? "" },
      "Help (an ally's attack against an enemy)",
      "action",
      creature(5, enemiesNear),
    ),
    entry(
      { type: "unarmed", id: c.id, target: near[0] ?? "", option: "grapple" },
      "Grapple",
      "attack",
      creature(5, near),
    ),
    entry(
      { type: "unarmed", id: c.id, target: near[0] ?? "", option: "shove", shove: "prone" },
      "Shove (Prone)",
      "attack",
      creature(5, near),
    ),
    entry(
      { type: "unarmed", id: c.id, target: near[0] ?? "", option: "shove", shove: "push" },
      "Shove (push 5 ft)",
      "attack",
      creature(5, near),
    ),
  );
  for (const hold of e.effects.filter((x) => x.target === c.id && x.escape_dc !== null)) {
    standard.push(
      entry(
        { type: "escape", id: c.id, effect: hold.id },
        `Escape ${hold.label} (DC ${hold.escape_dc})`,
        "action",
        null,
      ),
    );
  }
  if (conditionsOf(ctx, c).has("prone")) {
    standard.push(entry({ type: "stand", id: c.id }, "Stand up", "movement", null));
  }
  const move: EncounterAction = c.position
    ? { type: "move", id: c.id, to: { ...c.position } }
    : { type: "move", id: c.id, feet: movement };
  standard.push(
    entry(
      move,
      "Move",
      "movement",
      c.position ? { kind: "point", count: null, range: movement, ids: [], area: null } : null,
      {},
      turn && movement === 0 && !c.defeated ? `${c.name} has no movement left this turn` : null,
    ),
  );

  // --- zones it created ------------------------------------------------------------------------
  const zones: OptionEntry[] = [];
  for (const z of e.zones.filter((x) => x.by === c.id)) {
    if (z.point) {
      zones.push(
        entry(
          { type: "move_zone", zone: z.id, point: { ...z.point } },
          `Move ${z.label} (${z.id})`,
          "free",
          { kind: "point", count: null, range: null, ids: [], area: z.area },
        ),
      );
    }
    zones.push(entry({ type: "end_zone", zone: z.id }, `End ${z.label} (${z.id})`, "free", null));
  }

  return {
    id: c.id,
    name: c.name,
    turn,
    economy: {
      action: !c.used.action,
      bonus_action: !c.used.bonus_action,
      reaction: !c.used.reaction,
      movement,
      attacks_left: c.attacks_left,
      granted: c.granted_attacks ? { ...c.granted_attacks } : null,
      cleave: c.cleave ? { ...c.cleave } : null,
      legendary:
        legendaryMax > 0
          ? { left: Math.max(0, legendaryMax - c.legendary_used), max: legendaryMax }
          : null,
    },
    attacks,
    spells,
    features,
    save_actions,
    legendary,
    standard,
    zones,
  };
}

/** A monster's legendary action uses per round (its lair's when in it). */
function legendaryUses(
  def: { legendary_uses: { uses: number; in_lair: number | null } | null },
  inLair: boolean,
): number {
  const u = def.legendary_uses;
  if (!u) return 0;
  return inLair && u.in_lair !== null ? u.in_lair : u.uses;
}

/** `Longsword +5 · 1d8+3 slashing`. */
function attackLabel(line: AttackLine): string {
  const bonus = line.attack_bonus >= 0 ? `+${line.attack_bonus}` : `${line.attack_bonus}`;
  const damage = line.damage_parts.map((p) => `${formatDamage([p])} ${p.type}`).join(" + ");
  return `${line.name} ${bonus} · ${damage}`;
}

/** `Fireball (level 3)`, `Fire Bolt (cantrip)`. */
function spellLabel(spell: SpellDef, level: number | null = spell.level): string {
  return `${spell.name} (${spell.level === 0 ? "cantrip" : `level ${level ?? spell.level}`})`;
}
