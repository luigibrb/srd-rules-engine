from app.models.content import Ability, Skill
from app.rules.sheet import compute_sheet
from app.services import builder_service as svc
from tests.conftest import apply, fighter_build

A = Ability


def test_fighter_sheet_numbers(catalog):
    sheet = compute_sheet(fighter_build(catalog), catalog)
    assert sheet.scores[A.STR] == 17 and sheet.scores[A.CON] == 14
    assert sheet.max_hp.total == 12  # 10 + Con 2
    assert sheet.armor_class.total == 17  # Chain Mail 16 + Defense 1
    assert [p.source for p in sheet.armor_class.parts] == ["Chain Mail", "Defense"]
    assert sheet.initiative.total == 2
    assert sheet.speed.total == 30
    assert sheet.saving_throws[A.STR] == (5, True)
    assert sheet.saving_throws[A.DEX] == (2, False)
    assert sheet.passive_perception == 12  # 10 + Wis 0 + prof 2 (Skillful)
    athletics = next(s for s in sheet.skills if s.skill == Skill.ATHLETICS)
    assert (athletics.modifier, athletics.proficient_from) == (5, "Soldier")
    assert sheet.gp == 4 + 50
    assert sheet.tools.keys() == {"dice-set", "lute"}


def test_attack_lines(catalog):
    attacks = {a.name: a for a in compute_sheet(fighter_build(catalog), catalog).attacks}
    assert attacks["Greatsword"].attack_bonus == 5
    assert attacks["Greatsword"].damage == "2d6+3"
    assert attacks["Greatsword"].mastery == "Graze"
    assert attacks["Javelin"].mastery == "Slow"
    assert attacks["Unarmed Strike"].damage == "4"


def test_dwarven_toughness_adds_hp(catalog):
    build = apply(fighter_build(catalog), catalog, svc.set_species, "dwarf")
    sheet = compute_sheet(build, catalog)
    assert sheet.max_hp.total == 13
    assert sheet.darkvision == 120
    assert "poison" in sheet.resistances


def test_wood_elf_speed_and_drow_darkvision(catalog):
    elf = apply(fighter_build(catalog), catalog, svc.set_species, "elf")
    wood = apply(elf, catalog, svc.set_choice, "species:elf#lineage", ["wood-elf"])
    drow = apply(elf, catalog, svc.set_choice, "species:elf#lineage", ["drow"])
    assert compute_sheet(wood, catalog).speed.total == 35
    assert compute_sheet(drow, catalog).darkvision == 120
    assert compute_sheet(drow, catalog).speed.total == 30


def test_chain_mail_without_strength_slows_you(catalog):
    build = fighter_build(catalog)
    weak = {A.STR: 8, A.DEX: 14, A.CON: 13, A.INT: 15, A.WIS: 10, A.CHA: 12}
    build = apply(build, catalog, svc.set_base_scores, weak)
    build = apply(build, catalog, svc.set_background_bonus, {A.DEX: 2, A.CON: 1})
    sheet = compute_sheet(build, catalog)
    assert sheet.speed.total == 20
    assert any("needs Strength 13" in w for w in sheet.warnings)
    greatsword = next(a for a in sheet.attacks if a.name == "Greatsword")
    assert any("Disadvantage" in n for n in greatsword.notes)


def test_studded_leather_archer(catalog):
    build = fighter_build(catalog)
    build = apply(build, catalog, svc.set_choice, "class:fighter#equipment", ["b"])
    build = apply(build, catalog, svc.set_choice, "class:fighter#fighting_style", ["archery"])
    dex = {A.STR: 13, A.DEX: 15, A.CON: 14, A.INT: 8, A.WIS: 12, A.CHA: 10}
    build = apply(build, catalog, svc.set_base_scores, dex)
    build = apply(build, catalog, svc.set_background_bonus, {A.DEX: 2, A.CON: 1})
    sheet = compute_sheet(build, catalog)
    assert sheet.armor_worn == "Studded Leather Armor"
    assert sheet.armor_class.total == 12 + 3
    longbow = next(a for a in sheet.attacks if a.name == "Longbow")
    assert longbow.attack_bonus == 3 + 2 + 2  # Dex + prof + Archery
    scimitar = next(a for a in sheet.attacks if a.name == "Scimitar")
    assert scimitar.attack_bonus == 5  # finesse uses Dex, no Archery


def test_alert_adds_proficiency_to_initiative(catalog):
    build = apply(fighter_build(catalog), catalog, svc.set_background, "criminal")
    sheet = compute_sheet(build, catalog)
    assert sheet.initiative.total == 2 + 2
    assert [p.source for p in sheet.initiative.parts] == ["Dex", "Alert"]


def test_partial_build_still_computes(catalog):
    from app.models.build import CharacterBuild

    sheet = compute_sheet(CharacterBuild(), catalog)
    assert not sheet.scores_complete
    assert sheet.max_hp is None
    assert sheet.armor_class.total == 10
