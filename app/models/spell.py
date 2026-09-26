from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field


class SpellSchool(StrEnum):
    ABJURATION = "abjuration"
    CONJURATION = "conjuration"
    DIVINATION = "divination"
    ENCHANTMENT = "enchantment"
    EVOCATION = "evocation"
    ILLUSION = "illusion"
    NECROMANCY = "necromancy"
    TRANSMUTATION = "transmutation"


class DamageType(StrEnum):
    ACID = "acid"
    BLUDGEONING = "bludgeoning"
    COLD = "cold"
    FIRE = "fire"
    FORCE = "force"
    LIGHTNING = "lightning"
    NECROTIC = "necrotic"
    PIERCING = "piercing"
    POISON = "poison"
    PSYCHIC = "psychic"
    RADIANT = "radiant"
    SLASHING = "slashing"
    THUNDER = "thunder"


class Spell(BaseModel):
    name: str
    level: int = Field(ge=0, le=9)
    school: SpellSchool
    casting_time: str
    range: str
    duration: str
    damage_dice: str | None = None
    damage_type: DamageType | None = None
    save_ability: str | None = None
    attack_type: str | None = None
    description: str = ""
