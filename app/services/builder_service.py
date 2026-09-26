"""Stateless character builder workflow: validated setters over an immutable build.

Every setter returns ``(new_build, notes)``. Setters reject illegal input with
``BuildError``; upstream changes that invalidate downstream choices (e.g. a new background
that already grants a skill you picked) are repaired by ``normalize`` and reported in
``notes`` so the UI can tell the player what was reset.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from app.content.catalog import Catalog
from app.models.build import AbilityMethod, Alignment, CharacterBuild
from app.models.content import Ability, Step
from app.rules.ability_scores import background_bonus_errors, base_score_errors
from app.rules.build_resolution import Resolution, resolve
from app.rules.build_validation import Severity, ValidationReport, validate_build
from app.rules.sheet import DerivedSheet, compute_sheet

STEP_TITLES: dict[Step, str] = {
    Step.CLASS: "Class",
    Step.SPECIES: "Species",
    Step.BACKGROUND: "Background",
    Step.ABILITIES: "Ability Scores",
    Step.EQUIPMENT: "Equipment",
    Step.FEATURES: "Class & Feat Features",
    Step.PROFICIENCIES: "Skills & Tools",
    Step.LANGUAGES: "Languages",
    Step.DETAILS: "Name & Alignment",
}


class BuildError(ValueError):
    def __init__(self, messages: Sequence[str]):
        self.messages = list(messages)
        super().__init__("; ".join(self.messages))


@dataclass(frozen=True)
class Evaluation:
    build: CharacterBuild
    resolution: Resolution
    report: ValidationReport
    sheet: DerivedSheet

    def step_complete(self, step: Step) -> bool:
        return all(i.severity == Severity.NOTE for i in self.report.for_step(step))

    def next_incomplete_step(self) -> Step | None:
        return next((s for s in Step if not self.step_complete(s)), None)


def evaluate(build: CharacterBuild, catalog: Catalog) -> Evaluation:
    res = resolve(build, catalog)
    return Evaluation(
        build, res, validate_build(build, catalog, res), compute_sheet(build, catalog, res)
    )


# --- setters ----------------------------------------------------------------------------

Result = tuple[CharacterBuild, list[str]]


def set_class(build: CharacterBuild, catalog: Catalog, class_id: str) -> Result:
    if class_id not in catalog.classes:
        raise BuildError([f"Unknown class {class_id!r}"])
    return normalize(build.model_copy(update={"class_id": class_id}), catalog)


def set_species(build: CharacterBuild, catalog: Catalog, species_id: str) -> Result:
    if species_id not in catalog.species:
        raise BuildError([f"Unknown species {species_id!r}"])
    return normalize(build.model_copy(update={"species_id": species_id}), catalog)


def set_background(build: CharacterBuild, catalog: Catalog, background_id: str) -> Result:
    if background_id not in catalog.backgrounds:
        raise BuildError([f"Unknown background {background_id!r}"])
    notes = []
    update: dict = {"background_id": background_id}
    if build.background_id != background_id and build.background_bonus:
        update["background_bonus"] = {}
        notes.append("Background ability bonuses were reset: re-apply them for the new background.")
    new, more = normalize(build.model_copy(update=update), catalog)
    return new, notes + more


def set_ability_method(
    build: CharacterBuild, catalog: Catalog, method: AbilityMethod, rolled_pool: Sequence[int] = ()
) -> Result:
    if method == AbilityMethod.ROLL and len(rolled_pool) != 6:
        raise BuildError(["Rolling needs six rolled scores"])
    update = {
        "ability_method": method,
        "base_scores": {},
        "rolled_pool": list(rolled_pool) if method == AbilityMethod.ROLL else [],
        "background_bonus": {},
    }
    return normalize(build.model_copy(update=update), catalog)


def set_base_scores(
    build: CharacterBuild, catalog: Catalog, scores: Mapping[Ability, int]
) -> Result:
    if build.ability_method is None:
        raise BuildError(["Choose an ability score method first"])
    errors = base_score_errors(build.ability_method, scores, catalog.creation, build.rolled_pool)
    if errors:
        raise BuildError(errors)
    notes = []
    update: dict = {"base_scores": dict(scores)}
    if build.background_bonus and _bonus_errors(build, catalog, build.background_bonus, scores):
        update["background_bonus"] = {}
        notes.append("Background bonuses were reset because they no longer fit your scores.")
    new, more = normalize(build.model_copy(update=update), catalog)
    return new, notes + more


def set_background_bonus(
    build: CharacterBuild, catalog: Catalog, bonus: Mapping[Ability, int]
) -> Result:
    if build.background_id is None:
        raise BuildError(["Choose a background first"])
    errors = _bonus_errors(build, catalog, bonus, build.base_scores)
    if errors:
        raise BuildError(errors)
    return normalize(build.model_copy(update={"background_bonus": dict(bonus)}), catalog)


def set_choice(build: CharacterBuild, catalog: Catalog, key: str, values: Sequence[str]) -> Result:
    res = resolve(build, catalog)
    choice = res.choice(key)
    if choice is None:
        raise BuildError([f"No such choice {key!r} for this character"])
    if choice.fixed is not None:
        raise BuildError([f"{choice.label} is fixed by {choice.source.name}"])
    values = list(values)
    errors = []
    if len(set(values)) != len(values):
        errors.append("Each option can be chosen only once")
    if len(values) > choice.definition.count:
        errors.append(f"{choice.label}: choose at most {choice.definition.count}")
    views = {v.id: v for v in res.options(choice)}
    for value in values:
        view = views.get(value)
        if view is None:
            errors.append(f"{value!r} isn't an option for {choice.label}")
        elif view.unavailable:
            errors.append(f"{view.name}: {view.unavailable}")
    if errors:
        raise BuildError(errors)
    choices = {**build.choices, key: values}
    return normalize(build.model_copy(update={"choices": choices}), catalog)


def set_name(build: CharacterBuild, catalog: Catalog, name: str) -> Result:
    name = name.strip()
    if not name:
        raise BuildError(["Name can't be empty"])
    return build.model_copy(update={"name": name}), []


def set_alignment(build: CharacterBuild, catalog: Catalog, alignment: Alignment) -> Result:
    notes = []
    if alignment in (Alignment.LAWFUL_EVIL, Alignment.NEUTRAL_EVIL, Alignment.CHAOTIC_EVIL):
        notes.append("The game assumes heroes aren't evil — check with your GM.")
    return build.model_copy(update={"alignment": alignment}), notes


# --- normalization ----------------------------------------------------------------------


def normalize(build: CharacterBuild, catalog: Catalog) -> Result:
    """Drop answers to choices that no longer exist or are no longer legal.

    Invalid values are removed one at a time, re-resolving in between, so that when two
    choices conflict only one of them loses the value.
    """
    notes: list[str] = []
    while True:
        res = resolve(build, catalog)
        active = {c.key for c in res.choices}
        stale = [k for k in build.choices if k not in active]
        if stale:
            choices = {k: v for k, v in build.choices.items() if k in active}
            build = build.model_copy(update={"choices": choices})
            continue
        fix = _first_invalid_value(res)
        if fix is None:
            return build, notes
        key, index, note = fix
        remaining = [v for i, v in enumerate(build.choices[key]) if i != index]
        build = build.model_copy(update={"choices": {**build.choices, key: remaining}})
        notes.append(note)


def _first_invalid_value(res: Resolution) -> tuple[str, int, str] | None:
    """Find the first illegal answer as (choice key, index in its answer list, note)."""
    for choice in res.choices:
        if choice.fixed is not None or choice.key not in res.build.choices:
            continue
        views = {v.id: v for v in res.options(choice)}
        seen: set[str] = set()
        for i, value in enumerate(res.build.choices[choice.key]):
            view = views.get(value)
            if value in seen or view is None:
                return choice.key, i, f"{choice.label}: removed invalid choice {value!r}."
            if view.unavailable:
                return choice.key, i, f"{choice.label}: removed {view.name} ({view.unavailable})."
            if i >= choice.definition.count:
                return choice.key, i, f"{choice.label}: removed extra choice {view.name}."
            seen.add(value)
    return None


def _bonus_errors(
    build: CharacterBuild,
    catalog: Catalog,
    bonus: Mapping[Ability, int],
    base: Mapping[Ability, int],
) -> list[str]:
    background = catalog.backgrounds[build.background_id or ""]
    return background_bonus_errors(
        bonus, background.ability_scores, base, catalog.creation.max_score_at_creation
    )
