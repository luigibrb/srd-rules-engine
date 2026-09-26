"""Resolve a build into its active content sources and the choices they ask for.

A *source* is anything that grants something: the base creation rules, the class, the
species, a chosen species option (e.g. Wood Elf), the background, a feat, an equipment
package. Sources declare *choices*; answering a choice can activate new sources (choosing
the Skilled feat adds a source that asks for three proficiencies).

Keys are stable strings so a build can store answers without nesting:

- source: ``class:fighter``, ``species:elf``, ``background:soldier``, ``creation``
- choice: ``<source key>#<choice id>``, e.g. ``species:elf#lineage``
- option source: ``<choice key>=<option id>``, e.g. ``species:elf#lineage=wood-elf``
- feat source: ``feat:<feat id>@<granting source or choice key>``
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field

from app.content.catalog import Catalog
from app.models.build import CharacterBuild
from app.models.content import (
    Ability,
    ChoiceDef,
    ChoiceKind,
    Effect,
    FeatDef,
    Grants,
    Skill,
    Step,
)

_SKILLS = {s.value for s in Skill}


@dataclass(frozen=True)
class ActiveSource:
    key: str
    name: str
    grants: Grants
    params: dict[str, str] = field(default_factory=dict)
    feat: FeatDef | None = None
    description: str = ""
    granted_by: str = ""  # name of the source that granted this one (feats)


@dataclass(frozen=True)
class ActiveChoice:
    key: str
    source: ActiveSource
    definition: ChoiceDef

    @property
    def fixed(self) -> list[str] | None:
        """Answer pre-filled by the granting source (e.g. Acolyte's Magic Initiate list)."""
        value = self.source.params.get(self.definition.id)
        return [value] if value is not None else None

    @property
    def step(self) -> Step:
        return self.definition.resolved_step or Step.FEATURES

    @property
    def label(self) -> str:
        return self.definition.label


@dataclass(frozen=True)
class OptionView:
    """One selectable option, with the reason it can't be picked (if any)."""

    id: str
    name: str
    description: str = ""
    unavailable: str | None = None


@dataclass(frozen=True)
class Resolution:
    build: CharacterBuild
    catalog: Catalog
    sources: tuple[ActiveSource, ...]
    choices: tuple[ActiveChoice, ...]

    # --- choice access ------------------------------------------------------------------

    def selected(self, choice: ActiveChoice) -> list[str]:
        return choice.fixed or list(self.build.choices.get(choice.key, []))

    def choice(self, key: str) -> ActiveChoice | None:
        return next((c for c in self.choices if c.key == key), None)

    def choices_for_step(self, step: Step) -> list[ActiveChoice]:
        return [c for c in self.choices if c.step == step and c.fixed is None]

    def _selections(self, kinds: set[ChoiceKind], exclude: str | None = None) -> Iterator:
        for c in self.choices:
            if c.definition.kind in kinds and c.key != exclude:
                for value in self.selected(c):
                    yield value, c

    # --- aggregated grants (fixed + selected) -------------------------------------------

    def skills(self, exclude_choice: str | None = None) -> dict[Skill, str]:
        owned: dict[Skill, str] = {}
        for src in self.sources:
            for skill in src.grants.skills:
                owned.setdefault(skill, src.name)
        kinds = {ChoiceKind.SKILL, ChoiceKind.SKILL_OR_TOOL}
        for value, c in self._selections(kinds, exclude_choice):
            if value in _SKILLS:
                owned.setdefault(Skill(value), c.source.name)
        return owned

    def tools(self, exclude_choice: str | None = None) -> dict[str, str]:
        owned: dict[str, str] = {}
        for src in self.sources:
            for tool in src.grants.tools:
                owned.setdefault(tool, src.name)
        kinds = {ChoiceKind.TOOL, ChoiceKind.SKILL_OR_TOOL}
        for value, c in self._selections(kinds, exclude_choice):
            if value in self.catalog.tools:
                owned.setdefault(value, c.source.name)
        return owned

    def languages(self, exclude_choice: str | None = None) -> dict[str, str]:
        owned: dict[str, str] = {}
        for src in self.sources:
            for lang in src.grants.languages:
                owned.setdefault(lang, src.name)
        for value, c in self._selections({ChoiceKind.LANGUAGE}, exclude_choice):
            owned.setdefault(value, c.source.name)
        return owned

    def feat_sources(self) -> list[ActiveSource]:
        return [s for s in self.sources if s.feat is not None]

    def weapon_masteries(self) -> list[str]:
        return [v for v, _ in self._selections({ChoiceKind.WEAPON_MASTERY})]

    def saving_throws(self) -> set[Ability]:
        return {a for s in self.sources for a in s.grants.saving_throws}

    def effects(self) -> list[tuple[Effect, str]]:
        return [(e, s.name) for s in self.sources for e in s.grants.effects]

    def granted(self, attr: str) -> list:
        """Concatenate a list-valued Grants attribute across sources, preserving order."""
        out: list = []
        for s in self.sources:
            for v in getattr(s.grants, attr):
                if v not in out:
                    out.append(v)
        return out

    # --- option views -------------------------------------------------------------------

    def options(self, choice: ActiveChoice) -> list[OptionView]:
        return _option_views(self, choice)


def resolve(build: CharacterBuild, catalog: Catalog) -> Resolution:
    sources: list[ActiveSource] = []
    choices: list[ActiveChoice] = []

    def add_source(src: ActiveSource) -> None:
        if any(s.key == src.key for s in sources):
            return
        sources.append(src)
        for grant in src.grants.feats:
            _add_feat(grant.feat, f"feat:{grant.feat}@{src.key}", grant.params, src.name)
        for definition in src.grants.choices:
            choice = ActiveChoice(
                key=f"{src.key}#{definition.id}", source=src, definition=definition
            )
            choices.append(choice)
            picked = choice.fixed or build.choices.get(choice.key, [])
            if definition.kind == ChoiceKind.OPTION:
                by_id = {o.id: o for o in definition.options}
                for opt_id in picked:
                    if opt_id in by_id:
                        opt = by_id[opt_id]
                        name = f"{opt.name} ({src.name})"
                        key = f"{choice.key}={opt_id}"
                        add_source(ActiveSource(key, name, opt.grants, description=opt.description))
            elif definition.kind == ChoiceKind.FEAT:
                for feat_id in picked:
                    _add_feat(feat_id, f"feat:{feat_id}@{choice.key}", {}, src.name)

    def _add_feat(feat_id: str, key: str, params: dict[str, str], granted_by: str) -> None:
        feat = catalog.feats.get(feat_id)
        if feat is not None:
            add_source(
                ActiveSource(
                    key, feat.name, feat.grants, params=params, feat=feat, granted_by=granted_by
                )
            )

    add_source(ActiveSource("creation", "Character creation", catalog.creation.base_grants))
    if build.class_id in catalog.classes:
        cls = catalog.classes[build.class_id]
        add_source(ActiveSource(f"class:{cls.id}", cls.name, cls.grants))
    if build.species_id in catalog.species:
        sp = catalog.species[build.species_id]
        add_source(ActiveSource(f"species:{sp.id}", sp.name, sp.grants))
    if build.background_id in catalog.backgrounds:
        bg = catalog.backgrounds[build.background_id]
        add_source(ActiveSource(f"background:{bg.id}", bg.name, bg.grants))

    return Resolution(build, catalog, tuple(sources), tuple(choices))


# --- options ----------------------------------------------------------------------------


def _option_views(res: Resolution, choice: ActiveChoice) -> list[OptionView]:
    d = choice.definition
    cat = res.catalog
    allowed = set(d.allowed) if d.allowed is not None else None

    def ok(item_id: str) -> bool:
        return allowed is None or item_id in allowed

    match d.kind:
        case ChoiceKind.OPTION:
            taken = _taken_by_other_feat_instances(res, choice)
            return [
                OptionView(
                    o.id,
                    o.name,
                    o.description,
                    f"already chosen for {taken[o.id]}" if o.id in taken else None,
                )
                for o in d.options
            ]
        case ChoiceKind.ABILITY:
            return [OptionView(a.value, a.full_name) for a in Ability if ok(a.value)]
        case ChoiceKind.SKILL:
            return _skill_views(res, choice, ok)
        case ChoiceKind.TOOL:
            return _tool_views(res, choice, ok)
        case ChoiceKind.SKILL_OR_TOOL:
            return _skill_views(res, choice, ok) + _tool_views(res, choice, ok)
        case ChoiceKind.LANGUAGE:
            known = res.languages(exclude_choice=choice.key)
            return [
                OptionView(lang.id, lang.name, unavailable=_known(known.get(lang.id)))
                for lang in cat.languages.values()
                if ok(lang.id) and (d.category is None or lang.category == d.category)
            ]
        case ChoiceKind.FEAT:
            owned = {
                s.feat.id: s.name for s in res.feat_sources() if not s.key.endswith(choice.key)
            }
            views = []
            for feat in cat.feats.values():
                if not ok(feat.id) or (d.category and feat.category != d.category):
                    continue
                reason = None
                if feat.id in owned and not feat.repeatable:
                    reason = "you already have this feat"
                views.append(OptionView(feat.id, feat.name, feat.description, reason))
            return views
        case ChoiceKind.WEAPON_MASTERY:
            views = []
            for w in cat.weapons.values():
                if not ok(w.id) or (d.category and w.category != d.category):
                    continue
                mastery = cat.masteries[w.mastery]
                desc = f"{mastery.name}: {mastery.description}"
                views.append(OptionView(w.id, f"{w.name} ({mastery.name})", desc))
            return views
    raise AssertionError(f"unhandled choice kind {d.kind}")


def _known(source: str | None) -> str | None:
    return f"already known from {source}" if source else None


def _skill_views(res: Resolution, choice: ActiveChoice, ok) -> list[OptionView]:
    owned = res.skills(exclude_choice=choice.key)
    return [
        OptionView(
            s.value,
            s.display_name,
            f"{s.ability.full_name} skill",
            f"already proficient from {owned[s]}" if s in owned else None,
        )
        for s in Skill
        if ok(s.value)
    ]


def _tool_views(res: Resolution, choice: ActiveChoice, ok) -> list[OptionView]:
    owned = res.tools(exclude_choice=choice.key)
    category = choice.definition.category
    return [
        OptionView(
            t.id,
            t.name,
            t.category.replace("-", " "),
            f"already proficient from {owned[t.id]}" if t.id in owned else None,
        )
        for t in res.catalog.tools.values()
        if ok(t.id) and (category is None or t.category == category)
    ]


def _taken_by_other_feat_instances(res: Resolution, choice: ActiveChoice) -> dict[str, str]:
    """For a repeatable feat whose repeats must differ (Magic Initiate spell list)."""
    feat = choice.source.feat
    if feat is None or feat.repeat_requires_different != choice.definition.id:
        return {}
    taken: dict[str, str] = {}
    for other in res.choices:
        if (
            other.key != choice.key
            and other.source.feat is not None
            and other.source.feat.id == feat.id
            and other.definition.id == choice.definition.id
        ):
            for value in res.selected(other):
                taken[value] = f"your other {feat.name}"
    return taken
