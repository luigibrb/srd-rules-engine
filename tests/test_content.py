from pathlib import Path

import pytest
import yaml

from app.content.catalog import CONTENT_DIR, ContentError, load_catalog
from app.models.content import ChoiceKind


def test_catalog_loads_srd_subset(catalog):
    assert set(catalog.classes) == {"fighter"}
    assert len(catalog.species) == 9
    assert set(catalog.backgrounds) == {"acolyte", "criminal", "sage", "soldier"}
    assert len(catalog.weapons) == 38
    assert len(catalog.armor) == 13


def test_every_entity_tracks_its_source(catalog):
    tables = [
        catalog.classes,
        catalog.species,
        catalog.backgrounds,
        catalog.feats,
        catalog.weapons,
        catalog.armor,
        catalog.gear,
        catalog.tools,
        catalog.languages,
    ]
    for table in tables:
        for entity in table.values():
            assert entity.source == "srd-5.2.1", entity.id


def test_weapon_and_armor_rows_match_srd(catalog):
    greatsword = catalog.weapons["greatsword"]
    assert (greatsword.damage, greatsword.mastery) == ("2d6", "graze")
    assert {"heavy", "two-handed"} <= set(greatsword.properties)
    assert catalog.weapons["longsword"].versatile_damage == "1d10"
    chain = catalog.armor["chain-mail"]
    assert (chain.base_ac, chain.dex_cap, chain.strength) == (16, 0, 13)
    assert catalog.armor["hide-armor"].dex_cap == 2


def test_point_buy_table_totals_standard_array(catalog):
    pb = catalog.creation.point_buy
    assert sum(pb.costs[s] for s in catalog.creation.standard_array) == pb.budget


def test_class_standard_array_is_a_permutation(catalog):
    for cls in catalog.classes.values():
        assert sorted(cls.standard_array.values()) == sorted(catalog.creation.standard_array)


def test_option_choices_have_options(catalog):
    for sp in catalog.species.values():
        for choice in sp.grants.choices:
            if choice.kind == ChoiceKind.OPTION:
                assert choice.options, (sp.id, choice.id)


def test_unknown_reference_is_rejected(tmp_path: Path):
    for src in CONTENT_DIR.rglob("*.yaml"):
        dest = tmp_path / src.relative_to(CONTENT_DIR)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(src.read_text())
    backgrounds = yaml.safe_load((tmp_path / "backgrounds.yaml").read_text())
    backgrounds[0]["grants"]["feats"] = [{"feat": "no-such-feat"}]
    (tmp_path / "backgrounds.yaml").write_text(yaml.safe_dump(backgrounds))
    with pytest.raises(ContentError, match="no-such-feat"):
        load_catalog(tmp_path)
