/**
 * Stateless character builder workflow: validated setters over an immutable build.
 *
 * Every setter returns `{ build, notes }`. Setters reject illegal input with `BuildError`;
 * upstream changes that invalidate downstream choices (e.g. a new background that already
 * grants a skill you picked) are repaired by `normalize` and reported in `notes` so the UI
 * can tell the player what was reset.
 */

import { type Catalog, lookup } from "../content/catalog";
import {
  type AbilityMap,
  type AbilityMethod,
  type Alignment,
  type CharacterBuild,
  characterLevel,
  updateBuild,
} from "../models/build";
import { ABILITIES, ABILITY_NAMES, STEPS, type Step } from "../models/content";
import { backgroundBonusErrors, baseScoreErrors, definedEntries } from "../rules/ability-scores";
import {
  type ActiveChoice,
  answers,
  entityName,
  type Resolution,
  resolve,
} from "../rules/build-resolution";
import {
  issuesForLevel,
  issuesForStep,
  multiclassBlockers,
  replaceErrors,
  reportErrors,
  type ValidationReport,
  validateBuild,
} from "../rules/build-validation";
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
  return commit(build, catalog, normalize(updateBuild(build, { class_id: classId }), catalog));
}

export function setSpecies(
  build: CharacterBuild,
  catalog: Catalog,
  speciesId: string,
): BuildResult {
  if (!lookup(catalog.species, speciesId)) {
    throw new BuildError([`Unknown species '${speciesId}'`]);
  }
  return commit(build, catalog, normalize(updateBuild(build, { species_id: speciesId }), catalog));
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
  return commit(build, catalog, { build: result.build, notes: [...notes, ...result.notes] });
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
  const update = {
    ability_method: method,
    base_scores: {},
    rolled_pool: method === "roll" ? [...rolledPool] : [],
    background_bonus: {},
  };
  return commit(build, catalog, normalize(updateBuild(build, update), catalog));
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
  return commit(build, catalog, { build: result.build, notes: [...notes, ...result.notes] });
}

export function setBackgroundBonus(
  build: CharacterBuild,
  catalog: Catalog,
  bonus: AbilityMap,
): BuildResult {
  if (build.background_id === null) throw new BuildError(["Choose a background first"]);
  const errors = bonusErrors(build, catalog, bonus, build.base_scores);
  if (errors.length) throw new BuildError(errors);
  return commit(
    build,
    catalog,
    normalize(updateBuild(build, { background_bonus: { ...bonus } }), catalog),
  );
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
  if (choice.replaces) {
    const errors = replaceErrors(res, choice, values);
    if (errors.length) throw new BuildError(errors.map((e) => `${choice.label}: ${e}`));
    const choices = { ...build.choices, [key]: [...values] };
    return commit(build, catalog, normalize(updateBuild(build, { choices }), catalog));
  }
  const repeats = choice.definition.kind === "ability_increase";
  if (!repeats && new Set(values).size !== values.length) {
    errors.push("Each option can be chosen only once");
  }
  const count = res.countOf(choice);
  if (values.length > count) errors.push(`${choice.label}: choose at most ${count}`);
  const views = new Map(res.options(choice).map((v) => [v.id, v]));
  for (const value of values) {
    const view = views.get(value);
    if (!view) errors.push(`'${value}' isn't an option for ${choice.label}`);
    else if (view.unavailable) errors.push(`${view.name}: ${view.unavailable}`);
  }
  if (repeats && !errors.length) {
    const before = res.abilityScores(choice.level) as Record<string, number>;
    for (const value of new Set(values)) {
      const n = values.filter((v) => v === value).length;
      if ((before[value] ?? 0) + n > choice.definition.max_score) {
        errors.push(
          `${views.get(value)?.name ?? value} can't exceed ${choice.definition.max_score}`,
        );
      }
    }
  }
  if (errors.length) throw new BuildError(errors);
  const choices = { ...build.choices, [key]: [...values] };
  return commit(build, catalog, normalize(updateBuild(build, { choices }), catalog));
}

// --- levels -------------------------------------------------------------------------------

