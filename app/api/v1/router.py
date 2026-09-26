from fastapi import APIRouter

from app.api.v1 import characters, combat, spells

router = APIRouter(prefix="/v1")
router.include_router(characters.router)
router.include_router(combat.router)
router.include_router(spells.router)
