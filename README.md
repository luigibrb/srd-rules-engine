# D&D Rules Engine

A D&D 2024 (5.5e) rules engine and character builder, based on the SRD 5.2.1. It's
built with Python 3.12, FastAPI and Pydantic v2 and managed with `uv`.

## Quick start

```bash
uv sync                              # install dependencies
uv run python -m app.cli.builder     # interactive level 1 character builder
uv run python main.py                # API dev server on http://localhost:8000
uv run pytest                        # tests
uv run ruff check . && uv run ruff format .
```

## Character builder

The builder is an interactive shell for creating a level 1 character. It walks you through
the steps in order: Class, Species, Background, Ability Scores, Equipment, Features, Skills &
Tools, Languages, then Name & Alignment. You can also jump to any step from the menu.

- The engine checks every choice. Options you can't take are greyed out with the reason
  ("already proficient from Soldier").
- A live panel shows HP, AC, Initiative, Speed and Passive Perception as you choose.
- Point buy shows how many points you have left and the highest score you can still reach
  for each ability.
- If you change an earlier step, any later choice it made invalid is removed, and the
  builder tells you why.
- `save` writes the build to `characters/<name>.json`. Resume it with
  `--load characters/<name>.json`.

Other options: `--seed N` makes 4d6 rolls repeatable, and `--no-color` turns off colors.

Currently covered: the Fighter class, all 9 SRD species, and all 4 SRD backgrounds.

## Layout

| Path | Contents |
|---|---|
| `app/rules/` | Pure rules logic: dice, combat, spells, ability scores, build resolution and validation, sheet |
| `app/services/` | Stateless workflows (e.g. `builder_service`) |
| `app/api/v1/` | FastAPI routes |
| `app/cli/` | Interactive builder shell |
| `content/srd-5.2.1/` | Rules content as YAML, validated at load |
| `data/srd-5-2-1/` | SRD 5.2.1 Markdown used as the rules reference (git-ignored) |
| `docs/ARCHITECTURE.md` | Design decisions |

## License and attribution

This work includes material taken from the System Reference Document 5.2.1 ("SRD 5.2.1") by
Wizards of the Coast LLC, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode).
[DATA-SOURCES.md](DATA-SOURCES.md) lists where each piece of content comes from.
