from fastapi import APIRouter
from pydantic import BaseModel

from app.models.character import Character
from app.models.spell import Spell
from app.rules.spell_rules import spell_attack_bonus, spell_save_dc
from app.services.spell_service import resolve_spell_attack, resolve_spell_save

router = APIRouter(prefix="/spells", tags=["spells"])


class SpellAttackRequest(BaseModel):
    caster: Character
    target: Character
    spell: Spell
    spellcasting_ability: str


class SpellSaveRequest(BaseModel):
    caster: Character
    target: Character
    spell: Spell
    spellcasting_ability: str


class SpellStatsRequest(BaseModel):
    caster: Character
    spellcasting_ability: str


@router.post("/stats")
def spell_stats(req: SpellStatsRequest) -> dict:
    return {
        "save_dc": spell_save_dc(req.caster, req.spellcasting_ability),
        "attack_bonus": spell_attack_bonus(req.caster, req.spellcasting_ability),
    }


@router.post("/attack")
def spell_attack(req: SpellAttackRequest) -> dict:
    atk, dmg, updated_target = resolve_spell_attack(
        req.caster, req.target, req.spell, req.spellcasting_ability
    )
    return {
        "attack": atk,
        "damage": dmg,
        "target_hp": updated_target.current_hit_points,
    }


@router.post("/save")
def spell_save(req: SpellSaveRequest) -> dict:
    save, dmg, updated_target = resolve_spell_save(
        req.caster, req.target, req.spell, req.spellcasting_ability
    )
    return {
        "save": save,
        "damage": dmg,
        "target_hp": updated_target.current_hit_points,
    }
