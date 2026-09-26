from __future__ import annotations

import random

from app.models.character import Character
from app.models.combat import AttackRoll, DamageRoll
from app.rules.combat_rules import attack_roll, damage_roll
from app.services.character_service import apply_damage


def resolve_attack(
    attacker: Character,
    target: Character,
    attack_bonus: int,
    damage_dice: str,
    damage_type: str,
    *,
    rng: random.Random | None = None,
) -> tuple[AttackRoll, DamageRoll | None, Character]:
    """Return (attack_roll, damage_roll_or_None, updated_target)."""
    attack = attack_roll(attacker, target, attack_bonus, rng=rng)
    if not attack.hit:
        return attack, None, target

    dmg = damage_roll(damage_dice, damage_type, critical=attack.critical_hit, rng=rng)
    updated_target = apply_damage(target, dmg.roll.total)
    return attack, dmg, updated_target
