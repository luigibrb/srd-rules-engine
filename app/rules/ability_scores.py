"""Ability score generation and validation (SRD 5.2.1, Character Creation step 3)."""

from __future__ import annotations

import random
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from app.models.build import AbilityMethod
from app.models.content import Ability, CreationRules, PointBuyRules
from app.rules.dice import ability_modifier


@dataclass(frozen=True)
class AbilityRoll:
    rolls: tuple[int, ...]
    dropped: int

    @property
    def total(self) -> int:
        return sum(self.rolls) - self.dropped


def roll_ability_score(rng: random.Random | None = None) -> AbilityRoll:
    """Roll 4d6 and drop the lowest die."""
    r = rng or random.Random()
    rolls = tuple(r.randint(1, 6) for _ in range(4))
    return AbilityRoll(rolls=rolls, dropped=min(rolls))


def roll_ability_scores(rng: random.Random | None = None) -> list[AbilityRoll]:
    r = rng or random.Random()
    return [roll_ability_score(r) for _ in range(6)]


# --- Point buy --------------------------------------------------------------------------


@dataclass(frozen=True)
class PointBuyAbility:
    score: int
    cost: int
    increase_cost: int | None  # extra points for +1, None if already at the maximum
    can_increase: bool
    can_decrease: bool
    max_affordable: int  # highest score reachable for this ability with the points left


@dataclass(frozen=True)
class PointBuyStatus:
    budget: int
    spent: int
    abilities: dict[Ability, PointBuyAbility]

    @property
    def remaining(self) -> int:
        return self.budget - self.spent


def point_buy_cost(score: int, rules: PointBuyRules) -> int:
    if score not in rules.costs:
        raise ValueError(
            f"Point buy scores must be between {rules.min_score} and {rules.max_score}, got {score}"
        )
    return rules.costs[score]


def point_buy_status(scores: Mapping[Ability, int], rules: PointBuyRules) -> PointBuyStatus:
    """Budget summary; abilities not yet set count as the minimum score (cost 0)."""
    full = {a: scores.get(a, rules.min_score) for a in Ability}
    spent = sum(point_buy_cost(s, rules) for s in full.values())
    remaining = rules.budget - spent
    per_ability = {}
    for ability, score in full.items():
        cost = point_buy_cost(score, rules)
        inc = rules.costs[score + 1] - cost if score < rules.max_score else None
        best = score
        while best < rules.max_score and rules.costs[best + 1] - cost <= remaining:
            best += 1
        per_ability[ability] = PointBuyAbility(
            score=score,
            cost=cost,
            increase_cost=inc,
            can_increase=inc is not None and inc <= remaining,
            can_decrease=score > rules.min_score,
            max_affordable=best,
        )
    return PointBuyStatus(budget=rules.budget, spent=spent, abilities=per_ability)


# --- Validation -------------------------------------------------------------------------


def base_score_errors(
    method: AbilityMethod,
    scores: Mapping[Ability, int],
    rules: CreationRules,
    rolled_pool: Sequence[int] = (),
) -> list[str]:
    """Errors in the base (pre-background) scores. Missing abilities are not errors."""
    errors: list[str] = []
    values = list(scores.values())
    if method == AbilityMethod.POINT_BUY:
        pb = rules.point_buy
        bad = [f"{a.full_name} {s}" for a, s in scores.items() if s not in pb.costs]
        if bad:
            errors.append(
                f"Point buy scores must be {pb.min_score}-{pb.max_score}: {', '.join(bad)}"
            )
        else:
            spent = point_buy_status(scores, pb).spent
            if spent > pb.budget:
                errors.append(f"Point buy overspent: {spent} of {pb.budget} points")
    else:
        pool = rules.standard_array if method == AbilityMethod.STANDARD_ARRAY else rolled_pool
        if method == AbilityMethod.ROLL and len(pool) != 6:
            errors.append("Roll six ability scores before assigning them")
        elif Counter(values) - Counter(pool):
            label = "the standard array" if method == AbilityMethod.STANDARD_ARRAY else "your rolls"
            errors.append(
                f"Scores {sorted(values, reverse=True)} don't come from {label} "
                f"{sorted(pool, reverse=True)} (each value can be used once)"
            )
    return errors


def unassigned_values(
    method: AbilityMethod, scores: Mapping[Ability, int], rules: CreationRules, pool: Sequence[int]
) -> list[int]:
    """For array/roll methods: values from the pool not yet assigned to an ability."""
    source = rules.standard_array if method == AbilityMethod.STANDARD_ARRAY else pool
    left = Counter(source) - Counter(scores.values())
    return sorted(left.elements(), reverse=True)


def background_bonus_errors(
    bonus: Mapping[Ability, int],
    allowed: Sequence[Ability],
    base_scores: Mapping[Ability, int],
    cap: int,
) -> list[str]:
    errors: list[str] = []
    not_allowed = [a.full_name for a in bonus if a not in allowed]
    if not_allowed:
        names = ", ".join(a.full_name for a in allowed)
        errors.append(f"Your background can only increase {names}, not {', '.join(not_allowed)}")
    if sorted(bonus.values()) not in ([1, 2], [1, 1, 1]):
        errors.append("Increase one score by 2 and another by 1, or three scores by 1")
    for ability, inc in bonus.items():
        if ability in base_scores and base_scores[ability] + inc > cap:
            errors.append(f"{ability.full_name} can't exceed {cap}")
    return errors


def final_scores(
    base_scores: Mapping[Ability, int], bonus: Mapping[Ability, int]
) -> dict[Ability, int]:
    return {a: base_scores[a] + bonus.get(a, 0) for a in Ability if a in base_scores}


def format_modifier(score: int) -> str:
    return f"{ability_modifier(score):+d}"
