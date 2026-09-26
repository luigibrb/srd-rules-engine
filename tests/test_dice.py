import random

import pytest

from app.rules.dice import ability_modifier, parse_dice_expression, proficiency_bonus, roll


def test_parse_basic():
    assert parse_dice_expression("2d6") == (2, 6, 0)


def test_parse_with_positive_modifier():
    assert parse_dice_expression("1d20+5") == (1, 20, 5)


def test_parse_with_negative_modifier():
    assert parse_dice_expression("1d8-2") == (1, 8, -2)


def test_parse_invalid():
    with pytest.raises(ValueError):
        parse_dice_expression("invalid")


def test_roll_total_in_range():
    rng = random.Random(42)
    result = roll("4d6", rng=rng)
    assert len(result.rolls) == 4
    assert all(1 <= r <= 6 for r in result.rolls)
    assert result.total == sum(result.rolls)


def test_roll_with_modifier():
    rng = random.Random(0)
    result = roll("1d20+5", rng=rng)
    assert result.modifier == 5
    assert result.total == result.rolls[0] + 5


@pytest.mark.parametrize("score,expected", [
    (10, 0), (11, 0), (12, 1), (8, -1), (20, 5), (1, -5),
])
def test_ability_modifier(score, expected):
    assert ability_modifier(score) == expected


@pytest.mark.parametrize("level,expected", [
    (1, 2), (4, 2), (5, 3), (8, 3), (9, 4), (17, 6), (20, 6),
])
def test_proficiency_bonus(level, expected):
    assert proficiency_bonus(level) == expected