/** A class you could level up in, with the reason you can't (if any). */
export interface LevelUpOption {
  readonly class_id: string;
  readonly name: string;
  /** Your level in this class after the level-up. */
  readonly class_level: number;
  readonly hit_die: number;
  /** Fixed Hit Points for the level (before your Constitution modifier). */
  readonly fixed_hp: number;
  readonly unavailable: string | null;
}

/** Fixed Hit Points gained per level after 1: half the hit die, plus 1. */
export function fixedHitPoints(hitDie: number): number {
  return Math.floor(hitDie / 2) + 1;
}

/** Every class, with whether the character can take its next level in it. */
export function levelUpOptions(build: CharacterBuild, catalog: Catalog): LevelUpOption[] {
  const res = resolve(build, catalog);
  const current = res.classLevels();
  const next = res.characterLevel + 1;
  const atMax = res.characterLevel >= catalog.creation.max_level;
  return Object.values(catalog.classes).map((cls) => {
    const have = current.get(cls.id) ?? 0;
    let unavailable: string | null = null;
    if (build.class_id === null) unavailable = "choose your first class during character creation";
    else if (atMax) unavailable = `already level ${catalog.creation.max_level}`;
    else if (have === 0) {
      const blockers = multiclassBlockers(res, catalog, [...current.keys(), cls.id], next);
      if (blockers.length) unavailable = blockers.join("; ");
    }
    return {
      class_id: cls.id,
      name: cls.name,
      class_level: have + 1,
      hit_die: cls.hit_die,
      fixed_hp: fixedHitPoints(cls.hit_die),
      unavailable,
    };
  });
}

/**
 * Gain a level in a class (your current class, or a new one if you meet the multiclass
 * prerequisites). `hp` is the Hit Die roll, or `null` for the fixed value.
 */
export function levelUp(
  build: CharacterBuild,
  catalog: Catalog,
  classId: string,
  hp: number | null = null,
): BuildResult {
  const option = levelUpOptions(build, catalog).find((o) => o.class_id === classId);
  if (!option) throw new BuildError([`Unknown class '${classId}'`]);
  if (option.unavailable) throw new BuildError([`${option.name}: ${option.unavailable}`]);
  checkRoll(hp, option.hit_die);
  const levels = [...build.levels, { class_id: classId, hp }];
  return commit(build, catalog, normalize(updateBuild(build, { levels }), catalog));
}

/** Change how Hit Points were gained at a level (2+): `null` for fixed, or the Hit Die roll. */
export function setLevelHp(
  build: CharacterBuild,
  catalog: Catalog,
  level: number,
  hp: number | null,
): BuildResult {
  const entry = build.levels[level - 2];
  if (!entry) throw new BuildError([`The character has no level ${level}`]);
  const cls = lookup(catalog.classes, entry.class_id);
  if (cls) checkRoll(hp, cls.hit_die);
  const levels = build.levels.map((l, i) => (i === level - 2 ? { ...l, hp } : l));
  return commit(build, catalog, { build: updateBuild(build, { levels }), notes: [] });
}

/** Undo the last level-up, dropping the choices it made. */
export function removeLastLevel(build: CharacterBuild, catalog: Catalog): BuildResult {
  if (!build.levels.length) throw new BuildError(["The character is level 1"]);
  const level = characterLevel(build);
  const result = normalize(updateBuild(build, { levels: build.levels.slice(0, -1) }), catalog);
  return commit(build, catalog, {
    build: result.build,
    notes: [`Removed level ${level}.`, ...result.notes],
  });
}

function checkRoll(hp: number | null, hitDie: number): void {
  if (hp !== null && (!Number.isInteger(hp) || hp < 1 || hp > hitDie)) {
    throw new BuildError([`A d${hitDie} roll is between 1 and ${hitDie}, not ${hp}`]);
  }
}

/** Whether every choice and check of a level (2+) is done. */
export function levelComplete(ev: Evaluation, level: number): boolean {
  return issuesForLevel(ev.report, level).every((i) => i.severity === "note");
}

/**
 * Change the class a past level (2+) went into. Class features follow the Nth level *in* a class
 * (`class:fighter:3`), so later choices move with them where they still apply; the rest are
 * repaired by `normalize`, and the change is refused if it would leave the character illegal.
 */
