from __future__ import annotations

import random
import re

from app.models.combat import RollResult

_DICE_PATTERN = re.compile(r"^(\d+)d(\d+)([+-]\d+)?$", re.IGNORECASE)


def parse_dice_expression(expression: str) -> tuple[int, int, int]:
    """Return (count, sides, modifier) from an expression like '2d6+3'."""
    match = _DICE_PATTERN.match(expression.strip())
    if not match:
        raise ValueError(f"Invalid dice expression: {expression!r}")
    count = int(match.group(1))
    sides = int(match.group(2))
    modifier = int(match.group(3)) if match.group(3) else 0
    return count, sides, modifier


def roll(expression: str, *, rng: random.Random | None = None) -> RollResult:
    r = rng or random.Random()
    count, sides, modifier = parse_dice_expression(expression)
    rolls = [r.randint(1, sides) for _ in range(count)]
    return RollResult(
        dice_expression=expression,
        rolls=rolls,
        modifier=modifier,
        total=sum(rolls) + modifier,
    )


def ability_modifier(score: int) -> int:
    return (score - 10) // 2


def proficiency_bonus(level: int) -> int:
    return (level - 1) // 4 + 2
