"""Compute the derived level 1 character sheet from a (possibly partial) build.

Derived values are never stored; they are recomputed from the build every time. Each
headline number keeps its list of contributions so a UI can explain it
("AC 17 = 16 Chain Mail + 1 Defense").
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.content.catalog import Catalog
from app.models.build import CharacterBuild
from app.models.content import (
    Ability,
    ArmorDef,
    EffectOp,
    Size,
    Skill,
    Trait,
    WeaponDef,
)
from app.rules.ability_scores import final_scores
from app.rules.build_resolution import Resolution, resolve
from app.rules.dice import ability_modifier, proficiency_bonus

LEVEL = 1
DEFAULT_SCORE = 10


@dataclass(frozen=True)
class Contribution:
    source: str
    value: int


@dataclass(frozen=True)
class Stat:
    parts: tuple[Contribution, ...]

    @property
    def total(self) -> int:
        return sum(p.value for p in self.parts)

    def explain(self) -> str:
        return " ".join(
            f"{'' if i == 0 else ('+ ' if p.value >= 0 else '- ')}"
            f"{p.value if i == 0 else abs(p.value)} {p.source}"
            for i, p in enumerate(self.parts)
        )


@dataclass(frozen=True)
class SkillLine:
    skill: Skill
    modifier: int
    proficient_from: str | None


@dataclass(frozen=True)
class AttackLine:
    name: str
    attack_bonus: int
    damage: str
    damage_type: str
    mastery: str | None = None
    notes: tuple[str, ...] = ()


@dataclass(frozen=True)
class DerivedSheet:
    scores: dict[Ability, int]
    scores_complete: bool
    proficiency_bonus: int
    max_hp: Stat | None
    hit_die: int | None
    armor_class: Stat
    armor_worn: str | None
    initiative: Stat
    speed: Stat
    size: Size | None
    darkvision: int
    saving_throws: dict[Ability, tuple[int, bool]]
    skills: list[SkillLine]
    passive_perception: int
    attacks: list[AttackLine]
    tools: dict[str, str]
    languages: dict[str, str]
    resistances: list[str]
    cantrips: list[str]
    armor_training: list[str]
    weapon_proficiencies: list[str]
    feats: list[str]
    traits: list[Trait]
    weapon_masteries: list[str]
    equipment: dict[str, int]
    gp: int
    warnings: list[str] = field(default_factory=list)

    def modifier(self, ability: Ability) -> int:
        return ability_modifier(self.scores[ability])


def compute_sheet(
    build: CharacterBuild, catalog: Catalog, res: Resolution | None = None
) -> DerivedSheet:
    res = res or resolve(build, catalog)
    pb = proficiency_bonus(LEVEL)
    known = final_scores(build.base_scores, build.background_bonus)
    scores = {a: known.get(a, DEFAULT_SCORE) for a in Ability}
    mod = {a: ability_modifier(s) for a, s in scores.items()}
    cls = catalog.classes.get(build.class_id or "")
    warnings: list[str] = []

    # Equipment: fixed item grants plus chosen packages (both are option sources).
    equipment: dict[str, int] = {}
    for src in res.sources:
        for grant in src.grants.items:
            equipment[grant.item] = equipment.get(grant.item, 0) + grant.qty
    gp = sum(src.grants.gp for src in res.sources)
    training = res.granted("armor_training")

    armor, shield = _pick_armor(equipment, training, catalog, mod[Ability.DEX])
    conditions = {"wearing_armor": armor is not None}

    def effects_for(target: str) -> list[tuple[EffectOp, int, str]]:
        out = []
        for effect, source in res.effects():
            if effect.target != target:
                continue
            if effect.when is not None and not conditions.get(effect.when, False):
                continue
            value = pb if effect.value == "prof" else int(effect.value)
            out.append((effect.op, value, source))
        return out

    # Armor Class
    if armor is None:
        ac_parts = [Contribution("base (unarmored)", 10), Contribution("Dex", mod[Ability.DEX])]
    else:
        ac_parts = [Contribution(armor.name, armor.base_ac)]
        dex = mod[Ability.DEX] if armor.dex_cap is None else min(mod[Ability.DEX], armor.dex_cap)
        if armor.dex_cap != 0:
            cap = "" if armor.dex_cap is None else f" (max {armor.dex_cap})"
            ac_parts.append(Contribution(f"Dex{cap}", dex))
    if shield is not None:
        ac_parts.append(Contribution(shield.name, shield.base_ac))
    ac_parts += [Contribution(src, v) for op, v, src in effects_for("ac") if op == EffectOp.ADD]

    # Hit points
    max_hp = None
    if cls is not None:
        hp_parts = [
            Contribution(f"{cls.name} d{cls.hit_die}", cls.hit_die),
            Contribution("Con", mod[Ability.CON]),
        ]
        hp_parts += [Contribution(s, v * LEVEL) for _, v, s in effects_for("hp_per_level")]
        max_hp = Stat(tuple(hp_parts))

    # Initiative
    init_parts = [Contribution("Dex", mod[Ability.DEX])]
    init_parts += [
        Contribution(s, v) for op, v, s in effects_for("initiative") if op == EffectOp.ADD
    ]

    # Speed: base from `set`, raised by `max`, then flat adjustments.
    speed_value, speed_source = 30, "default"
    for op, v, s in effects_for("speed"):
        if op == EffectOp.SET or (op == EffectOp.MAX and v > speed_value):
            speed_value, speed_source = v, s
    speed_parts = [Contribution(speed_source, speed_value)]
    if armor is not None and armor.strength and scores[Ability.STR] < armor.strength:
        speed_parts.append(Contribution(f"{armor.name} (Str < {armor.strength})", -10))
        warnings.append(
            f"{armor.name} needs Strength {armor.strength}: your Speed drops by 10 ft "
            f"(Strength is {scores[Ability.STR]})."
        )
    if armor is not None and armor.stealth_disadvantage:
        warnings.append(f"{armor.name} gives Disadvantage on Dexterity (Stealth) checks.")

    darkvision = max((v for _, v, _ in effects_for("darkvision")), default=0)

    # Saves and skills
    save_profs = res.saving_throws()
    saves = {a: (mod[a] + (pb if a in save_profs else 0), a in save_profs) for a in Ability}
    owned_skills = res.skills()
    skills = [
        SkillLine(s, mod[s.ability] + (pb if s in owned_skills else 0), owned_skills.get(s))
        for s in Skill
    ]
    perception = next(line for line in skills if line.skill == Skill.PERCEPTION)

    masteries = res.weapon_masteries()
    attacks = _attacks(
        equipment,
        catalog,
        scores,
        pb,
        res.granted("weapon_proficiencies"),
        masteries,
        effects_for("attack.ranged"),
        {s.feat.id for s in res.feat_sources()},
    )

    size = None
    for src in res.sources:
        size = src.grants.size or size

    traits: list[Trait] = []
    for src in res.sources:
        if src.feat is None and src.key != "creation":
            traits += src.grants.traits

    return DerivedSheet(
        scores=scores,
        scores_complete=len(known) == len(Ability),
        proficiency_bonus=pb,
        max_hp=max_hp,
        hit_die=cls.hit_die if cls else None,
        armor_class=Stat(tuple(ac_parts)),
        armor_worn=armor.name if armor else None,
        initiative=Stat(tuple(init_parts)),
        speed=Stat(tuple(speed_parts)),
        size=size,
        darkvision=darkvision,
        saving_throws=saves,
        skills=skills,
        passive_perception=10 + perception.modifier,
        attacks=attacks,
        tools=res.tools(),
        languages=res.languages(),
        resistances=res.granted("resistances"),
        cantrips=res.granted("cantrips"),
        armor_training=training,
        weapon_proficiencies=res.granted("weapon_proficiencies"),
        feats=[s.name for s in res.feat_sources()],
        traits=traits,
        weapon_masteries=masteries,
        equipment=equipment,
        gp=gp,
        warnings=warnings,
    )


def _pick_armor(
    equipment: dict[str, int], training: list[str], catalog: Catalog, dex_mod: int
) -> tuple[ArmorDef | None, ArmorDef | None]:
    """Assume the character wears the best armor they own and are trained in."""
    owned = [catalog.armor[i] for i in equipment if i in catalog.armor]
    body = [a for a in owned if a.category != "shield" and a.category in training]

    def ac(a: ArmorDef) -> int:
        dex = dex_mod if a.dex_cap is None else min(dex_mod, a.dex_cap)
        return a.base_ac + dex

    best = max(body, key=ac, default=None)
    if best is not None and ac(best) <= 10 + dex_mod:
        best = None
    shield = next((a for a in owned if a.category == "shield" and "shield" in training), None)
    return best, shield


def _attacks(
    equipment: dict[str, int],
    catalog: Catalog,
    scores: dict[Ability, int],
    pb: int,
    weapon_profs: list[str],
    masteries: list[str],
    ranged_bonus: list[tuple[EffectOp, int, str]],
    feats: set[str],
) -> list[AttackLine]:
    str_mod = ability_modifier(scores[Ability.STR])
    lines = [
        AttackLine("Unarmed Strike", str_mod + pb, str(max(0, 1 + str_mod)), "bludgeoning"),
    ]
    for item_id in equipment:
        weapon = catalog.weapons.get(item_id)
        if weapon is not None:
            lines.append(
                _attack_line(
                    weapon, catalog, scores, pb, weapon_profs, masteries, ranged_bonus, feats
                )
            )
    return lines


def _attack_line(
    w: WeaponDef,
    catalog: Catalog,
    scores: dict[Ability, int],
    pb: int,
    weapon_profs: list[str],
    masteries: list[str],
    ranged_bonus: list[tuple[EffectOp, int, str]],
    feats: set[str],
) -> AttackLine:
    str_mod = ability_modifier(scores[Ability.STR])
    dex_mod = ability_modifier(scores[Ability.DEX])
    if "finesse" in w.properties:
        ability_mod = max(str_mod, dex_mod)
    else:
        ability_mod = dex_mod if w.kind == "ranged" else str_mod
    proficient = w.category in weapon_profs
    bonus = ability_mod + (pb if proficient else 0)
    notes: list[str] = []
    if w.kind == "ranged":
        bonus += sum(v for _, v, _ in ranged_bonus)
    if not proficient:
        notes.append("not proficient")
    if "heavy" in w.properties:
        needed = Ability.STR if w.kind == "melee" else Ability.DEX
        if scores[needed] < 13:
            notes.append(f"Disadvantage (Heavy, {needed.full_name} < 13)")
    if w.range:
        notes.append(f"range {w.range}")
    two_handed_melee = w.kind == "melee" and (
        "two-handed" in w.properties or "versatile" in w.properties
    )
    if "great-weapon-fighting" in feats and two_handed_melee:
        notes.append("GWF: treat 1-2 on damage dice as 3 (two hands)")
    damage = _with_mod(w.damage, ability_mod)
    if w.versatile_damage:
        damage += f" ({_with_mod(w.versatile_damage, ability_mod)} two-handed)"
    mastery = catalog.masteries[w.mastery].name if w.id in masteries else None
    return AttackLine(w.name, bonus, damage, w.damage_type, mastery, tuple(notes))


def _with_mod(dice: str, mod: int) -> str:
    return dice if mod == 0 else f"{dice}{mod:+d}"
