from __future__ import annotations

import random

from app.models.character import Character
from app.models.combat import AttackRoll, DamageRoll, SavingThrow
from app.models.spell import Spell
from app.rules.spell_rules import (
    cast_spell_attack,
    cast_spell_damage,
    cast_spell_save,
)
from app.services.character_service import apply_damage


def resolve_spell_attack(
    caster: Character,
    target: Character,
    spell: Spell,
    spellcasting_ability: str,
    *,
    rng: random.Random | None = None,
) -> tuple[AttackRoll, DamageRoll | None, Character]:
    attack = cast_spell_attack(caster, target, spell, spellcasting_ability, rng=rng)
    if not attack.hit:
        return attack, None, target

    dmg = cast_spell_damage(spell, critical=attack.critical_hit, rng=rng)
    updated_target = apply_damage(target, dmg.roll.total) if dmg else target
    return attack, dmg, updated_target


def resolve_spell_save(
    caster: Character,
    target: Character,
    spell: Spell,
    spellcasting_ability: str,
    *,
    rng: random.Random | None = None,
) -> tuple[SavingThrow, DamageRoll | None, Character]:
    save = cast_spell_save(caster, target, spell, spellcasting_ability, rng=rng)
    dmg = cast_spell_damage(spell, rng=rng)
    if dmg is None:
        return save, None, target

    # Half damage on successful save (standard 5e rule)
    actual_damage = dmg.roll.total // 2 if save.success else dmg.roll.total
    updated_target = apply_damage(target, actual_damage)
    return save, dmg, updated_target
