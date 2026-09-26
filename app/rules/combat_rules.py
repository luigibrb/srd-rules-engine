from __future__ import annotations

import random

from app.models.combat import AttackRoll, DamageRoll, SavingThrow
from app.models.character import Character
from app.rules.dice import ability_modifier, roll


def attack_roll(
    attacker: Character,
    target: Character,
    attack_bonus: int,
    *,
    rng: random.Random | None = None,
) -> AttackRoll:
    result = roll("1d20", rng=rng)
    d20 = result.rolls[0]
    total = d20 + attack_bonus
    return AttackRoll(
        attacker_name=attacker.name,
        target_name=target.name,
        attack_bonus=attack_bonus,
        target_ac=target.armor_class,
        roll=result,
        hit=d20 == 20 or (d20 != 1 and total >= target.armor_class),
        critical_hit=d20 == 20,
        critical_miss=d20 == 1,
    )


def damage_roll(
    dice_expression: str,
    damage_type: str,
    *,
    critical: bool = False,
    rng: random.Random | None = None,
) -> DamageRoll:
    expr = _double_dice(dice_expression) if critical else dice_expression
    return DamageRoll(
        dice_expression=expr,
        roll=roll(expr, rng=rng),
        damage_type=damage_type,
    )


def saving_throw(
    character: Character,
    ability: str,
    dc: int,
    *,
    proficient: bool = False,
    rng: random.Random | None = None,
) -> SavingThrow:
    score = getattr(character.ability_scores, ability.lower())
    bonus = ability_modifier(score)
    if proficient:
        bonus += character.proficiency_bonus
    result = roll("1d20", rng=rng)
    return SavingThrow(
        character_name=character.name,
        ability=ability,
        dc=dc,
        bonus=bonus,
        roll=result,
        success=result.total + bonus >= dc,
    )


def _double_dice(expression: str) -> str:
    from app.rules.dice import parse_dice_expression

    count, sides, modifier = parse_dice_expression(expression)
    base = f"{count * 2}d{sides}"
    if modifier > 0:
        return f"{base}+{modifier}"
    if modifier < 0:
        return f"{base}{modifier}"
    return base
