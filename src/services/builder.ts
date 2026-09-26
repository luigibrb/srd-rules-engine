/**
 * Stateless character builder workflow: validated setters over an immutable build.
 *
 * Every setter returns `{ build, notes }`. Setters reject illegal input with `BuildError`;
 * upstream changes that invalidate downstream choices (e.g. a new background that already
 * grants a skill you picked) are repaired by `normalize` and reported in `notes` so the UI
 * can tell the player what was reset.
 */

import { type Catalog, lookup, TABLE_NAMES, type Table } from "../content/catalog";
import {
  type AbilityMap,
  type AbilityMethod,
  type Alignment,
  type CharacterBuild,
  updateBuild,
} from "../models/build";
import { isSkill, STEPS, type Step, skillName } from "../models/content";
import { backgroundBonusErrors, baseScoreErrors, definedEntries } from "../rules/ability-scores";
import { answers, type Resolution, resolve } from "../rules/build-resolution";
import { issuesForStep, type ValidationReport, validateBuild } from "../rules/build-validation";
import { computeSheet, type DerivedSheet } from "../rules/sheet";

export const STEP_TITLES: Readonly<Record<Step, string>> = {
  class: "Class",
  species: "Species",
  background: "Background",
  abilities: "Ability Scores",
  equipment: "Equipment",
  features: "Class & Feat Features",
  spells: "Spells",
  proficiencies: "Skills & Tools",
  languages: "Languages",
  details: "Name & Alignment",
};

export class BuildError extends Error {
  override name = "BuildError";
  readonly messages: readonly string[];

  constructor(messages: readonly string[]) {
    super(messages.join("; "));
    this.messages = messages;
  }
}

export interface BuildResult {
  readonly build: CharacterBuild;
  /** What was changed or reset as a side effect, for the player to read. */
  readonly notes: readonly string[];
}

export interface Evaluation {
  readonly build: CharacterBuild;
  readonly resolution: Resolution;
  readonly report: ValidationReport;
  readonly sheet: DerivedSheet;
}

/** Resolve, validate and compute the sheet in one pass. */
export function evaluate(build: CharacterBuild, catalog: Catalog): Evaluation {
  const resolution = resolve(build, catalog);
  return {
    build,
    resolution,
    report: validateBuild(build, catalog, resolution),
    sheet: computeSheet(build, catalog, resolution),
  };
}

export function stepComplete(ev: Evaluation, step: Step): boolean {
  return issuesForStep(ev.report, step).every((i) => i.severity === "note");
}

export function nextIncompleteStep(ev: Evaluation): Step | null {
  return STEPS.find((s) => !stepComplete(ev, s)) ?? null;
}

// --- setters ------------------------------------------------------------------------------

export function setClass(build: CharacterBuild, catalog: Catalog, classId: string): BuildResult {
  if (!lookup(catalog.classes, classId)) throw new BuildError([`Unknown class '${classId}'`]);
  return normalize(updateBuild(build, { class_id: classId }), catalog);
}

export function setSpecies(
  build: CharacterBuild,
  catalog: Catalog,
  speciesId: string,
): BuildResult {
  if (!lookup(catalog.species, speciesId)) {
    throw new BuildError([`Unknown species '${speciesId}'`]);
  }
  return normalize(updateBuild(build, { species_id: speciesId }), catalog);
}

export function setBackground(
  build: CharacterBuild,
  catalog: Catalog,
  backgroundId: string,
): BuildResult {
  if (!lookup(catalog.backgrounds, backgroundId)) {
    throw new BuildError([`Unknown background '${backgroundId}'`]);
  }
  const notes: string[] = [];
  let update: Partial<CharacterBuild> = { background_id: backgroundId };
  if (build.background_id !== backgroundId && definedEntries(build.background_bonus).length) {
    update = { ...update, background_bonus: {} };
    notes.push("Background ability bonuses were reset: re-apply them for the new background.");
  }
  const result = normalize(updateBuild(build, update), catalog);
  return { build: result.build, notes: [...notes, ...result.notes] };
}

export function setAbilityMethod(
  build: CharacterBuild,
  catalog: Catalog,
  method: AbilityMethod,
  rolledPool: readonly number[] = [],
): BuildResult {
  if (method === "roll" && rolledPool.length !== 6) {
    throw new BuildError(["Rolling needs six rolled scores"]);
  }
  return normalize(
    updateBuild(build, {
      ability_method: method,
      base_scores: {},
      rolled_pool: method === "roll" ? [...rolledPool] : [],
      background_bonus: {},
    }),
    catalog,
  );
}

export function setBaseScores(
  build: CharacterBuild,
  catalog: Catalog,
  scores: AbilityMap,
): BuildResult {
  if (build.ability_method === null) {
    throw new BuildError(["Choose an ability score method first"]);
  }
  const errors = baseScoreErrors(build.ability_method, scores, catalog.creation, build.rolled_pool);
  if (errors.length) throw new BuildError(errors);
  const notes: string[] = [];
  let update: Partial<CharacterBuild> = { base_scores: { ...scores } };
  if (
    definedEntries(build.background_bonus).length &&
    bonusErrors(build, catalog, build.background_bonus, scores).length
  ) {
    update = { ...update, background_bonus: {} };
    notes.push("Background bonuses were reset because they no longer fit your scores.");
  }
  const result = normalize(updateBuild(build, update), catalog);
  return { build: result.build, notes: [...notes, ...result.notes] };
}

