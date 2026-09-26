from __future__ import annotations

import random

from app.models.character import Character
from app.models.combat import AttackRoll, DamageRoll, SavingThrow
from app.models.spell import Spell
from app.rules.combat_rules import damage_roll, saving_throw
from app.rules.dice import ability_modifier, roll


def spell_save_dc(caster: Character, spellcasting_ability: str) -> int:
    score = getattr(caster.ability_scores, spellcasting_ability.lower())
    return 8 + caster.proficiency_bonus + ability_modifier(score)


def spell_attack_bonus(caster: Character, spellcasting_ability: str) -> int:
    score = getattr(caster.ability_scores, spellcasting_ability.lower())
    return caster.proficiency_bonus + ability_modifier(score)


def cast_spell_attack(
    caster: Character,
    target: Character,
    spell: Spell,
    spellcasting_ability: str,
    *,
    rng: random.Random | None = None,
) -> AttackRoll:
    from app.rules.combat_rules import attack_roll

    bonus = spell_attack_bonus(caster, spellcasting_ability)
    return attack_roll(caster, target, bonus, rng=rng)


def cast_spell_save(
    caster: Character,
    target: Character,
    spell: Spell,
    spellcasting_ability: str,
    *,
    rng: random.Random | None = None,
) -> SavingThrow:
    dc = spell_save_dc(caster, spellcasting_ability)
    ability = spell.save_ability or "dexterity"
    return saving_throw(target, ability, dc, rng=rng)


def cast_spell_damage(
    spell: Spell,
    *,
    critical: bool = False,
    rng: random.Random | None = None,
) -> DamageRoll | None:
    if not spell.damage_dice or not spell.damage_type:
        return None
    return damage_roll(spell.damage_dice, spell.damage_type.value, critical=critical, rng=rng)