export function setLevelClass(
  build: CharacterBuild,
  catalog: Catalog,
  level: number,
  classId: string,
): BuildResult {
  if (level === 1) return setClass(build, catalog, classId);
  const entry = build.levels[level - 2];
  if (!entry) throw new BuildError([`The character has no level ${level}`]);
  const cls = lookup(catalog.classes, classId);
  if (!cls) throw new BuildError([`Unknown class '${classId}'`]);
  const notes: string[] = [];
  let hp = entry.hp;
  if (hp !== null && hp > cls.hit_die) {
    hp = null;
    notes.push(
      `Level ${level}: the Hit Die roll doesn't fit a d${cls.hit_die}; using the fixed value.`,
    );
  }
  const levels = build.levels.map((l, i) => (i === level - 2 ? { class_id: classId, hp } : l));
  const result = normalize(updateBuild(build, { levels }), catalog);
  return commit(build, catalog, { build: result.build, notes: [...notes, ...result.notes] });
}

// --- override mode: change the past safely -----------------------------------------------

/**
 * Every setter goes through this guard: the change has already been applied and repaired
 * (`normalize` dropped the picks it made illegal), and now the whole build is validated. Any
 * error that wasn't there before is something repair can't fix (a later multiclass level whose
 * prerequisite is no longer met, say), so the change is refused with the validator's own reason
 * and the build stays as it was. No per-case rules: whatever the validator checks, this enforces.
 */
function commit(before: CharacterBuild, catalog: Catalog, result: BuildResult): BuildResult {
  const describe = (i: { level: number; message: string }) =>
    i.level > 1 ? `Level ${i.level}: ${i.message}` : i.message;
  const known = new Set(reportErrors(validateBuild(before, catalog)).map(describe));
  const fresh = reportErrors(validateBuild(result.build, catalog))
    .map(describe)
    .filter((m) => !known.has(m));
  if (fresh.length) throw new BuildError(fresh);
  return result;
}

export interface ChangePreview extends BuildResult {
  /** Picks the change would drop (other than the one being edited). */
  readonly removed: readonly { level: number; key: string; label: string; values: string[] }[];
  /** New questions the change creates (e.g. the new subclass's choices). */
  readonly pending: readonly { level: number; message: string }[];
}

/** A sheet number an option would change (`previewOption`). */
export interface StatChange {
  /** `armor_class`, `max_hp`, `initiative`, `speed`, `passive_perception`, or an ability (`str`). */
  readonly stat: string;
  /** `AC`, `HP`, `Initiative`, `Speed`, `Passive Perception`, `Strength`. */
  readonly label: string;
  readonly before: number;
  readonly after: number;
}

/**
 * The sheet numbers picking `value` for choice `choiceKey` would change (AC, HP, Initiative,
 * Speed, Passive Perception, ability scores), compared with the choice left unanswered, as a
 * builder shows next to an option ("AC 16 → 17"). Empty when nothing changes, or until the
 * ability scores are complete. Nothing is validated or committed.
 */
export function previewOption(
  build: CharacterBuild,
  catalog: Catalog,
  choiceKey: string,
  value: string,
): StatChange[] {
  const without = Object.fromEntries(
    Object.entries(build.choices).filter(([k]) => k !== choiceKey),
  );
  const before = computeSheet(updateBuild(build, { choices: without }), catalog);
  const after = computeSheet(
    updateBuild(build, { choices: { ...without, [choiceKey]: [value] } }),
    catalog,
  );
  if (!after.scores_complete) return [];
  const rows: [string, string, (s: DerivedSheet) => number][] = [
    ["armor_class", "AC", (s) => s.armor_class.total],
    ["max_hp", "HP", (s) => s.max_hp?.total ?? 0],
    ["initiative", "Initiative", (s) => s.initiative.total],
    ["speed", "Speed", (s) => s.speed.total],
    ["passive_perception", "Passive Perception", (s) => s.passive_perception],
    ...ABILITIES.map((a): [string, string, (s: DerivedSheet) => number] => [
      a,
      ABILITY_NAMES[a],
      (s) => s.scores[a],
    ]),
  ];
  return rows
    .map(([stat, label, of]) => ({ stat, label, before: of(before), after: of(after) }))
    .filter((c) => c.before !== c.after);
}

