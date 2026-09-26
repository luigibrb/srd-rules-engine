import random

import pytest

from app.models.build import AbilityMethod
from app.models.content import Ability
from app.rules.ability_scores import (
    background_bonus_errors,
    base_score_errors,
    point_buy_status,
    roll_ability_score,
    roll_ability_scores,
    unassigned_values,
)

A = Ability


def test_point_buy_status_tracks_remaining_and_reachable(catalog):
    rules = catalog.creation.point_buy
    status = point_buy_status({A.STR: 15, A.DEX: 14, A.CON: 13}, rules)
    assert status.spent == 9 + 7 + 5
    assert status.remaining == 6
    # 6 points left: an 8 can reach 13 (5 points) but not 14 (7 points).
    assert status.abilities[A.INT].max_affordable == 13
    assert status.abilities[A.STR].increase_cost is None  # already 15
    assert status.abilities[A.DEX].increase_cost == 2
    assert status.abilities[A.DEX].can_increase


def test_point_buy_cannot_afford_when_budget_spent(catalog):
    rules = catalog.creation.point_buy
    scores = {A.STR: 15, A.DEX: 14, A.CON: 13, A.INT: 12, A.WIS: 10, A.CHA: 8}
    status = point_buy_status(scores, rules)
    assert status.remaining == 0
    assert not any(a.can_increase for a in status.abilities.values())
    assert status.abilities[A.CHA].max_affordable == 8


def test_point_buy_rejects_all_fifteens(catalog):
    scores = dict.fromkeys(A, 15)
    errors = base_score_errors(AbilityMethod.POINT_BUY, scores, catalog.creation)
    assert errors == ["Point buy overspent: 54 of 27 points"]


@pytest.mark.parametrize("score", [7, 16, 20])
def test_point_buy_rejects_out_of_range(catalog, score):
    errors = base_score_errors(AbilityMethod.POINT_BUY, {A.STR: score}, catalog.creation)
    assert errors and "8-15" in errors[0]


def test_standard_array_rejects_reused_value(catalog):
    scores = {A.STR: 15, A.DEX: 15}
    errors = base_score_errors(AbilityMethod.STANDARD_ARRAY, scores, catalog.creation)
    assert errors and "standard array" in errors[0]


def test_standard_array_partial_assignment_is_fine(catalog):
    scores = {A.STR: 15, A.DEX: 14}
    assert base_score_errors(AbilityMethod.STANDARD_ARRAY, scores, catalog.creation) == []
    left = unassigned_values(AbilityMethod.STANDARD_ARRAY, scores, catalog.creation, [])
    assert left == [13, 12, 10, 8]


def test_rolled_scores_must_come_from_pool(catalog):
    pool = [18, 12, 11, 10, 9, 7]
    ok = {A.STR: 18, A.DEX: 12}
    assert base_score_errors(AbilityMethod.ROLL, ok, catalog.creation, pool) == []
    assert base_score_errors(AbilityMethod.ROLL, {A.STR: 17}, catalog.creation, pool)


def test_roll_drops_lowest_die():
    rng = random.Random()
    rolls = iter([6, 1, 4, 5])
    rng.randint = lambda a, b: next(rolls)
    result = roll_ability_score(rng)
    assert (result.dropped, result.total) == (1, 15)


def test_roll_six_scores_is_deterministic_with_seed():
    first = [r.total for r in roll_ability_scores(random.Random(7))]
    second = [r.total for r in roll_ability_scores(random.Random(7))]
    assert first == second and len(first) == 6
    assert all(3 <= t <= 18 for t in first)


BG = [A.STR, A.DEX, A.CON]


@pytest.mark.parametrize(
    "bonus", [{A.STR: 2, A.CON: 1}, {A.STR: 1, A.DEX: 1, A.CON: 1}, {A.DEX: 2, A.STR: 1}]
)
def test_background_bonus_valid_patterns(bonus):
    assert background_bonus_errors(bonus, BG, {}, 20) == []


@pytest.mark.parametrize(
    "bonus", [{A.STR: 3}, {A.STR: 2, A.DEX: 2}, {A.STR: 2}, {A.STR: 1, A.DEX: 1}]
)
def test_background_bonus_invalid_patterns(bonus):
    assert background_bonus_errors(bonus, BG, {}, 20)


def test_background_bonus_only_listed_abilities():
    errors = background_bonus_errors({A.WIS: 2, A.STR: 1}, BG, {}, 20)
    assert any("Wisdom" in e for e in errors)


def test_background_bonus_cannot_exceed_20():
    errors = background_bonus_errors({A.STR: 2, A.CON: 1}, BG, {A.STR: 19}, 20)
    assert errors == ["Strength can't exceed 20"]
