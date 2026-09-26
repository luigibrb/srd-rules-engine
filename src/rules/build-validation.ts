/** Validate a level 1 build: illegal choices are errors, missing ones are pending. */

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
}

export interface ValidationReport {
  readonly issues: readonly Issue[];
  /** True when nothing is illegal or missing (notes are allowed). */
  readonly is_complete: boolean;
}

function issue(step: Step, severity: Severity, message: string, choiceKey: string | null = null) {
  return { step, severity, message, choice_key: choiceKey } satisfies Issue;
}

export function issuesForStep(report: ValidationReport, step: Step): Issue[] {
  return report.issues.filter((i) => i.step === step);
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
    for (const step of ["equipment", "features", "proficiencies"] as const) {
      issues.push(issue(step, "pending", `Choose your ${missing.join(", ")} first`));
    }
  }
  for (const choice of res.choices) {
    if (choice.fixed === null) issues.push(...choiceIssues(res, choice));
  }
  for (const src of res.featSources()) {
    if (src.feat.unsupported) {
      issues.push(issue("features", "note", `${src.name}: ${src.feat.unsupported}`));
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

export function choiceIssues(res: Resolution, choice: ActiveChoice): Issue[] {
  const { step, key, label } = choice;
  const { count } = choice.definition;
  const selected = res.selected(choice);
  const views = new Map(res.options(choice).map((v) => [v.id, v]));
  const issues: Issue[] = [];
  const counts = new Map<string, number>();
  for (const value of selected) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const [value, n] of counts) {
    if (n > 1) issues.push(issue(step, "error", `${label}: ${value} chosen twice`, key));
  }
  for (const value of counts.keys()) {
    const view = views.get(value);
    if (!view) {
      issues.push(issue(step, "error", `${label}: '${value}' isn't an option`, key));
    } else if (view.unavailable) {
      issues.push(issue(step, "error", `${label}: ${view.name} — ${view.unavailable}`, key));
    }
  }
  if (selected.length < count) {
    issues.push(issue(step, "pending", `${label}: choose ${count - selected.length} more`, key));
  } else if (selected.length > count) {
    issues.push(issue(step, "error", `${label}: choose only ${count}`, key));
  }
  return issues;
}
