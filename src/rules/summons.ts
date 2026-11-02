/**
 * Summoned creatures (SRD: Find Familiar, Find Steed, Giant Insect, Summon Dragon, Animate
 * Objects, Animate Dead, Create Undead): a `summons` template's stat block for the spell's level,
 * the caster and the choices made, and how many creatures one cast makes.
 */

import type { MonsterDef, SummonDef, SummonSpec } from "../models/content";
import { MonsterSchema } from "../models/content";
import { instantiateTemplate, TemplateError, type TemplateVars } from "./templates";

/** What a summoned creature's stat block depends on. */
export interface SummonVars {
  /** The spell slot's level ("the spell's level" in the stat block). */
  readonly spell_level: number;
  /** The caster's Proficiency Bonus ("PB equals your Proficiency Bonus"). */
  readonly pb: number;
  readonly spell_attack: number;
  readonly spell_dc: number;
  /** The caster's spellcasting ability modifier. */
  readonly ability_mod: number;
  /** The summoner's level in the class whose feature brings it (0 for a spell). */
  readonly class_level: number;
}

/** The stat block a template makes with these values and choices (`form: spider`…). */
export function summonMonster(
  summon: SummonDef,
  vars: SummonVars,
  choices: Readonly<Record<string, string>> = {},
): MonsterDef {
  for (const [key, values] of Object.entries(summon.choices)) {
    const value = choices[key];
    if (value === undefined || !values.includes(value)) {
      throw new TemplateError(`${summon.id}: choose ${key} (${values.join(", ")})`);
    }
  }
  const block = instantiateTemplate(summon.stat_block, { ...vars, ...choices } as TemplateVars);
  return MonsterSchema.parse({
    ...(block as Record<string, unknown>),
    id: summon.id,
    name: summon.name,
    source: summon.source,
    description: summon.description,
  });
}

/** Every combination of a template's choices. */
function combinations(
  choices: Readonly<Record<string, readonly string[]>>,
): Record<string, string>[] {
  let out: Record<string, string>[] = [{}];
  for (const [key, values] of Object.entries(choices)) {
    out = out.flatMap((c) => values.map((v) => ({ ...c, [key]: v })));
  }
  return out;
}

/**
 * What's wrong with a template: it must make a valid stat block for every combination of its
 * choices and every spell level from `minLevel` (the lowest spell that summons it) up, with a
 * sample caster, else the catalog doesn't load.
 */
export function summonErrors(summon: SummonDef, minLevel = 1): string[] {
  const errors = new Set<string>();
  for (const choices of combinations(summon.choices)) {
    for (let spell_level = minLevel; spell_level <= 9; spell_level++) {
      for (const class_level of [1, 3, 5, 10, 15, 20]) {
        const vars = {
          spell_level,
          class_level,
          pb: 2 + Math.floor((class_level - 1) / 4),
          spell_attack: 5,
          spell_dc: 13,
          ability_mod: 3,
        };
        try {
          summonMonster(summon, vars, choices);
        } catch (error) {
          const what = error instanceof Error ? error.message.split("\n")[0] : String(error);
          errors.add(`summons/${summon.id} (${JSON.stringify(choices)}): ${what}`);
        }
      }
    }
  }
  return [...errors];
}

type SummonForm = SummonSpec["forms"][number];

/**
 * How many creatures a cast can make: the forms' weights add up to this at most. A form with
 * `count_by_level` sets its own number (and the cast makes only that form); otherwise the
 * spell's `count` (or the spellcasting ability modifier) plus `count_per_level` per level above
 * the spell's.
 */
export function summonLimit(
  summon: SummonSpec,
  spellLevel: number,
  slotLevel: number,
  abilityMod: number,
  forms: readonly SummonForm[],
): number {
  const byLevel = forms.find((f) => f.count_by_level)?.count_by_level;
  if (byLevel) return byLevel[String(slotLevel)] ?? 0;
  const base = summon.count_ability ? Math.max(1, abilityMod) : summon.count;
  return base + summon.count_per_level * Math.max(0, slotLevel - spellLevel);
}
