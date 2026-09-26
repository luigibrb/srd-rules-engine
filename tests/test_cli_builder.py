import json
import random

from app.cli.builder import BuilderApp
from app.cli.console import Console
from app.models.build import CharacterBuild
from tests.conftest import fighter_build


def run_script(catalog, answers, tmp_path, build=None):
    feed = iter(answers)
    out: list[str] = []

    def fake_input(prompt: str) -> str:
        out.append(prompt)
        return next(feed)

    console = Console(input_fn=fake_input, output_fn=out.append, color=False)
    app = BuilderApp(console, catalog, build, rng=random.Random(1), save_dir=tmp_path)
    result = app.run()
    return result, "\n".join(out)


def test_full_session_builds_and_saves_a_valid_fighter(catalog, tmp_path):
    # fmt: off
    answers = [
        "", "1",                  # class: Fighter
        "", "3", "3", "2",        # species: Elf, Wood Elf, Wisdom
        "", "4",                  # background: Soldier
        "", "2", "suggest", "",   # abilities: point buy, class suggestion
        "1", "1", "2",            # bonus: +2 Str, +1 Con
        "", "1", "2",             # equipment: Chain Mail package, 50 GP
        "", "2", "19 16 5",       # Defense; Greatsword, Flail, Javelin
        "", "1 7", "3", "1",      # skills, Keen Senses (Survival), dice set
        "", "5 4",                # Elvish, Dwarvish
        "", "Aerin", "2",         # name, Neutral Good
        "", "y",                  # review, save
        "quit",
    ]
    # fmt: on
    build, output = run_script(catalog, answers, tmp_path)
    assert "Your character is complete and valid" in output
    assert "AC 16→17" in output  # Defense preview
    assert "already proficient from Soldier" in output  # Athletics greyed out
    saved = json.loads((tmp_path / "aerin.json").read_text())
    assert CharacterBuild.model_validate(saved) == build
    assert build.choices["class:fighter#weapon_mastery"] == ["greatsword", "flail", "javelin"]


def test_invalid_input_is_explained_and_reasked(catalog, tmp_path):
    # fmt: off
    answers = [
        "1", "1",                         # class
        "4", "2",                         # abilities: point buy
        "str 16",                         # out of range
        "str 15", "dex 15", "con 15",     # 27 points spent
        "+wis",                           # can't afford
        "",                               # finish (no background yet, bonus skipped)
        "quit", "n",
    ]
    # fmt: on
    _, output = run_script(catalog, answers, tmp_path)
    assert "Point buy scores range from 8 to 15" in output
    assert "you have 0" in output
    assert "Choose a background to apply" in output


def test_back_returns_to_menu_and_unchanged_build_quits_without_prompt(catalog, tmp_path):
    answers = ["2", "back", "quit"]
    build, output = run_script(catalog, answers, tmp_path, fighter_build(catalog))
    assert "Farewell" in output
    assert "Save your character before quitting" not in output
