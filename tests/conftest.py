import pytest

from app.content.catalog import Catalog, default_catalog
from app.models.build import AbilityMethod, Alignment, CharacterBuild
from app.models.content import Ability
from app.services import builder_service as svc

A = Ability


@pytest.fixture(scope="session")
def catalog() -> Catalog:
    return default_catalog()


def apply(build: CharacterBuild, catalog: Catalog, setter, *args) -> CharacterBuild:
    build, _ = setter(build, catalog, *args)
    return build


def fighter_build(catalog: Catalog, **overrides) -> CharacterBuild:
    """A complete Human Fighter / Soldier: Str 17, Chain Mail, Defense."""
    b = CharacterBuild()
    b = apply(b, catalog, svc.set_class, "fighter")
    b = apply(b, catalog, svc.set_species, "human")
    b = apply(b, catalog, svc.set_choice, "species:human#size", ["medium"])
    b = apply(b, catalog, svc.set_choice, "species:human#skillful", ["perception"])
    b = apply(b, catalog, svc.set_choice, "species:human#versatile", ["skilled"])
    b = apply(b, catalog, svc.set_background, "soldier")
    b = apply(b, catalog, svc.set_ability_method, AbilityMethod.STANDARD_ARRAY)
    scores = {A.STR: 15, A.DEX: 14, A.CON: 13, A.INT: 8, A.WIS: 10, A.CHA: 12}
    b = apply(b, catalog, svc.set_base_scores, scores)
    b = apply(b, catalog, svc.set_background_bonus, {A.STR: 2, A.CON: 1})
    b = apply(b, catalog, svc.set_choice, "class:fighter#equipment", ["a"])
    b = apply(b, catalog, svc.set_choice, "background:soldier#equipment", ["b"])
    b = apply(b, catalog, svc.set_choice, "class:fighter#fighting_style", ["defense"])
    masteries = ["greatsword", "flail", "javelin"]
    b = apply(b, catalog, svc.set_choice, "class:fighter#weapon_mastery", masteries)
    b = apply(b, catalog, svc.set_choice, "class:fighter#skills", ["acrobatics", "survival"])
    b = apply(b, catalog, svc.set_choice, "background:soldier#tool", ["dice-set"])
    skilled = "feat:skilled@species:human#versatile#proficiencies"
    b = apply(b, catalog, svc.set_choice, skilled, ["stealth", "insight", "lute"])
    b = apply(b, catalog, svc.set_choice, "creation#languages", ["dwarvish", "giant"])
    b = apply(b, catalog, svc.set_name, "Brakka")
    b = apply(b, catalog, svc.set_alignment, Alignment.NEUTRAL_GOOD)
    return b.model_copy(update=overrides)
