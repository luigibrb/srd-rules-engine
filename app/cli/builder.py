"""Interactive level 1 character builder.

Run with ``uv run python -m app.cli.builder``. The shell is a thin UI over
``app.services.builder_service``: every choice goes through a validated setter, and the
character panel is recomputed from scratch after each change.
"""

from __future__ import annotations

import argparse
import random
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from app.cli.console import BackToMenu, Console, QuitBuilder
from app.cli.render import render_menu, render_panel, render_sheet, shorten, signed
from app.content.catalog import Catalog, default_catalog
from app.models.build import AbilityMethod, Alignment, CharacterBuild
from app.models.content import Ability, ChoiceKind, Skill, Step
from app.rules.ability_scores import (
    point_buy_status,
    roll_ability_scores,
    unassigned_values,
)
from app.rules.build_resolution import ActiveChoice, OptionView, resolve
from app.rules.build_validation import Severity
from app.rules.dice import ability_modifier
from app.rules.sheet import DerivedSheet, compute_sheet
from app.services import builder_service as svc
from app.services.builder_service import STEP_TITLES, BuildError, evaluate

_SKILLS = {s.value for s in Skill}


@dataclass(frozen=True)
class Row:
    id: str
    label: str
    extra: str = ""
    unavailable: str | None = None
    details: str = ""


