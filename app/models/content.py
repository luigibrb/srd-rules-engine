"""Pydantic schemas for static rules content (species, classes, backgrounds, feats, items).

Content is data: it lives in YAML under ``content/`` and is validated against these models
at load time. Every top-level entity carries a stable slug ``id`` and a ``source`` tag so
SRD material can always be told apart from homebrew.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class Ability(StrEnum):
    STR = "str"
    DEX = "dex"
    CON = "con"
    INT = "int"
    WIS = "wis"
    CHA = "cha"

    @property
    def full_name(self) -> str:
        return _ABILITY_NAMES[self]


_ABILITY_NAMES = {
    Ability.STR: "Strength",
    Ability.DEX: "Dexterity",
    Ability.CON: "Constitution",
    Ability.INT: "Intelligence",
    Ability.WIS: "Wisdom",
    Ability.CHA: "Charisma",
}


class Skill(StrEnum):
    ACROBATICS = "acrobatics"
    ANIMAL_HANDLING = "animal-handling"
    ARCANA = "arcana"
    ATHLETICS = "athletics"
    DECEPTION = "deception"
    HISTORY = "history"
    INSIGHT = "insight"
    INTIMIDATION = "intimidation"
    INVESTIGATION = "investigation"
    MEDICINE = "medicine"
    NATURE = "nature"
    PERCEPTION = "perception"
    PERFORMANCE = "performance"
    PERSUASION = "persuasion"
    RELIGION = "religion"
    SLEIGHT_OF_HAND = "sleight-of-hand"
    STEALTH = "stealth"
    SURVIVAL = "survival"

    @property
    def ability(self) -> Ability:
        return SKILL_ABILITY[self]

    @property
    def display_name(self) -> str:
        return self.value.replace("-", " ").title().replace(" Of ", " of ")


SKILL_ABILITY: dict[Skill, Ability] = {
    Skill.ACROBATICS: Ability.DEX,
    Skill.ANIMAL_HANDLING: Ability.WIS,
    Skill.ARCANA: Ability.INT,
    Skill.ATHLETICS: Ability.STR,
    Skill.DECEPTION: Ability.CHA,
    Skill.HISTORY: Ability.INT,
    Skill.INSIGHT: Ability.WIS,
    Skill.INTIMIDATION: Ability.CHA,
    Skill.INVESTIGATION: Ability.INT,
    Skill.MEDICINE: Ability.WIS,
    Skill.NATURE: Ability.INT,
    Skill.PERCEPTION: Ability.WIS,
    Skill.PERFORMANCE: Ability.CHA,
    Skill.PERSUASION: Ability.CHA,
    Skill.RELIGION: Ability.INT,
    Skill.SLEIGHT_OF_HAND: Ability.DEX,
    Skill.STEALTH: Ability.DEX,
    Skill.SURVIVAL: Ability.WIS,
}


class Size(StrEnum):
    SMALL = "small"
    MEDIUM = "medium"


class Step(StrEnum):
    """Builder steps, in the order they are presented.

    Ordered by dependency: each step only needs what earlier steps decided. Equipment comes
    before features so Weapon Mastery / Fighting Style can be picked knowing your gear, and
    proficiencies come late so every skill grant (species, background, feats) is known before
    you spend free picks.
    """

    CLASS = "class"
    SPECIES = "species"
    BACKGROUND = "background"
    ABILITIES = "abilities"
    EQUIPMENT = "equipment"
    FEATURES = "features"
    PROFICIENCIES = "proficiencies"
    LANGUAGES = "languages"
    DETAILS = "details"


class ChoiceKind(StrEnum):
    OPTION = "option"  # pick among inline options, each with its own grants
    ABILITY = "ability"
    SKILL = "skill"
    TOOL = "tool"
    SKILL_OR_TOOL = "skill_or_tool"
    LANGUAGE = "language"
    FEAT = "feat"
    WEAPON_MASTERY = "weapon_mastery"


_DEFAULT_STEP_BY_KIND = {
    ChoiceKind.SKILL: Step.PROFICIENCIES,
    ChoiceKind.TOOL: Step.PROFICIENCIES,
    ChoiceKind.SKILL_OR_TOOL: Step.PROFICIENCIES,
    ChoiceKind.LANGUAGE: Step.LANGUAGES,
    ChoiceKind.FEAT: Step.FEATURES,
    ChoiceKind.WEAPON_MASTERY: Step.FEATURES,
}


class EffectOp(StrEnum):
    ADD = "add"
    SET = "set"
    MAX = "max"


class Effect(Frozen):
    """A declarative numeric modifier. Minimal precursor of the full Effect engine.

    ``value`` is an int or the token ``"prof"`` (Proficiency Bonus).
    ``when`` names a condition evaluated by the sheet calculator (e.g. ``"wearing_armor"``).
    """

    target: str
    op: EffectOp = EffectOp.ADD
    value: int | str
    when: str | None = None


class Trait(Frozen):
    name: str
    text: str


class ItemGrant(Frozen):
    item: str
    qty: int = Field(default=1, ge=1)


class FeatGrant(Frozen):
    feat: str
    # Pre-filled answers to the feat's own choices, e.g. {"spell_list": "cleric"}.
    params: dict[str, str] = Field(default_factory=dict)


class ChoiceOption(Frozen):
    id: str
    name: str
    description: str = ""
    grants: Grants = Field(default_factory=lambda: Grants())


class ChoiceDef(Frozen):
    id: str
    label: str
    kind: ChoiceKind
    count: int = Field(default=1, ge=1)
    options: list[ChoiceOption] = Field(default_factory=list)  # for kind=option
    allowed: list[str] | None = None  # restricts ids for other kinds; None = any
    category: str | None = None  # feat/tool/language category filter
    step: Step | None = None
    hint: str = ""

    @property
    def resolved_step(self) -> Step | None:
        return self.step or _DEFAULT_STEP_BY_KIND.get(self.kind)

    @model_validator(mode="after")
    def _options_match_kind(self) -> ChoiceDef:
        if (self.kind == ChoiceKind.OPTION) != bool(self.options):
            raise ValueError(f"choice {self.id!r}: inline options are required iff kind=option")
        return self


class Grants(Frozen):
    """Everything a content source gives the character, plus the choices it asks for."""

    size: Size | None = None
    skills: list[Skill] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    languages: list[str] = Field(default_factory=list)
    saving_throws: list[Ability] = Field(default_factory=list)
    armor_training: list[str] = Field(default_factory=list)
    weapon_proficiencies: list[str] = Field(default_factory=list)
    feats: list[FeatGrant] = Field(default_factory=list)
    resistances: list[str] = Field(default_factory=list)
    cantrips: list[str] = Field(default_factory=list)
    effects: list[Effect] = Field(default_factory=list)
    items: list[ItemGrant] = Field(default_factory=list)
    gp: int = 0
    traits: list[Trait] = Field(default_factory=list)
    choices: list[ChoiceDef] = Field(default_factory=list)


ChoiceOption.model_rebuild()


class ContentEntity(Frozen):
    id: str
    name: str
    source: str = "srd-5.2.1"
    description: str = ""


class SpeciesDef(ContentEntity):
    creature_type: str = "Humanoid"
    grants: Grants


class BackgroundDef(ContentEntity):
    ability_scores: list[Ability] = Field(min_length=3, max_length=3)
    grants: Grants


class ClassDef(ContentEntity):
    primary_abilities: list[Ability]
    primary_mode: str = "any"  # "any" (Str OR Dex) or "all" (Dex AND Wis)
    hit_die: int
    complexity: str
    standard_array: dict[Ability, int]
    grants: Grants  # level 1 grants (core traits + level 1 features)


class FeatDef(ContentEntity):
    category: str  # origin, general, fighting_style, epic_boon
    repeatable: bool = False
    # For repeatable feats: each instance must pick a different value for this choice id.
    repeat_requires_different: str | None = None
    grants: Grants = Field(default_factory=Grants)
    # Notes about parts of the feat the builder does not automate yet.
    unsupported: str = ""


class WeaponDef(ContentEntity):
    category: str  # simple | martial
    kind: str  # melee | ranged
    damage: str
    damage_type: str
    properties: list[str] = Field(default_factory=list)
    versatile_damage: str | None = None
    range: str | None = None
    mastery: str
    weight: str = ""
    cost: str = ""


class ArmorDef(ContentEntity):
    category: str  # light | medium | heavy | shield
    base_ac: int
    dex_cap: int | None = None  # None = no cap; 0 = Dex not added
    strength: int | None = None
    stealth_disadvantage: bool = False
    weight: str = ""
    cost: str = ""


class GearDef(ContentEntity):
    pass


class ToolDef(ContentEntity):
    category: str  # artisan | gaming-set | musical-instrument | other


class LanguageDef(ContentEntity):
    category: str  # standard | rare


class MasteryDef(ContentEntity):
    pass


class PointBuyRules(Frozen):
    budget: int
    min_score: int
    max_score: int
    costs: dict[int, int]


class CreationRules(Frozen):
    source: str = "srd-5.2.1"
    standard_array: list[int]
    point_buy: PointBuyRules
    max_score_at_creation: int
    base_grants: Grants
