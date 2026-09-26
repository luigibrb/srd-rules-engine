"""Text rendering of the character panel and the full sheet."""

from __future__ import annotations

from app.cli.console import Console
from app.content.catalog import Catalog
from app.models.content import Ability, ChoiceKind, Step
from app.rules.build_validation import Severity
from app.rules.dice import ability_modifier
from app.services.builder_service import STEP_TITLES, Evaluation


def signed(n: int) -> str:
    return f"{n:+d}"


def pretty_id(item_id: str) -> str:
    return item_id.replace("-", " ").title()


def shorten(text: str, width: int = 60) -> str:
    """First sentence of ``text``, cut at a word boundary with an ellipsis if too long."""
    first = text.split(". ")[0].rstrip(".")
    if len(first) <= width:
        return first
    return first[:width].rsplit(" ", 1)[0] + "…"


def identity_line(ev: Evaluation, catalog: Catalog) -> str:
    b = ev.build
    parts = []
    species = catalog.species.get(b.species_id or "")
    cls = catalog.classes.get(b.class_id or "")
    if species:
        lineage = [src.name.split(" (")[0] for src in species_option_sources(ev)]
        parts.append(f"{species.name}{' (' + ', '.join(lineage) + ')' if lineage else ''}")
    if cls:
        parts.append(cls.name)
    who = " ".join(parts) or "New adventurer"
    bg = catalog.backgrounds.get(b.background_id or "")
    name = b.name or "(unnamed)"
    return f"{name} · Level 1 {who}{' · ' + bg.name if bg else ''}"


def ability_line(ev: Evaluation, con: Console, catalog: Catalog) -> str:
    cls = catalog.classes.get(ev.build.class_id or "")
    primaries = set(cls.primary_abilities) if cls else set()
    cells = []
    for a in Ability:
        if not ev.sheet.scores_complete and a not in ev.build.base_scores:
            cell = f"{a.value.upper()} --"
        else:
            score = ev.sheet.scores[a]
            cell = f"{a.value.upper()} {score:>2} ({signed(ability_modifier(score))})"
        cells.append(con.style(cell, "bold") if a in primaries else cell)
    return "  ".join(cells)


def render_panel(ev: Evaluation, con: Console, catalog: Catalog) -> None:
    s = ev.sheet
    con.say(con.style("╭" + "─" * 70, "dim"))
    con.say(con.style("│ ", "dim") + con.style(identity_line(ev, catalog), "bold"))
    con.say(con.style("│ ", "dim") + ability_line(ev, con, catalog))
    if s.scores_complete:
        hp = f"HP {s.max_hp.total}" if s.max_hp else "HP --"
        stats = (
            f"{hp}   AC {s.armor_class.total}   Init {signed(s.initiative.total)}   "
            f"Speed {s.speed.total} ft   Prof {signed(s.proficiency_bonus)}   "
            f"Passive Perception {s.passive_perception}"
        )
    else:
        stats = "HP, AC and other numbers appear once ability scores are set."
    con.say(con.style("│ ", "dim") + stats)
    con.say(con.style("╰" + "─" * 70, "dim"))


def step_summary(ev: Evaluation, step: Step, catalog: Catalog) -> str:
    b, res = ev.build, ev.resolution
    if step == Step.CLASS:
        return catalog.classes[b.class_id].name if b.class_id else ""
    if step == Step.BACKGROUND:
        return catalog.backgrounds[b.background_id].name if b.background_id else ""
    if step == Step.ABILITIES:
        if not b.ability_method:
            return ""
        method = b.ability_method.value.replace("_", " ")
        return f"{method}{', bonuses applied' if b.background_bonus else ''}"
    if step == Step.DETAILS:
        bits = [b.name, b.alignment.display_name if b.alignment else ""]
        return ", ".join(x for x in bits if x)
    names = []
    if step == Step.SPECIES and b.species_id:
        names.append(catalog.species[b.species_id].name)
    for choice in res.choices_for_step(step):
        views = {v.id: v.name for v in res.options(choice)}
        names += [views.get(v, v) for v in res.selected(choice)]
    return ", ".join(names)


def render_menu(ev: Evaluation, con: Console, catalog: Catalog) -> None:
    for i, step in enumerate(Step, 1):
        issues = ev.report.for_step(step)
        errors = [x for x in issues if x.severity == Severity.ERROR]
        pending = [x for x in issues if x.severity == Severity.PENDING]
        if errors:
            mark, style = "✘", "red"
        elif pending:
            mark, style = "•", "yellow"
        else:
            mark, style = "✔", "green"
        summary = step_summary(ev, step, catalog)
        extra = f" — {len(pending)} to do" if pending and summary else ""
        con.say(
            f" {i:>2}. {con.style(mark, style)} {STEP_TITLES[step]:<22} "
            f"{con.style(summary + extra, 'dim')}"
        )
    con.say(f" {len(Step) + 1:>2}. {'  Review & save'}")


