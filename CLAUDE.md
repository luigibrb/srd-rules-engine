# D&D Rules Engine — Claude Guide

## Stack
- Python 3.12+, managed with **uv**
- **FastAPI** for the HTTP API
- **Pydantic v2** for all data models
- **pytest** for tests, **ruff** for linting/formatting

## Project layout

```
app/
  main.py          # FastAPI app + /health
  api/v1/          # Route handlers (thin — delegate to services)
  cli/             # Interactive character builder shell (builder.py, render.py, console.py)
  content/         # catalog.py — loads + cross-validates content/ YAML into a Catalog
  models/          # Pydantic models: character, combat, spell, content (schemas), build
  rules/           # Pure D&D logic: dice, combat, spells, ability_scores,
                   #   build_resolution (sources/choices), build_validation, sheet
  services/        # Stateless orchestration: character, combat, spell, builder_service
content/srd-5.2.1/ # Rules content as YAML (species, backgrounds, classes/, feats, items...)
data/srd-5-2-1/    # SRD 5.2.1 Markdown: authoritative rules reference (git-ignored)
docs/              # ARCHITECTURE.md — design decisions
tests/             # pytest; mirrors app/ structure
main.py            # Dev entry point — uvicorn with reload
```

## Key conventions

- **rules/** is pure logic, no FastAPI types. Services compose rules into workflows.
- Models are **immutable**; mutations return `model_copy(update={...})`.
- All dice functions accept an optional `rng: random.Random` for deterministic tests.
- D&D 5e rule: critical hits double all dice (not just the first); nat-1 always misses; nat-20 always hits.
- Saving throw damage: half on success, full on failure (standard 5e).
- Rules content is data: YAML in `content/`, every entity has a slug `id` and a `source`
  (`srd-5.2.1`, `homebrew`, ...). Add classes as `content/srd-5.2.1/classes/<id>.yaml`.
- Character builder: a `CharacterBuild` stores only choices; `choices` is keyed by choice key
  (`<source key>#<choice id>`, e.g. `class:fighter#skills`). Derived values (HP, AC, ...) are
  always recomputed by `rules/sheet.py`, never stored. See `docs/ARCHITECTURE.md`.

## Common commands

```bash
uv run pytest              # run tests
uv run ruff check .        # lint
uv run ruff format .       # format
uv run python main.py      # dev server (localhost:8000)
uv run python -m app.cli.builder   # interactive level 1 character builder
                                   #   --load characters/x.json · --seed N · --no-color
```

## API base

`GET /health` — liveness check  
`POST /v1/characters/` — echo/validate a `Character`  
`POST /v1/characters/{name}/alive` — is the character above 0 HP  
`POST /v1/characters/{name}/passive-perception` — passive Perception (`?proficient=true`)  
`POST /v1/combat/roll` — roll any dice expression (`{"expression": "2d6+3"}`)  
`POST /v1/combat/attack` — full attack resolution  
`POST /v1/combat/saving-throw` — saving throw  
`POST /v1/spells/stats` — spell save DC + attack bonus  
`POST /v1/spells/attack` — spell attack  
`POST /v1/spells/save` — save-based spell  
