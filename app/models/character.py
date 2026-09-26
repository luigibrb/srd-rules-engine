from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field


class CharacterClass(StrEnum):
    BARBARIAN = "barbarian"
    BARD = "bard"
    CLERIC = "cleric"
    DRUID = "druid"
    FIGHTER = "fighter"
    MONK = "monk"
    PALADIN = "paladin"
    RANGER = "ranger"
    ROGUE = "rogue"
    SORCERER = "sorcerer"
    WARLOCK = "warlock"
    WIZARD = "wizard"


class AbilityScores(BaseModel):
    strength: int = Field(ge=1, le=30)
    dexterity: int = Field(ge=1, le=30)
    constitution: int = Field(ge=1, le=30)
    intelligence: int = Field(ge=1, le=30)
    wisdom: int = Field(ge=1, le=30)
    charisma: int = Field(ge=1, le=30)


class Character(BaseModel):
    name: str
    character_class: CharacterClass
    level: int = Field(ge=1, le=20)
    ability_scores: AbilityScores
    max_hit_points: int = Field(ge=1)
    current_hit_points: int = Field(ge=0)
    armor_class: int = Field(ge=1)
    proficiency_bonus: int = Field(ge=2, le=6)
    speed: int = Field(default=30, ge=0)
