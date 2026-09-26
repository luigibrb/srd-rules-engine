from fastapi import APIRouter

from app.models.character import Character
from app.services.character_service import is_alive, passive_perception

router = APIRouter(prefix="/characters", tags=["characters"])


@router.post("/", response_model=Character)
def create_character(character: Character) -> Character:
    return character


@router.post("/{name}/alive")
def check_alive(name: str, character: Character) -> dict:
    return {"name": name, "alive": is_alive(character)}


@router.post("/{name}/passive-perception")
def get_passive_perception(name: str, character: Character, proficient: bool = False) -> dict:
    return {
        "name": name,
        "passive_perception": passive_perception(character, proficient=proficient),
    }