def render_sheet(ev: Evaluation, con: Console, catalog: Catalog) -> None:
    s, res = ev.sheet, ev.resolution
    con.title("Character Sheet")
    con.say(con.style(identity_line(ev, catalog), "bold"))
    if ev.build.alignment:
        con.say(f"Alignment: {ev.build.alignment.display_name}")
    size = s.size.value.title() if s.size else "--"
    senses = f"Darkvision {s.darkvision} ft" if s.darkvision else "no Darkvision"
    con.say(f"Size {size} · Speed {s.speed.total} ft · {senses}")

    con.say()
    con.say(con.style("Ability         Score  Mod   Save", "bold"))
    for a in Ability:
        save, prof = s.saving_throws[a]
        mark = "●" if prof else "○"
        con.say(
            f"  {a.full_name:<13} {s.scores[a]:>5}  {signed(s.modifier(a)):>3}   "
            f"{mark} {signed(save)}"
        )

    con.say()
    con.say(con.style("Combat", "bold"))
    if s.max_hp:
        con.say(f"  Hit Points  {s.max_hp.total:>3}   = {s.max_hp.explain()}")
        con.say(f"  Hit Dice    1d{s.hit_die}")
    con.say(f"  Armor Class {s.armor_class.total:>3}   = {s.armor_class.explain()}")
    con.say(f"  Initiative  {signed(s.initiative.total):>3}   = {s.initiative.explain()}")
    con.say(f"  Speed       {s.speed.total:>3}   = {s.speed.explain()}")
    con.say(f"  Proficiency {signed(s.proficiency_bonus):>3}")
    if s.resistances:
        con.say(f"  Resistances: {', '.join(r.title() for r in s.resistances)}")

    con.say()
    con.say(con.style("Attacks", "bold"))
    for atk in s.attacks:
        mastery = f" · Mastery: {atk.mastery}" if atk.mastery else ""
        notes = f" · {'; '.join(atk.notes)}" if atk.notes else ""
        con.say(
            f"  {atk.name:<16} {signed(atk.attack_bonus):>3} to hit  "
            f"{atk.damage} {atk.damage_type}{mastery}{notes}"
        )

    con.say()
    con.say(con.style("Skills  (● proficient)", "bold"))
    for line in s.skills:
        mark = "●" if line.proficient_from else "○"
        src = f"  ({line.proficient_from})" if line.proficient_from else ""
        con.say(
            f"  {mark} {line.skill.display_name:<16} {signed(line.modifier):>3}"
            f"  {line.skill.ability.value.upper()}{con.style(src, 'dim')}"
        )
    con.say(f"  Passive Perception {s.passive_perception}")

    con.say()
    con.say(con.style("Proficiencies & Training", "bold"))
    con.say(f"  Armor:     {', '.join(t.title() for t in s.armor_training) or 'none'}")
    con.say(f"  Weapons:   {', '.join(w.title() for w in s.weapon_proficiencies) or 'none'}")
    tools = [catalog.tools[t].name if t in catalog.tools else t for t in s.tools]
    con.say(f"  Tools:     {', '.join(tools) or 'none'}")
    langs = [catalog.languages[x].name for x in s.languages if x in catalog.languages]
    con.say(f"  Languages: {', '.join(langs)}")

    masteries = [catalog.weapons[w].name for w in s.weapon_masteries if w in catalog.weapons]
    if masteries:
        con.say(f"  Weapon Mastery: {', '.join(masteries)}")

    con.say()
    con.say(con.style("Feats", "bold"))
    for src in res.feat_sources():
        con.say(f"  {src.name}: {con.style(src.feat.description, 'dim')}")
        for choice in res.choices:
            if choice.source is src and choice.definition.kind != ChoiceKind.SKILL_OR_TOOL:
                picked = res.selected(choice)
                views = {v.id: v.name for v in res.options(choice)}
                if picked:
                    con.say(f"    {choice.label}: {', '.join(views.get(p, p) for p in picked)}")

    con.say()
    con.say(con.style("Traits & Features", "bold"))
    for trait in s.traits:
        con.say(f"  {trait.name}: {con.style(trait.text, 'dim')}")
    for src in species_option_sources(ev):
        desc = f": {con.style(src.description, 'dim')}" if src.description else ""
        con.say(f"  {src.name}{desc}")
    if s.cantrips:
        con.say(f"  Cantrips: {', '.join(pretty_id(c) for c in s.cantrips)}")

    con.say()
    con.say(con.style("Equipment", "bold"))
    for item_id, qty in s.equipment.items():
        name = catalog.item(item_id).name
        con.say(f"  {qty} × {name}" if qty > 1 else f"  {name}")
    con.say(f"  {s.gp} GP")
    if s.armor_worn:
        con.info(f"(Assumes you wear your {s.armor_worn}.)")

    if s.warnings:
        con.say()
        for w in s.warnings:
            con.warn(w)


def species_option_sources(ev: Evaluation) -> list:
    """Chosen species options that define the character (lineage, ancestry), not size."""
    return [
        src
        for src in ev.resolution.sources
        if src.key.startswith("species:") and "=" in src.key and "#size=" not in src.key
    ]
