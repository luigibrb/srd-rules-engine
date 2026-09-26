import random

import pytest

from app.models.character import AbilityScores, Character, CharacterClass
from app.rules.combat_rules import attack_roll, damage_roll, saving_throw
from app.services.character_service import apply_damage, apply_healing, is_alive
from app.services.combat_service import resolve_attack


def _make_character(**overrides) -> Character:
    defaults = dict(
        name="Test",
        character_class=CharacterClass.FIGHTER,
        level=5,
        ability_scores=AbilityScores(
            strength=16, dexterity=14, constitution=15,
            intelligence=10, wisdom=12, charisma=8,
        ),
        max_hit_points=44,
        current_hit_points=44,
        armor_class=16,
        proficiency_bonus=3,
    )
    return Character(**{**defaults, **overrides})


def test_attack_roll_critical_hit():
    rng = random.Random()
    rng.randint = lambda a, b: 20  # force natural 20
    attacker = _make_character(name="Attacker")
    target = _make_character(name="Target")
    result = attack_roll(attacker, target, attack_bonus=5, rng=rng)
    assert result.critical_hit
    assert result.hit


def test_attack_roll_critical_miss():
    rng = random.Random()
    rng.randint = lambda a, b: 1  # force natural 1
    attacker = _make_character(name="Attacker")
    target = _make_character(name="Target", armor_class=1)
    result = attack_roll(attacker, target, attack_bonus=99, rng=rng)
    assert result.critical_miss
    assert not result.hit


def test_damage_roll_critical_doubles_dice():
    rng = random.Random(0)
    normal = damage_roll("2d6", "slashing", critical=False, rng=rng)
    assert normal.dice_expression == "2d6"
    rng2 = random.Random(0)
    crit = damage_roll("2d6", "slashing", critical=True, rng=rng2)
    assert crit.dice_expression == "4d6"
    assert len(crit.roll.rolls) == 4


def test_saving_throw_success():
    rng = random.Random()
    rng.randint = lambda a, b: 20
    character = _make_character()
    result = saving_throw(character, "dexterity", dc=15, rng=rng)
    assert result.success


def test_apply_damage_clamps_to_zero():
    char = _make_character(current_hit_points=5)
    result = apply_damage(char, 100)
    assert result.current_hit_points == 0


def test_apply_healing_clamps_to_max():
    char = _make_character(current_hit_points=10, max_hit_points=44)
    result = apply_healing(char, 100)
    assert result.current_hit_points == 44


def test_is_alive():
    assert is_alive(_make_character(current_hit_points=1))
    assert not is_alive(_make_character(current_hit_points=0))


def test_resolve_attack_miss_no_damage():
    rng = random.Random()
    rng.randint = lambda a, b: 1
    attacker = _make_character(name="A")
    target = _make_character(name="T", armor_class=30)
    atk, dmg, updated = resolve_attack(attacker, target, 0, "1d6", "slashing", rng=rng)
    assert not atk.hit
    assert dmg is None
    assert updated.current_hit_points == target.current_hit_points
