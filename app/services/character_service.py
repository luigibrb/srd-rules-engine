from __future__ import annotations

from app.models.character import Character
from app.rules.dice import ability_modifier


def is_alive(character: Character) -> bool:
    return character.current_hit_points > 0


def apply_damage(character: Character, damage: int) -> Character:
    new_hp = max(0, character.current_hit_points - damage)
    return character.model_copy(update={"current_hit_points": new_hp})


def apply_healing(character: Character, amount: int) -> Character:
    new_hp = min(character.max_hit_points, character.current_hit_points + amount)
    return character.model_copy(update={"current_hit_points": new_hp})


def passive_perception(character: Character, proficient: bool = False) -> int:
    wisdom_mod = ability_modifier(character.ability_scores.wisdom)
    bonus = character.proficiency_bonus if proficient else 0
    return 10 + wisdom_mod + bonus
