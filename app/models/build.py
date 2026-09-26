"""The character build: the player's choices, and nothing derived from them."""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from app.models.content import Ability


class AbilityMethod(StrEnum):
    STANDARD_ARRAY = "standard_array"
    POINT_BUY = "point_buy"
    ROLL = "roll"


class Alignment(StrEnum):
    LAWFUL_GOOD = "LG"
    NEUTRAL_GOOD = "NG"
    CHAOTIC_GOOD = "CG"
    LAWFUL_NEUTRAL = "LN"
    NEUTRAL = "N"
    CHAOTIC_NEUTRAL = "CN"
    LAWFUL_EVIL = "LE"
    NEUTRAL_EVIL = "NE"
    CHAOTIC_EVIL = "CE"

    @property
    def display_name(self) -> str:
        return self.name.replace("_", " ").title()


class CharacterBuild(BaseModel):
    """A (possibly incomplete) level 1 character build. Immutable: use ``model_copy``.

    ``choices`` maps an active choice key (see ``app.rules.build_resolution``) to the ids
    selected for it, e.g. ``{"class:fighter#skills": ["athletics", "perception"]}``.
    """

    model_config = ConfigDict(frozen=True)

    name: str = ""
    alignment: Alignment | None = None
    class_id: str | None = None
    species_id: str | None = None
    background_id: str | None = None
    ability_method: AbilityMethod | None = None
    rolled_pool: list[int] = Field(default_factory=list)
    base_scores: dict[Ability, int] = Field(default_factory=dict)
    background_bonus: dict[Ability, int] = Field(default_factory=dict)
    choices: dict[str, list[str]] = Field(default_factory=dict)