/**
 * Run a change without committing to it and describe its effect on the rest of the build:
 *
 * ```ts
 * previewChange(build, catalog, (b) => setChoice(b, catalog, "class:fighter:3#subclass", ["x"]))
 * ```
 *
 * Throws `BuildError` if the change is refused. `edited` is the choice key being changed, left
 * out of `removed`.
 */
export function previewChange(
  build: CharacterBuild,
  catalog: Catalog,
  change: (build: CharacterBuild) => BuildResult,
  edited?: string,
): ChangePreview {
  const result = change(build);
  const before = resolve(build, catalog);
  const removed: { level: number; key: string; label: string; values: string[] }[] = [];
  for (const [key, values] of Object.entries(build.choices)) {
    if (key === edited) continue;
    const after = answers(result.build, key);
    const gone = values.filter((v) => !after.includes(v));
    if (!gone.length) continue;
    const choice: ActiveChoice | undefined = before.choice(key);
    removed.push({
      level: choice?.level ?? 1,
      key,
      label: choice?.label ?? key,
      values: choice?.replaces
        ? [values.map((v) => entityName(catalog, v) ?? v).join(" → ")]
        : gone.map((v) => entityName(catalog, v) ?? v),
    });
  }
  const pendingOf = (b: CharacterBuild) =>
    validateBuild(b, catalog).issues.filter((i) => i.severity === "pending");
  const was = new Set(pendingOf(build).map((i) => `${i.level}|${i.message}`));
  const pending = pendingOf(result.build)
    .filter((i) => !was.has(`${i.level}|${i.message}`))
    .map((i) => ({ level: i.level, message: i.message }));
  removed.sort((a, b) => a.level - b.level);
  return { ...result, removed, pending };
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
    const remaining = index < 0 ? [] : answers(current, key).filter((_, i) => i !== index);
    current = updateBuild(current, { choices: { ...current.choices, [key]: remaining } });
    notes.push(note);
  }
}

/** Find the first illegal answer as [choice key, index in its answer list, note]. */
function firstInvalidValue(res: Resolution): [string, number, string] | null {
  // Earlier levels first: when two picks conflict, the later one gives way.
  const ordered = [...res.choices].sort((a, b) => a.level - b.level);
  for (const choice of ordered) {
    if (choice.fixed !== null || !Object.hasOwn(res.build.choices, choice.key)) continue;
    if (choice.replaces) {
      const errors = replaceErrors(res, choice);
      if (errors.length) return [choice.key, -1, `${choice.label}: removed (${errors[0]}).`];
      continue;
    }
    const views = new Map(res.options(choice).map((v) => [v.id, v]));
    const seen = new Set<string>();
    const values = answers(res.build, choice.key);
    if (choice.definition.kind === "ability_increase") {
      const fix = invalidIncrease(
        res,
        choice.key,
        values,
        choice.definition.max_score,
        choice.level,
      );
      if (fix) return [choice.key, fix[0], `${choice.label}: ${fix[1]}`];
      if (values.length > choice.definition.count) {
        return [choice.key, values.length - 1, `${choice.label}: removed an extra increase.`];
      }
      continue;
    }
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
      if (i >= res.countOf(choice)) {
        return [choice.key, i, `${choice.label}: removed extra choice ${view.name}.`];
      }
      seen.add(value);
    }
  }
  return null;
}

/** The first ability increase that's unknown or goes over the cap, as [index, note]. */
function invalidIncrease(
  res: Resolution,
  _key: string,
  values: readonly string[],
  max: number,
  level: number,
): [number, string] | null {
  const scores = res.abilityScores(level) as Record<string, number>;
  const running: Record<string, number> = {};
  for (const [i, value] of values.entries()) {
    if (!Object.hasOwn(scores, value)) return [i, `removed invalid choice '${value}'.`];
    running[value] = (running[value] ?? scores[value] ?? 0) + 1;
    if ((running[value] ?? 0) > max) {
      return [i, `removed an increase to ${value.toUpperCase()} (it can't exceed ${max}).`];
    }
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
