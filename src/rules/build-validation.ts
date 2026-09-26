/** Validate a build: illegal choices are errors, missing ones are pending. */

import { type Catalog, lookup, type Table } from "../content/catalog";
import type { CharacterBuild } from "../models/build";
import { ABILITIES, ABILITY_NAMES, type Step } from "../models/content";
import { backgroundBonusErrors, baseScoreErrors, definedEntries } from "./ability-scores";
import { type ActiveChoice, type Resolution, resolve } from "./build-resolution";

export const SEVERITIES = [
  "error", // an illegal choice that must be changed
  "pending", // a choice not made yet
  "note", // informational: something the builder doesn't automate
] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Issue {
  readonly step: Step;
  readonly severity: Severity;
  readonly message: string;
  readonly choice_key: string | null;
  /** The character level the issue belongs to (1 for character creation). */
  readonly level: number;
}

export interface ValidationReport {
  readonly issues: readonly Issue[];
  /** True when nothing is illegal or missing (notes are allowed). */
  readonly is_complete: boolean;
}

function issue(
  step: Step,
  severity: Severity,
  message: string,
  choiceKey: string | null = null,
  level = 1,
) {
  return { step, severity, message, choice_key: choiceKey, level } satisfies Issue;
}

/** Issues of character creation (level 1) in a step. */

export function issuesForStep(report: ValidationReport, step: Step): Issue[] {
  return report.issues.filter((i) => i.step === step && i.level === 1);
}

/** Issues of a level gained after level 1. */
export function issuesForLevel(report: ValidationReport, level: number): Issue[] {
  return report.issues.filter((i) => i.level === level);
}

export function reportErrors(report: ValidationReport): Issue[] {
  return report.issues.filter((i) => i.severity === "error");
}

export function validateBuild(
  build: CharacterBuild,
  catalog: Catalog,
  res: Resolution = resolve(build, catalog),
): ValidationReport {
  const issues: Issue[] = [
    ...checkEntity("class", "class", build.class_id, catalog.classes),
    ...checkEntity("species", "species", build.species_id, catalog.species),
    ...checkEntity("background", "background", build.background_id, catalog.backgrounds),
    ...checkAbilities(build, catalog),
  ];
  const missing = (
    [
      ["class", build.class_id],
      ["species", build.species_id],
      ["background", build.background_id],
    ] as const
  )
    .filter(([, value]) => value === null)
    .map(([what]) => what);
  if (missing.length) {
    for (const step of ["equipment", "features", "spells", "proficiencies"] as const) {
      issues.push(issue(step, "pending", `Choose your ${missing.join(", ")} first`));
    }
  }
  issues.push(...checkLevels(res, catalog));
  for (const choice of res.choices) {
    if (choice.fixed === null) issues.push(...choiceIssues(res, choice));
  }
  for (const src of res.featSources()) {
    if (src.feat.unsupported) {
      issues.push(
        issue("features", "note", `${src.name}: ${src.feat.unsupported}`, null, src.level),
      );
    }
  }
  if (!build.name.trim()) issues.push(issue("details", "pending", "Choose a name"));
  if (build.alignment === null) issues.push(issue("details", "pending", "Choose an alignment"));
  return { issues, is_complete: issues.every((i) => i.severity === "note") };
}

function checkEntity(
  step: Step,
  what: string,
  value: string | null,
  table: Table<unknown>,
): Issue[] {
  if (value === null) return [issue(step, "pending", `Choose a ${what}`)];
  if (!lookup(table, value)) return [issue(step, "error", `Unknown ${what} '${value}'`)];
  return [];
}

function checkAbilities(build: CharacterBuild, catalog: Catalog): Issue[] {
  const step = "abilities";
  const rules = catalog.creation;
  if (build.ability_method === null) {
    return [issue(step, "pending", "Choose how to generate ability scores")];
  }
  const issues = baseScoreErrors(
    build.ability_method,
    build.base_scores,
    rules,
    build.rolled_pool,
  ).map((e) => issue(step, "error", e));
  const missing = ABILITIES.filter((a) => build.base_scores[a] === undefined).map(
    (a) => ABILITY_NAMES[a],
  );
  if (missing.length) {
    issues.push(issue(step, "pending", `Assign a score to ${missing.join(", ")}`));
  }
  const background = lookup(catalog.backgrounds, build.background_id);
  if (!background) {
    issues.push(issue(step, "pending", "Choose a background to apply its bonuses"));
  } else if (!definedEntries(build.background_bonus).length) {
    issues.push(issue(step, "pending", `Apply your ${background.name} bonuses`));
  } else {
    for (const e of backgroundBonusErrors(
      build.background_bonus,
      background.ability_scores,
      build.base_scores,
      rules.max_score_at_creation,
    )) {
      issues.push(issue(step, "error", e));
    }
  }
  return issues;
}

