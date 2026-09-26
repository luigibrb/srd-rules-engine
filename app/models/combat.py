from __future__ import annotations

from pydantic import BaseModel, Field


class RollResult(BaseModel):
    dice_expression: str
    rolls: list[int]
    modifier: int
    total: int


class AttackRoll(BaseModel):
    attacker_name: str
    target_name: str
    attack_bonus: int
    target_ac: int
    roll: RollResult
    hit: bool
    critical_hit: bool
    critical_miss: bool


class DamageRoll(BaseModel):
    dice_expression: str
    roll: RollResult
    damage_type: str


class SavingThrow(BaseModel):
    character_name: str
    ability: str
    dc: int
    bonus: int
    roll: RollResult
    success: bool