export function setBackgroundBonus(
  build: CharacterBuild,
  catalog: Catalog,
  bonus: AbilityMap,
): BuildResult {
  if (build.background_id === null) throw new BuildError(["Choose a background first"]);
  const errors = bonusErrors(build, catalog, bonus, build.base_scores);
  if (errors.length) throw new BuildError(errors);
  return normalize(updateBuild(build, { background_bonus: { ...bonus } }), catalog);
}

export function setChoice(
  build: CharacterBuild,
  catalog: Catalog,
  key: string,
  values: readonly string[],
): BuildResult {
  const res = resolve(build, catalog);
  const choice = res.choice(key);
  if (!choice) throw new BuildError([`No such choice '${key}' for this character`]);
  if (choice.fixed !== null) {
    throw new BuildError([`${choice.label} is fixed by ${choice.source.name}`]);
  }
  const errors: string[] = [];
  if (new Set(values).size !== values.length) errors.push("Each option can be chosen only once");
  if (values.length > choice.definition.count) {
    errors.push(`${choice.label}: choose at most ${choice.definition.count}`);
  }
  const views = new Map(res.options(choice).map((v) => [v.id, v]));
  for (const value of values) {
    const view = views.get(value);
    if (!view) errors.push(`'${value}' isn't an option for ${choice.label}`);
    else if (view.unavailable) errors.push(`${view.name}: ${view.unavailable}`);
  }
  if (errors.length) throw new BuildError(errors);
  return normalize(
    updateBuild(build, { choices: { ...build.choices, [key]: [...values] } }),
    catalog,
  );
}

export function setName(build: CharacterBuild, _catalog: Catalog, name: string): BuildResult {
  const trimmed = name.trim();
  if (!trimmed) throw new BuildError(["Name can't be empty"]);
  return { build: updateBuild(build, { name: trimmed }), notes: [] };
}

export function setAlignment(
  build: CharacterBuild,
  _catalog: Catalog,
  alignment: Alignment,
): BuildResult {
  const notes: string[] = [];
  if (alignment === "LE" || alignment === "NE" || alignment === "CE") {
    notes.push("The game assumes heroes aren't evil — check with your GM.");
  }
  return { build: updateBuild(build, { alignment }), notes };
}

// --- normalization ------------------------------------------------------------------------

/**
 * Drop answers to choices that no longer exist or are no longer legal.
 *
 * Invalid values are removed one at a time, re-resolving in between, so that when two
 * choices conflict only one of them loses the value.
 */
export function normalize(build: CharacterBuild, catalog: Catalog): BuildResult {
  const notes: string[] = [];
  let current = build;
  for (;;) {
    const res = resolve(current, catalog);
    const active = new Set(res.choices.map((c) => c.key));
    const keys = Object.keys(current.choices);
    if (keys.some((k) => !active.has(k))) {
      const choices = Object.fromEntries(
        Object.entries(current.choices).filter(([k]) => active.has(k)),
      );
      current = updateBuild(current, { choices });
      continue;
    }
    const fix = firstInvalidValue(res);
    if (fix === null) return { build: current, notes };
    const [key, index, note] = fix;
    const remaining = answers(current, key).filter((_, i) => i !== index);
    current = updateBuild(current, { choices: { ...current.choices, [key]: remaining } });
    notes.push(note);
  }
}

/** Find the first illegal answer as [choice key, index in its answer list, note]. */
function firstInvalidValue(res: Resolution): [string, number, string] | null {
  for (const choice of res.choices) {
    if (choice.fixed !== null || !Object.hasOwn(res.build.choices, choice.key)) continue;
    const views = new Map(res.options(choice).map((v) => [v.id, v]));
    const seen = new Set<string>();
    const values = answers(res.build, choice.key);
    for (const [i, value] of values.entries()) {
      const view = views.get(value);
      if (!view && !seen.has(value)) {
        const name = entityName(res.catalog, value);
        const note = name
          ? `${choice.label}: removed ${name} (no longer available).`
          : `${choice.label}: removed invalid choice '${value}'.`;
        return [choice.key, i, note];
      }
      if (seen.has(value) || !view) {
        return [choice.key, i, `${choice.label}: removed invalid choice '${value}'.`];
      }
      if (view.unavailable) {
        return [choice.key, i, `${choice.label}: removed ${view.name} (${view.unavailable}).`];
      }
      if (i >= choice.definition.count) {
        return [choice.key, i, `${choice.label}: removed extra choice ${view.name}.`];
      }
      seen.add(value);
    }
  }
  return null;
}

/** The display name of any skill or catalog entity with this id, if there is one. */
function entityName(catalog: Catalog, id: string): string | null {
  if (isSkill(id)) return skillName(id);
  for (const table of TABLE_NAMES) {
    const entity = lookup(catalog[table] as Table<{ name: string }>, id);
    if (entity) return entity.name;
  }
  return null;
}

function bonusErrors(
  build: CharacterBuild,
  catalog: Catalog,
  bonus: AbilityMap,
  base: AbilityMap,
): string[] {
  const background = lookup(catalog.backgrounds, build.background_id);
  if (!background) return ["Choose a background first"];
  return backgroundBonusErrors(
    bonus,
    background.ability_scores,
    base,
    catalog.creation.max_score_at_creation,
  );
}