class BuilderApp:
    def __init__(
        self,
        console: Console,
        catalog: Catalog,
        build: CharacterBuild | None = None,
        rng: random.Random | None = None,
        save_dir: Path = Path("characters"),
    ):
        self.con = console
        self.catalog = catalog
        self.build = build or CharacterBuild()
        self.rng = rng or random.Random()
        self.save_dir = save_dir
        self.dirty = False

    # --- main loop ----------------------------------------------------------------------

    def run(self) -> CharacterBuild:
        con = self.con
        con.title("D&D 2024 Character Builder · Level 1 · SRD 5.2.1")
        con.info("Work through the steps in order, or jump to any step by number.")
        con.info("At any prompt: 'back' returns to this menu, 'quit' exits.")
        try:
            while True:
                self.hub()
        except QuitBuilder:
            self.on_quit()
        return self.build

    def hub(self) -> None:
        ev = evaluate(self.build, self.catalog)
        self.con.say()
        render_panel(ev, self.con, self.catalog)
        render_menu(ev, self.con, self.catalog)
        nxt = ev.next_incomplete_step()
        default = STEP_TITLES[nxt] if nxt else "Review & save"
        try:
            answer = self.con.ask(f"Step number, 'sheet', 'save' or Enter for {default} >")
        except BackToMenu:
            return
        steps = list(Step)
        if not answer:
            self.run_step(nxt) if nxt else self.review()
        elif answer.isdigit() and 1 <= int(answer) <= len(steps):
            self.run_step(steps[int(answer) - 1])
        elif answer.isdigit() and int(answer) == len(steps) + 1:
            self.review()
        elif answer.lower() == "sheet":
            render_sheet(ev, self.con, self.catalog)
        elif answer.lower() == "save":
            self.save()
        else:
            self.con.error(f"Unknown command {answer!r}")

    def run_step(self, step: Step) -> None:
        handlers: dict[Step, Callable[[], None]] = {
            Step.CLASS: self.step_class,
            Step.SPECIES: self.step_species,
            Step.BACKGROUND: self.step_background,
            Step.ABILITIES: self.step_abilities,
            Step.EQUIPMENT: lambda: self.step_choices(Step.EQUIPMENT),
            Step.FEATURES: self.step_features,
            Step.PROFICIENCIES: self.step_proficiencies,
            Step.LANGUAGES: lambda: self.step_choices(Step.LANGUAGES),
            Step.DETAILS: self.step_details,
        }
        self.con.title(STEP_TITLES[step])
        try:
            handlers[step]()
        except BackToMenu:
            pass

    def on_quit(self) -> None:
        if self.dirty:
            try:
                if self.con.confirm("Save your character before quitting?", default=True):
                    self.save()
            except (QuitBuilder, BackToMenu):
                pass
        self.con.say("Farewell, adventurer.")

    # --- helpers ------------------------------------------------------------------------

    def apply(self, setter: Callable, *args) -> bool:
        try:
            self.build, notes = setter(self.build, self.catalog, *args)
        except BuildError as exc:
            for message in exc.messages:
                self.con.error(message)
            return False
        for note in notes:
            self.con.warn(note)
        self.dirty = True
        return True

    def sheet(self, build: CharacterBuild | None = None) -> DerivedSheet:
        return compute_sheet(build or self.build, self.catalog)

    def select(
        self,
        rows: Sequence[Row],
        count: int = 1,
        current: Sequence[str] = (),
        hint: str = "",
    ) -> list[str]:
        """Show numbered rows and read ``count`` picks. Enter keeps a complete current pick."""
        con = self.con
        for i, row in enumerate(rows, 1):
            chosen = "◉" if row.id in current else " "
            label = f"{row.label:<24}"
            if row.unavailable:
                line = f" {chosen} {i:>2}. {label} ✘ {row.unavailable}"
                con.say(con.style(line, "dim"))
            else:
                extra = f" {con.style(row.extra, 'dim')}" if row.extra else ""
                con.say(f" {con.style(chosen, 'green')} {i:>2}. {label}{extra}")
        if hint:
            con.info(hint)
        ids = {r.id for r in rows}
        keep = len(current) == count and all(c in ids for c in current)
        what = "one number" if count == 1 else f"{count} numbers, e.g. '1 4'"
        prompt = f"Choose {what}{' (Enter keeps current)' if keep else ''}, '?N' for details >"
        while True:
            answer = con.ask(prompt)
            if not answer and keep:
                return list(current)
            if answer.startswith("?") and answer[1:].strip().isdigit():
                n = int(answer[1:])
                if 1 <= n <= len(rows):
                    row = rows[n - 1]
                    con.say(con.style(row.label, "bold"))
                    for line in (row.details or row.extra or "No details.").splitlines():
                        con.say(f"  {line}")
                continue
            tokens = [t for t in re.split(r"[,\s]+", answer) if t]
            if not tokens or not all(t.isdigit() and 1 <= int(t) <= len(rows) for t in tokens):
                con.error(f"Enter {what} between 1 and {len(rows)}")
                continue
            picked = [rows[int(t) - 1] for t in tokens]
            if len({r.id for r in picked}) != len(picked):
                con.error("Each option can be chosen only once")
                continue
            if len(picked) != count:
                con.error(f"Choose exactly {count}")
                continue
            blocked = [r for r in picked if r.unavailable]
            if blocked:
                for r in blocked:
                    con.error(f"{r.label}: {r.unavailable}")
                continue
            return [r.id for r in picked]

    # --- generic choices ----------------------------------------------------------------

    def step_choices(self, step: Step) -> None:
        visited: set[str] = set()
        any_choice = False
        while True:
            res = resolve(self.build, self.catalog)
            todo = [c for c in res.choices_for_step(step) if c.key not in visited]
            if not todo:
                break
            any_choice = True
            self.run_choice(todo[0])
            visited.add(todo[0].key)
        if not any_choice:
            self.con.info("Nothing to choose here yet — pick your class, species and background.")

    def run_choice(self, choice: ActiveChoice) -> None:
        res = resolve(self.build, self.catalog)
        d = choice.definition
        count = f" (choose {d.count})" if d.count > 1 else ""
        self.con.say()
        src = choice.source
        via = f" (via {src.granted_by})" if src.granted_by else ""
        self.con.say(self.con.style(f"{choice.label}{count}", "bold") + f"  — from {src.name}{via}")
        rows = [self.choice_row(choice, view) for view in res.options(choice)]
        while True:
            picked = self.select(rows, d.count, res.selected(choice), d.hint)
            if self.apply(svc.set_choice, choice.key, picked):
                return

    def choice_row(self, choice: ActiveChoice, view: OptionView) -> Row:
        kind = choice.definition.kind
        sheet = self.sheet()
        extra, details = view.description, view.description
        if kind in (ChoiceKind.SKILL, ChoiceKind.SKILL_OR_TOOL) and view.id in _SKILLS:
            skill = Skill(view.id)
            mod = sheet.modifier(skill.ability) + sheet.proficiency_bonus
            extra = f"{skill.ability.value.upper()} · {signed(mod)} when proficient"
        elif kind == ChoiceKind.ABILITY:
            a = Ability(view.id)
            extra = f"your {a.full_name} is {sheet.scores[a]} ({signed(sheet.modifier(a))})"
        elif kind == ChoiceKind.WEAPON_MASTERY:
            w = self.catalog.weapons[view.id]
            carried = "★ in your gear · " if view.id in sheet.equipment else ""
            props = ", ".join(w.properties) or "no properties"
            extra = f"{carried}{w.category} {w.kind}, {w.damage} {w.damage_type}"
            details = f"{w.name}: {w.damage} {w.damage_type} · {props}\n{view.description}"
        elif kind in (ChoiceKind.FEAT, ChoiceKind.OPTION) and choice.definition.count == 1:
            preview = self.preview(choice, view.id)
            short = shorten(view.description)
            extra = " · ".join(x for x in (preview, short) if x)
        return Row(view.id, view.name, extra, view.unavailable, details)

    def preview(self, choice: ActiveChoice, option_id: str) -> str:
        """What picking this option changes on the sheet, e.g. 'AC 16→17'."""
        without = {k: v for k, v in self.build.choices.items() if k != choice.key}
        before = self.sheet(self.build.model_copy(update={"choices": without}))
        after = self.sheet(
            self.build.model_copy(update={"choices": {**without, choice.key: [option_id]}})
        )
        if not after.scores_complete:
            return ""
        changes = []
        for label, a, b in (
            ("AC", before.armor_class.total, after.armor_class.total),
            ("HP", _hp(before), _hp(after)),
            ("Init", before.initiative.total, after.initiative.total),
            ("Speed", before.speed.total, after.speed.total),
        ):
            if a != b:
                changes.append(f"{label} {a}→{b}")
        new_warnings = [w for w in after.warnings if w not in before.warnings]
        changes += [f"⚠ {w.split(':')[0]}" for w in new_warnings if "Speed" in w]
        if choice.step == Step.EQUIPMENT and not changes:
            changes.append(f"AC {after.armor_class.total}")
        return self.con.style(", ".join(changes), "cyan") if changes else ""

    # --- steps --------------------------------------------------------------------------

    def step_class(self) -> None:
        rows = []
        for cls in self.catalog.classes.values():
            primary = f" {'or' if cls.primary_mode == 'any' else 'and'} ".join(
                a.full_name for a in cls.primary_abilities
            )
            saves = ", ".join(a.full_name for a in cls.grants.saving_throws)
            traits = "\n".join(f"{t.name}: {t.text}" for t in cls.grants.traits)
            rows.append(
                Row(
                    cls.id,
                    cls.name,
                    f"Primary {primary} · Hit Die d{cls.hit_die} · Complexity {cls.complexity}",
                    details=f"{cls.description}\nSaving throws: {saves}\n{traits}",
                )
            )
        current = [self.build.class_id] if self.build.class_id else []
        picked = self.select(rows, 1, current)
        self.apply(svc.set_class, picked[0])
        if len(self.catalog.classes) == 1:
            self.con.info("More classes will appear as they're added under content/*/classes/.")

    def step_species(self) -> None:
        rows = []
        for sp in self.catalog.species.values():
            g = sp.grants
            speed = next((e.value for e in g.effects if e.target == "speed"), 30)
            dv = next((e.value for e in g.effects if e.target == "darkvision"), 0)
            size = g.size.value.title() if g.size else "Small/Medium"
            senses = f" · Darkvision {dv}" if dv else ""
            traits = "\n".join(f"{t.name}: {t.text}" for t in g.traits)
            choices = ", ".join(c.label for c in g.choices)
            rows.append(
                Row(
                    sp.id,
                    sp.name,
                    f"{size} · Speed {speed}{senses} · {sp.description}",
                    details=f"{sp.description}\n{traits}\nChoices: {choices or 'none'}",
                )
            )
        current = [self.build.species_id] if self.build.species_id else []
        picked = self.select(rows, 1, current)
        if self.apply(svc.set_species, picked[0]):
            self.step_choices(Step.SPECIES)

    def step_background(self) -> None:
        cls = self.catalog.classes.get(self.build.class_id or "")
        primaries = set(cls.primary_abilities) if cls else set()
        rows = []
        for bg in self.catalog.backgrounds.values():
            abilities = ", ".join(
                f"{a.value.upper()}{'★' if a in primaries else ''}" for a in bg.ability_scores
            )
            feats = ", ".join(self.catalog.feats[f.feat].name for f in bg.grants.feats)
            skills = ", ".join(s.display_name for s in bg.grants.skills)
            tools = ", ".join(self.catalog.tools[t].name for t in bg.grants.tools) or "your choice"
            rows.append(
                Row(
                    bg.id,
                    bg.name,
                    f"{abilities} · Feat {feats} · {skills}",
                    details=(
                        f"{bg.description}\nAbility scores: "
                        f"{', '.join(a.full_name for a in bg.ability_scores)}\n"
                        f"Feat: {feats}\nSkills: {skills}\n"
                        f"Tool: {tools}"
                    ),
                )
            )
        hint = f"★ = your {cls.name}'s primary ability" if cls else ""
        current = [self.build.background_id] if self.build.background_id else []
        picked = self.select(rows, 1, current, hint)
        self.apply(svc.set_background, picked[0])

    # --- ability scores -----------------------------------------------------------------

    def step_abilities(self) -> None:
        con, rules = self.con, self.catalog.creation
        if not self.build.class_id:
            con.warn("Tip: choose a class first to get recommendations.")
        array = ", ".join(map(str, rules.standard_array))
        rows = [
            Row(AbilityMethod.STANDARD_ARRAY, "Standard Array", f"assign {array}"),
            Row(AbilityMethod.POINT_BUY, "Point Buy", f"spend {rules.point_buy.budget} points"),
            Row(AbilityMethod.ROLL, "Roll 4d6", "drop the lowest die, six times"),
        ]
        current = [self.build.ability_method] if self.build.ability_method else []
        method = AbilityMethod(self.select(rows, 1, current)[0])
        if method != self.build.ability_method or not self.build.base_scores:
            pool = self.roll_pool() if method == AbilityMethod.ROLL else ()
            self.apply(svc.set_ability_method, method, pool)
        if method == AbilityMethod.POINT_BUY:
            self.point_buy_editor()
        else:
            self.assign_editor()
        self.bonus_editor()

    def roll_pool(self) -> list[int]:
        while True:
            rolls = roll_ability_scores(self.rng)
            for r in rolls:
                dice = " ".join(str(d) for d in r.rolls)
                self.con.say(
                    f"  [{dice}] drop {r.dropped} → {self.con.style(str(r.total), 'bold')}"
                )
            self.con.say(f"  Total {sum(r.total for r in rolls)}")
            if self.con.confirm("Keep these rolls? (n rerolls — check with your GM)"):
                return [r.total for r in rolls]

    def _primaries(self) -> set[Ability]:
        cls = self.catalog.classes.get(self.build.class_id or "")
        return set(cls.primary_abilities) if cls else set()

    def _suggestion(self, pool: Sequence[int]) -> dict[Ability, int] | None:
        """Map the class's recommended standard array onto any pool of six values."""
        cls = self.catalog.classes.get(self.build.class_id or "")
        if cls is None:
            return None
        ranked = sorted(Ability, key=lambda a: -cls.standard_array[a])
        return dict(zip(ranked, sorted(pool, reverse=True), strict=True))

    def assign_editor(self) -> None:
        con, rules = self.con, self.catalog.creation
        method = self.build.ability_method
        pool = (
            rules.standard_array
            if method == AbilityMethod.STANDARD_ARRAY
            else self.build.rolled_pool
        )
        suggestion = self._suggestion(pool)
        primaries = self._primaries()
        while True:
            scores = dict(self.build.base_scores)
            free = unassigned_values(method, scores, rules, self.build.rolled_pool)
            con.say()
            for a in Ability:
                star = "★" if a in primaries else " "
                value = (
                    f"{scores[a]:>2} ({signed(ability_modifier(scores[a]))})"
                    if a in scores
                    else "--"
                )
                hint = f"suggested {suggestion[a]}" if suggestion else ""
                hint = con.style(hint, "dim")
                con.say(f"  {star} {a.value.upper()} {a.full_name:<13} {value:<8} {hint}")
            con.say(f"  Unassigned: {' '.join(map(str, free)) or 'none'}")
            answer = con.ask(
                "Assign with 'str 15', 'swap str dex', 'suggest', 'clear', Enter when done >"
            ).lower()
            if not answer:
                if free:
                    con.error("Assign every value first")
                    continue
                return
            if answer == "suggest":
                if suggestion is None:
                    con.error("Choose a class to get a suggestion")
                else:
                    self.apply(svc.set_base_scores, suggestion)
                continue
            if answer == "clear":
                self.apply(svc.set_base_scores, {})
                continue
            parts = answer.split()
            if len(parts) == 3 and parts[0] == "swap":
                a, b = _parse_ability(parts[1]), _parse_ability(parts[2])
                if a and b and a in scores and b in scores:
                    scores[a], scores[b] = scores[b], scores[a]
                    self.apply(svc.set_base_scores, scores)
                else:
                    con.error("Swap two abilities that both have values")
                continue
            if len(parts) == 2 and parts[1].isdigit():
                ability, value = _parse_ability(parts[0]), int(parts[1])
                if ability is None:
                    con.error(f"Unknown ability {parts[0]!r}")
                    continue
                released = scores.pop(ability, None)
                available = free + ([released] if released is not None else [])
                if value not in available:
                    con.error(
                        f"{value} isn't available (unassigned: {sorted(available, reverse=True)})"
                    )
                    continue
                scores[ability] = value
                self.apply(svc.set_base_scores, scores)
                continue
            con.error("Try 'str 15', 'swap str dex', 'suggest' or 'clear'")

    def point_buy_editor(self) -> None:
        con, rules = self.con, self.catalog.creation.point_buy
        primaries = self._primaries()
        suggestion = self._suggestion(self.catalog.creation.standard_array)
        if len(self.build.base_scores) < len(Ability):
            full = {a: self.build.base_scores.get(a, rules.min_score) for a in Ability}
            self.apply(svc.set_base_scores, full)
        while True:
            scores = dict(self.build.base_scores)
            status = point_buy_status(scores, rules)
            con.say()
            con.say(
                con.style("    Ability          Score Mod  Cost  +1 costs  Max reachable", "bold")
            )
            for a in Ability:
                st = status.abilities[a]
                star = "★" if a in primaries else " "
                inc = "at max" if st.increase_cost is None else f"{st.increase_cost} pt"
                if st.increase_cost is not None and not st.can_increase:
                    inc = con.style(f"{inc} ✘", "red")
                con.say(
                    f"  {star} {a.value.upper()} {a.full_name:<13} {st.score:>3} "
                    f"{signed(ability_modifier(st.score)):>4} {st.cost:>5}  {inc:<9} "
                    f"{st.max_affordable:>6}"
                )
            left = con.style(str(status.remaining), "green" if status.remaining else "bold")
            con.say(f"  Points spent {status.spent}/{status.budget} · {left} left")
            answer = (
                con.ask("'+str' / '-dex' / 'con 14', 'suggest', 'reset', Enter when done >")
                .lower()
                .replace(" ", "")
            )
            if not answer:
                if status.remaining and not con.confirm(
                    f"{status.remaining} points unspent. Finish anyway?", default=False
                ):
                    continue
                return
            if answer == "reset":
                self.apply(svc.set_base_scores, {a: rules.min_score for a in Ability})
                continue
            if answer == "suggest":
                if suggestion is None:
                    con.error("Choose a class to get a suggestion")
                else:
                    self.apply(svc.set_base_scores, suggestion)
                continue
            m = re.fullmatch(r"([+-])([a-z]+)|([a-z]+)(\d+)", answer)
            ability = _parse_ability((m.group(2) or m.group(3)) if m else "")
            if ability is None:
                con.error("Try '+str', '-dex' or 'con 14'")
                continue
            if m.group(1):
                target = scores[ability] + (1 if m.group(1) == "+" else -1)
            else:
                target = int(m.group(4))
            if not rules.min_score <= target <= rules.max_score:
                con.error(f"Point buy scores range from {rules.min_score} to {rules.max_score}")
                continue
            new_cost = status.spent - rules.costs[scores[ability]] + rules.costs[target]
            if new_cost > rules.budget:
                con.error(
                    f"{ability.full_name} {target} needs {new_cost - status.spent} more points; "
                    f"you have {status.remaining} "
                    f"(max reachable: {status.abilities[ability].max_affordable})"
                )
                continue
            scores[ability] = target
            self.apply(svc.set_base_scores, scores)

    def bonus_editor(self) -> None:
        con = self.con
        bg = self.catalog.backgrounds.get(self.build.background_id or "")
        if bg is None:
            con.warn("Choose a background to apply its ability score increases.")
            return
        base = self.build.base_scores
        if len(base) < len(Ability):
            return
        cap = self.catalog.creation.max_score_at_creation
        primaries = self._primaries()
        names = ", ".join(a.full_name for a in bg.ability_scores)
        con.say()
        con.say(con.style(f"{bg.name} ability score increases", "bold") + f" — {names}")
        current = self.build.background_bonus
        current_pattern = []
        if current:
            current_pattern = ["2-1" if sorted(current.values()) == [1, 2] else "1-1-1"]
        pattern = self.select(
            [
                Row("2-1", "+2 and +1", "focus: push one score higher"),
                Row("1-1-1", "+1 / +1 / +1", "spread: good for evening out odd scores"),
            ],
            1,
            current_pattern,
        )[0]
        if pattern == "1-1-1":
            self.apply(svc.set_background_bonus, {a: 1 for a in bg.ability_scores})
            return

        def rows(inc: int, options: Sequence[Ability]) -> list[Row]:
            out = []
            for a in options:
                before, after = base[a], base[a] + inc
                mods = f"{signed(ability_modifier(before))} → {signed(ability_modifier(after))}"
                change = f"{before} → {after} ({mods})"
                gain = (
                    " · raises modifier"
                    if ability_modifier(after) > ability_modifier(before)
                    else ""
                )
                star = " · ★ primary" if a in primaries else ""
                blocked = f"can't exceed {cap}" if after > cap else None
                out.append(Row(a.value, a.full_name, change + gain + star, blocked))
            return out

        con.say("Which ability gets +2?")
        plus2 = Ability(
            self.select(
                rows(2, bg.ability_scores), 1, [a.value for a, v in current.items() if v == 2]
            )[0]
        )
        con.say("Which ability gets +1?")
        others = [a for a in bg.ability_scores if a != plus2]
        plus1 = Ability(
            self.select(
                rows(1, others), 1, [a.value for a, v in current.items() if v == 1 and a != plus2]
            )[0]
        )
        self.apply(svc.set_background_bonus, {plus2: 2, plus1: 1})

    # --- features / proficiencies / details ---------------------------------------------

    def step_features(self) -> None:
        res = resolve(self.build, self.catalog)
        for src in res.feat_sources():
            if "#" not in src.key.split("@", 1)[1]:  # granted outright, not chosen here
                self.con.info(f"{src.name} (from {src.granted_by}): {src.feat.description}")
        for issue in evaluate(self.build, self.catalog).report.for_step(Step.FEATURES):
            if issue.severity == Severity.NOTE:
                self.con.warn(issue.message)
        self.step_choices(Step.FEATURES)

    def step_proficiencies(self) -> None:
        res = resolve(self.build, self.catalog)
        owned = res.skills()
        fixed = [
            f"{s.display_name} ({src})"
            for s, src in owned.items()
            if not any(s.value in res.selected(c) for c in res.choices)
        ]
        if fixed:
            self.con.info(f"Already proficient: {', '.join(fixed)}")
        self.step_choices(Step.PROFICIENCIES)

    def step_details(self) -> None:
        con = self.con
        current = self.build.name
        while True:
            name = con.ask(f"Name{f' [{current}]' if current else ''} >") or current
            if self.apply(svc.set_name, name):
                break
        rows = [Row(a.value, a.display_name, a.value) for a in Alignment]
        current_al = [self.build.alignment.value] if self.build.alignment else []
        self.apply(svc.set_alignment, Alignment(self.select(rows, 1, current_al)[0]))

    def review(self) -> None:
        ev = evaluate(self.build, self.catalog)
        render_sheet(ev, self.con, self.catalog)
        self.con.say()
        for issue in ev.report.issues:
            where = STEP_TITLES[issue.step]
            if issue.severity == Severity.ERROR:
                self.con.error(f"[{where}] {issue.message}")
            elif issue.severity == Severity.PENDING:
                self.con.warn(f"[{where}] {issue.message}")
            else:
                self.con.info(f"[{where}] note: {issue.message}")
        if ev.report.is_complete:
            self.con.say(self.con.style("✔ Your character is complete and valid.", "green", "bold"))
            try:
                if self.con.confirm("Save it?"):
                    self.save()
            except BackToMenu:
                pass

    def save(self) -> Path:
        slug = re.sub(r"[^a-z0-9]+", "-", self.build.name.lower()).strip("-") or "character"
        self.save_dir.mkdir(parents=True, exist_ok=True)
        path = self.save_dir / f"{slug}.json"
        path.write_text(self.build.model_dump_json(indent=2), encoding="utf-8")
        self.dirty = False
        self.con.say(self.con.style(f"Saved to {path}", "green"))
        return path


def _hp(sheet: DerivedSheet) -> int:
    return sheet.max_hp.total if sheet.max_hp else 0


def _parse_ability(token: str) -> Ability | None:
    token = token.lower()
    if len(token) < 3:
        return None
    for a in Ability:
        if a.full_name.lower().startswith(token) or a.value == token:
            return a
    return None


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Interactive D&D 2024 level 1 character builder")
    parser.add_argument("--load", type=Path, help="resume a saved build (JSON)")
    parser.add_argument("--no-color", action="store_true")
    parser.add_argument("--seed", type=int, help="seed for ability score rolls")
    parser.add_argument("--save-dir", type=Path, default=Path("characters"))
    args = parser.parse_args(argv)
    build = None
    if args.load:
        build = CharacterBuild.model_validate_json(args.load.read_text(encoding="utf-8"))
    console = Console(color=False if args.no_color else None)
    app = BuilderApp(
        console,
        default_catalog(),
        build,
        rng=random.Random(args.seed),
        save_dir=args.save_dir,
    )
    app.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