/** Level-ups: known classes, Hit Die rolls in range, multiclass prerequisites, level cap. */
function checkLevels(res: Resolution, catalog: Catalog): Issue[] {
  const issues: Issue[] = [];
  const rules = catalog.creation;
  if (res.characterLevel > rules.max_level) {
    issues.push(
      issue(
        "class",
        "error",
        `Characters can't go past level ${rules.max_level}`,
        null,
        res.characterLevel,
      ),
    );
  }
  const taken: string[] = [];
  for (const l of res.levels) {
    const cls = lookup(catalog.classes, l.class_id);
    if (l.level === 1) {
      taken.push(l.class_id);
      continue;
    }
    if (!cls) {
      issues.push(issue("class", "error", `Unknown class '${l.class_id}'`, null, l.level));
      continue;
    }
    if (l.hp !== null && l.hp > cls.hit_die) {
      issues.push(
        issue(
          "class",
          "error",
          `Hit Die roll ${l.hp} is higher than a d${cls.hit_die}`,
          null,
          l.level,
        ),
      );
    }
    if (l.class_level === 1) {
      const unmet = multiclassBlockers(res, catalog, [...taken, l.class_id], l.level);
      if (unmet.length) {
        issues.push(
          issue(
            "class",
            "error",
            `Can't multiclass into ${cls.name}: ${unmet.join("; ")}`,
            null,
            l.level,
          ),
        );
      }
      taken.push(l.class_id);
    }
  }
  return issues;
}

/**
 * Why a character with these classes can't take a new class at `level`: every class needs a
 * score of at least 13 (by default) in its primary ability (any of them, or all of them for
 * classes such as the Monk).
 */
export function multiclassBlockers(
  res: Resolution,
  catalog: Catalog,
  classIds: readonly string[],
  level: number,
): string[] {
  const min = catalog.creation.multiclass_min_score;
  const scores = res.abilityScores(level);
  const out: string[] = [];
  for (const id of new Set(classIds)) {
    const cls = lookup(catalog.classes, id);
    if (!cls) continue;
    const meets = (a: (typeof cls.primary_abilities)[number]) => scores[a] >= min;
    const ok =
      cls.primary_mode === "all"
        ? cls.primary_abilities.every(meets)
        : cls.primary_abilities.some(meets);
    if (!ok) {
      const names = cls.primary_abilities
        .map((a) => ABILITY_NAMES[a])
        .join(cls.primary_mode === "all" ? " and " : " or ");
      out.push(`${cls.name} needs ${names} ${min}+`);
    }
  }
  return out;
}

export function choiceIssues(res: Resolution, choice: ActiveChoice): Issue[] {
  const { step, key, label, level } = choice;
  const { count, kind } = choice.definition;
  const selected = res.selected(choice);
  const views = new Map(res.options(choice).map((v) => [v.id, v]));
  const issues: Issue[] = [];
  const add = (severity: Severity, message: string) =>
    issues.push(issue(step, severity, message, key, level));
  const counts = new Map<string, number>();
  for (const value of selected) counts.set(value, (counts.get(value) ?? 0) + 1);
  if (kind === "ability_increase") {
    // The same ability can be picked more than once (+2 = picked twice), up to the cap.
    const before = res.abilityScores(level);
    for (const [value, n] of counts) {
      const ability = value as keyof typeof before;
      if (Object.hasOwn(before, ability) && before[ability] + n > choice.definition.max_score) {
        add(
          "error",
          `${label}: ${ABILITY_NAMES[ability]} can't exceed ${choice.definition.max_score}`,
        );
      }
    }
  } else {
    for (const [value, n] of counts) {
      if (n > 1) add("error", `${label}: ${value} chosen twice`);
    }
  }
  for (const value of counts.keys()) {
    const view = views.get(value);
    if (!view) add("error", `${label}: '${value}' isn't an option`);
    else if (view.unavailable && kind !== "ability_increase") {
      add("error", `${label}: ${view.name} — ${view.unavailable}`);
    }
  }
  const required = res.required(choice);
  if (selected.length < required) {
    add("pending", `${label}: choose ${required - selected.length} more`);
  } else if (selected.length > count) add("error", `${label}: choose only ${count}`);
  return issues;
}
