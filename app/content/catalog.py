"""Load rules content from YAML into a validated, immutable Catalog."""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from functools import cache
from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict

from app.models.content import (
    ArmorDef,
    BackgroundDef,
    ChoiceDef,
    ChoiceKind,
    ClassDef,
    ContentEntity,
    CreationRules,
    FeatDef,
    GearDef,
    Grants,
    LanguageDef,
    MasteryDef,
    SpeciesDef,
    ToolDef,
    WeaponDef,
)

CONTENT_DIR = Path(__file__).resolve().parents[2] / "content" / "srd-5.2.1"

Item = WeaponDef | ArmorDef | GearDef | ToolDef


class ContentError(ValueError):
    pass


class Catalog(BaseModel):
    model_config = ConfigDict(frozen=True)

    creation: CreationRules
    classes: dict[str, ClassDef]
    species: dict[str, SpeciesDef]
    backgrounds: dict[str, BackgroundDef]
    feats: dict[str, FeatDef]
    weapons: dict[str, WeaponDef]
    armor: dict[str, ArmorDef]
    gear: dict[str, GearDef]
    tools: dict[str, ToolDef]
    languages: dict[str, LanguageDef]
    masteries: dict[str, MasteryDef]

    def item(self, item_id: str) -> Item:
        for table in (self.weapons, self.armor, self.gear, self.tools):
            if item_id in table:
                return table[item_id]
        raise KeyError(item_id)

    def validate_references(self) -> None:
        """Raise ContentError if any id referenced by content doesn't exist."""
        errors: list[str] = []

        def check(ids: Iterable[str], table: dict, what: str, where: str) -> None:
            errors.extend(f"{where}: unknown {what} {i!r}" for i in ids if i not in table)

        items = {**self.weapons, **self.armor, **self.gear, **self.tools}
        for where, grants in self._all_grants():
            check((f.feat for f in grants.feats), self.feats, "feat", where)
            check(grants.tools, self.tools, "tool", where)
            check(grants.languages, self.languages, "language", where)
            check((i.item for i in grants.items), items, "item", where)
            for choice in grants.choices:
                if choice.kind == ChoiceKind.LANGUAGE and choice.allowed:
                    check(choice.allowed, self.languages, "language", where)
                if choice.kind == ChoiceKind.TOOL and choice.allowed:
                    check(choice.allowed, self.tools, "tool", where)
        check((w.mastery for w in self.weapons.values()), self.masteries, "mastery", "weapons")
        if errors:
            raise ContentError("\n".join(errors))

    def _all_grants(self) -> Iterator[tuple[str, Grants]]:
        roots: list[tuple[str, Grants]] = [("creation", self.creation.base_grants)]
        for table in (self.classes, self.species, self.backgrounds, self.feats):
            roots.extend((f"{e.id}", e.grants) for e in table.values())
        for where, grants in roots:
            yield from _walk(where, grants)


def _walk(where: str, grants: Grants) -> Iterator[tuple[str, Grants]]:
    yield where, grants
    choice: ChoiceDef
    for choice in grants.choices:
        for option in choice.options:
            yield from _walk(f"{where}.{choice.id}.{option.id}", option.grants)


def _read(path: Path) -> object:
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f)


def _table[E: ContentEntity](path: Path, model: type[E]) -> dict[str, E]:
    raw = _read(path)
    entries = raw if isinstance(raw, list) else [raw]
    table: dict[str, E] = {}
    for entry in entries:
        entity = model.model_validate(entry)
        if entity.id in table:
            raise ContentError(f"{path.name}: duplicate id {entity.id!r}")
        table[entity.id] = entity
    return table


def load_catalog(content_dir: Path = CONTENT_DIR) -> Catalog:
    classes: dict[str, ClassDef] = {}
    for path in sorted((content_dir / "classes").glob("*.yaml")):
        classes.update(_table(path, ClassDef))
    catalog = Catalog(
        creation=CreationRules.model_validate(_read(content_dir / "creation.yaml")),
        classes=classes,
        species=_table(content_dir / "species.yaml", SpeciesDef),
        backgrounds=_table(content_dir / "backgrounds.yaml", BackgroundDef),
        feats=_table(content_dir / "feats.yaml", FeatDef),
        weapons=_table(content_dir / "weapons.yaml", WeaponDef),
        armor=_table(content_dir / "armor.yaml", ArmorDef),
        gear=_table(content_dir / "gear.yaml", GearDef),
        tools=_table(content_dir / "tools.yaml", ToolDef),
        languages=_table(content_dir / "languages.yaml", LanguageDef),
        masteries=_table(content_dir / "masteries.yaml", MasteryDef),
    )
    catalog.validate_references()
    return catalog


@cache
def default_catalog() -> Catalog:
    return load_catalog()
