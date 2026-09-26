"""Validate a level 1 build: illegal choices are errors, missing ones are pending."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from enum import StrEnum

from app.content.catalog import Catalog
from app.models.build import CharacterBuild
from app.models.content import Ability, Step
from app.rules.ability_scores import background_bonus_errors, base_score_errors
from app.rules.build_resolution import ActiveChoice, Resolution, resolve


class Severity(StrEnum):
    ERROR = "error"  # an illegal choice that must be changed
    PENDING = "pending"  # a choice not made yet
    NOTE = "note"  # informational: something the builder doesn't automate


@dataclass(frozen=True)
class Issue:
    step: Step
    severity: Severity
    message: str
    choice_key: str | None = None


@dataclass(frozen=True)
class ValidationReport:
    issues: tuple[Issue, ...]

    @property
    def is_complete(self) -> bool:
        return not any(i.severity != Severity.NOTE for i in self.issues)

    def for_step(self, step: Step) -> list[Issue]:
        return [i for i in self.issues if i.step == step]

    def errors(self) -> list[Issue]:
        return [i for i in self.issues if i.severity == Severity.ERROR]


def validate_build(
    build: CharacterBuild, catalog: Catalog, res: Resolution | None = None
) -> ValidationReport:
    res = res or resolve(build, catalog)
    issues: list[Issue] = []
    issues += _check_entity(Step.CLASS, "class", build.class_id, catalog.classes)
    issues += _check_entity(Step.SPECIES, "species", build.species_id, catalog.species)
    issues += _check_entity(Step.BACKGROUND, "background", build.background_id, catalog.backgrounds)
    issues += _check_abilities(build, catalog)
    missing = [
        what
        for what, value in (
            ("class", build.class_id),
            ("species", build.species_id),
            ("background", build.background_id),
        )
        if value is None
    ]
    if missing:
        for step in (Step.EQUIPMENT, Step.FEATURES, Step.PROFICIENCIES):
            message = f"Choose your {', '.join(missing)} first"
            issues.append(Issue(step, Severity.PENDING, message))
    for choice in res.choices:
        if choice.fixed is None:
            issues += choice_issues(res, choice)
    for src in res.feat_sources():
        if src.feat.unsupported:
            note = f"{src.name}: {src.feat.unsupported}"
            issues.append(Issue(Step.FEATURES, Severity.NOTE, note))
    if not build.name.strip():
        issues.append(Issue(Step.DETAILS, Severity.PENDING, "Choose a name"))
    if build.alignment is None:
        issues.append(Issue(Step.DETAILS, Severity.PENDING, "Choose an alignment"))
    return ValidationReport(tuple(issues))


def _check_entity(step: Step, what: str, value: str | None, table: dict) -> list[Issue]:
    if value is None:
        return [Issue(step, Severity.PENDING, f"Choose a {what}")]
    if value not in table:
        return [Issue(step, Severity.ERROR, f"Unknown {what} {value!r}")]
    return []


def _check_abilities(build: CharacterBuild, catalog: Catalog) -> list[Issue]:
    step, rules = Step.ABILITIES, catalog.creation
    if build.ability_method is None:
        return [Issue(step, Severity.PENDING, "Choose how to generate ability scores")]
    issues = [
        Issue(step, Severity.ERROR, e)
        for e in base_score_errors(
            build.ability_method, build.base_scores, rules, build.rolled_pool
        )
    ]
    missing = [a.full_name for a in Ability if a not in build.base_scores]
    if missing:
        issues.append(Issue(step, Severity.PENDING, f"Assign a score to {', '.join(missing)}"))
    background = catalog.backgrounds.get(build.background_id or "")
    if background is None:
        issues.append(Issue(step, Severity.PENDING, "Choose a background to apply its bonuses"))
    elif not build.background_bonus:
        issues.append(Issue(step, Severity.PENDING, f"Apply your {background.name} bonuses"))
    else:
        issues += [
            Issue(step, Severity.ERROR, e)
            for e in background_bonus_errors(
                build.background_bonus,
                background.ability_scores,
                build.base_scores,
                rules.max_score_at_creation,
            )
        ]
    return issues


def choice_issues(res: Resolution, choice: ActiveChoice) -> list[Issue]:
    step, key, label = choice.step, choice.key, choice.label
    count = choice.definition.count
    selected = res.selected(choice)
    views = {v.id: v for v in res.options(choice)}
    issues: list[Issue] = []
    for value, n in Counter(selected).items():
        if n > 1:
            issues.append(Issue(step, Severity.ERROR, f"{label}: {value} chosen twice", key))
    for value in dict.fromkeys(selected):
        view = views.get(value)
        if view is None:
            issues.append(Issue(step, Severity.ERROR, f"{label}: {value!r} isn't an option", key))
        elif view.unavailable:
            issues.append(
                Issue(step, Severity.ERROR, f"{label}: {view.name} — {view.unavailable}", key)
            )
    if len(selected) < count:
        left = count - len(selected)
        issues.append(Issue(step, Severity.PENDING, f"{label}: choose {left} more", key))
    elif len(selected) > count:
        issues.append(Issue(step, Severity.ERROR, f"{label}: choose only {count}", key))
    return issues
