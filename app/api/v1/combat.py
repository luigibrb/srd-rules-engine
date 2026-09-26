from fastapi import APIRouter
from pydantic import BaseModel

from app.models.character import Character
from app.models.combat import AttackRoll, DamageRoll, SavingThrow
from app.rules.combat_rules import saving_throw
from app.rules.dice import roll
from app.models.combat import RollResult
from app.services.combat_service import resolve_attack

router = APIRouter(prefix="/combat", tags=["combat"])


class RollRequest(BaseModel):
    expression: str


class AttackRequest(BaseModel):
    attacker: Character
    target: Character
    attack_bonus: int
    damage_dice: str
    damage_type: str


class SavingThrowRequest(BaseModel):
    character: Character
    ability: str
    dc: int
    proficient: bool = False


@router.post("/roll", response_model=RollResult)
def roll_dice(req: RollRequest) -> RollResult:
    return roll(req.expression)


@router.post("/attack")
def attack(req: AttackRequest) -> dict:
    atk, dmg, updated_target = resolve_attack(
        req.attacker,
        req.target,
        req.attack_bonus,
        req.damage_dice,
        req.damage_type,
    )
    return {
        "attack": atk,
        "damage": dmg,
        "target_hp": updated_target.current_hit_points,
    }


@router.post("/saving-throw", response_model=SavingThrow)
def saving_throw_route(req: SavingThrowRequest) -> SavingThrow:
    return saving_throw(req.character, req.ability, req.dc, proficient=req.proficient)
