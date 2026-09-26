import pytest

from app.models.build import AbilityMethod, CharacterBuild
from app.models.content import Ability, Step
from app.rules.build_validation import Severity, validate_build
from app.services import builder_service as svc
from app.services.builder_service import BuildError, evaluate
from tests.conftest import apply, fighter_build

A = Ability


def test_empty_build_lists_pending_steps(catalog):
    report = validate_build(CharacterBuild(), catalog)
    assert not report.is_complete
    assert not report.errors()
    pending_steps = {i.step for i in report.issues if i.severity == Severity.PENDING}
    assert pending_steps == set(Step)


def test_complete_fighter_is_valid(catalog):
    ev = evaluate(fighter_build(catalog), catalog)
    assert ev.report.is_complete, ev.report.issues
    assert ev.next_incomplete_step() is None


def test_build_is_immutable(catalog):
    build = CharacterBuild()
    new, _ = svc.set_class(build, catalog, "fighter")
    assert build.class_id is None and new.class_id == "fighter"
    with pytest.raises(Exception):
        new.class_id = "wizard"


def test_unknown_class_rejected(catalog):
    with pytest.raises(BuildError, match="Unknown class"):
        svc.set_class(CharacterBuild(), catalog, "wizard")


def test_skill_already_granted_by_background_is_rejected(catalog):
    build = fighter_build(catalog)
    with pytest.raises(BuildError, match="already proficient from Soldier"):
        svc.set_choice(build, catalog, "class:fighter#skills", ["athletics", "history"])


def test_skill_choice_must_come_from_class_list(catalog):
    build = fighter_build(catalog)
    with pytest.raises(BuildError, match="isn't an option"):
        svc.set_choice(build, catalog, "class:fighter#skills", ["arcana", "history"])


def test_choice_count_is_enforced(catalog):
    build = fighter_build(catalog)
    with pytest.raises(BuildError, match="at most 2"):
        svc.set_choice(build, catalog, "class:fighter#skills", ["history", "insight", "acrobatics"])


def test_changing_background_repairs_downstream_choices(catalog):
    build = fighter_build(catalog)  # Skilled picked Stealth; Criminal grants Stealth
    new, notes = svc.set_background(build, catalog, "criminal")
    assert new.background_bonus == {}
    assert any("bonuses were reset" in n for n in notes)
    assert any("removed Stealth" in n for n in notes)
    skilled = new.choices["feat:skilled@species:human#versatile#proficiencies"]
    assert "stealth" not in skilled
    report = validate_build(new, catalog)
    assert not report.errors()
    assert any("Skilled proficiencies: choose 1 more" in i.message for i in report.issues)


def test_changing_species_drops_its_choices(catalog):
    build = fighter_build(catalog)
    new, _ = svc.set_species(build, catalog, "dwarf")
    assert not any(k.startswith("species:human") for k in new.choices)
    assert not any("skilled" in k for k in new.choices)


def test_non_repeatable_origin_feat_cannot_be_taken_twice(catalog):
    build = fighter_build(catalog)  # Soldier grants Savage Attacker
    with pytest.raises(BuildError, match="already have this feat"):
        svc.set_choice(build, catalog, "species:human#versatile", ["savage-attacker"])


def test_magic_initiate_repeat_needs_a_different_list(catalog):
    build = apply(CharacterBuild(), catalog, svc.set_species, "human")
    build = apply(build, catalog, svc.set_background, "acolyte")
    build = apply(build, catalog, svc.set_choice, "species:human#versatile", ["magic-initiate"])
    key = "feat:magic-initiate@species:human#versatile#spell_list"
    with pytest.raises(BuildError, match="already chosen"):
        svc.set_choice(build, catalog, key, ["cleric"])
    build = apply(build, catalog, svc.set_choice, key, ["wizard"])
    assert build.choices[key] == ["wizard"]


def test_fixed_choice_cannot_be_changed(catalog):
    build = apply(CharacterBuild(), catalog, svc.set_background, "acolyte")
    key = "feat:magic-initiate@background:acolyte#spell_list"
    with pytest.raises(BuildError, match="fixed by"):
        svc.set_choice(build, catalog, key, ["wizard"])


def test_magic_initiate_spells_are_flagged_as_not_automated(catalog):
    build = apply(CharacterBuild(), catalog, svc.set_background, "sage")
    notes = [i for i in validate_build(build, catalog).issues if i.severity == Severity.NOTE]
    assert any("Magic Initiate" in i.message for i in notes)


def test_point_buy_overspend_rejected(catalog):
    build = apply(CharacterBuild(), catalog, svc.set_ability_method, AbilityMethod.POINT_BUY)
    with pytest.raises(BuildError, match="overspent"):
        svc.set_base_scores(build, catalog, dict.fromkeys(A, 15))


def test_all_twenties_rejected_with_any_method(catalog):
    for method in (AbilityMethod.STANDARD_ARRAY, AbilityMethod.POINT_BUY):
        build = apply(CharacterBuild(), catalog, svc.set_ability_method, method)
        with pytest.raises(BuildError):
            svc.set_base_scores(build, catalog, dict.fromkeys(A, 20))


def test_changing_method_clears_scores(catalog):
    build = fighter_build(catalog)
    new, _ = svc.set_ability_method(build, catalog, AbilityMethod.POINT_BUY)
    assert new.base_scores == {} and new.background_bonus == {}


def test_bonus_for_wrong_background_ability_rejected(catalog):
    build = fighter_build(catalog)
    with pytest.raises(BuildError, match="can only increase"):
        svc.set_background_bonus(build, catalog, {A.CHA: 2, A.STR: 1})


def test_evil_alignment_is_allowed_with_a_note(catalog):
    from app.models.build import Alignment

    _, notes = svc.set_alignment(CharacterBuild(), catalog, Alignment.CHAOTIC_EVIL)
    assert notes and "GM" in notes[0]


def test_normalize_resolves_choice_conflict_once(catalog):
    build = fighter_build(catalog)
    # Force a conflict between two choices: Human Skillful and Fighter both pick Survival.
    choices = {**build.choices, "species:human#skillful": ["survival"]}
    fixed, notes = svc.normalize(build.model_copy(update={"choices": choices}), catalog)
    picks = [fixed.choices["class:fighter#skills"], fixed.choices["species:human#skillful"]]
    assert sum("survival" in p for p in picks) == 1
    assert len(notes) == 1
