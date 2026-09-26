# SRD Rules Engine — Claude Guide

## Stack
- TypeScript (strict, `noUncheckedIndexedAccess`), Node ≥ 22.18 for development, ESM-first
- **Zod v4** for all schemas (content, builds, API payloads); types are inferred from schemas
- **vitest** for tests, **Biome** for lint + format, **tsdown** for the build (ESM + CJS + d.ts)
- No runtime dependencies besides `zod` and `yaml`

## Project layout

```
src/
  index.ts         # public API (platform-neutral: no node:* imports)
  node.ts          # index + loadContentPack/loadCatalog + serveNode
  models/          # Zod schemas + types: content, build, character, combat, spell
  content/         # catalog.ts (createCatalog, lookup), load.ts (fs, Node only), srd.ts (bundled SRD)
  content/data/    # GENERATED srd-5.2.1.json — do not edit, run `npm run content`
  rules/           # pure logic: dice, rng, ability-scores, combat, spells,
                   #   build-resolution, build-validation, sheet
  services/        # builder.ts (setters + normalize + evaluate), combat.ts (HP, attacks, spells)
  http/            # index.ts: fetch handler (platform-neutral); node-server.ts: node:http adapter
  cli/             # srd-rules bin: build (interactive builder), serve, validate
content/srd-5.2.1/ # rules content as YAML (source of truth)
schemas/           # GENERATED JSON Schemas for content files and builds
scripts/           # compile-content.ts; import-srd-spells.ts (one-off SRD Markdown → spells.yaml)
examples/          # homebrew-pack (tested in tests/content.test.ts)
data/srd-5-2-1/    # SRD 5.2.1 Markdown: authoritative rules reference (git-ignored)
docs/              # ARCHITECTURE.md (design decisions), CONTENT.md (authoring guide)
tests/             # vitest; classes.test.ts: every class × species × background must complete
```

## Key conventions

- **rules/** is pure logic: no I/O. `src/index.ts` and `src/http/` must stay platform-neutral.
- Data is **immutable** and **snake_case** (shared wire/file format); functions are camelCase.
  Builds change via `updateBuild(build, {...})`; setters return `{ build, notes }`.
- Look up catalog ids with `lookup(table, id)` (never `table[id]` / `id in table`).
- All dice functions take an optional `Rng` (`{ rng }` options bag); tests use
  `seededRng`, `scriptedRng`, `fixedRng`.
- D&D 5e rule: critical hits double all dice (not the modifier); nat-1 always misses; nat-20 always hits.
- Saving throw damage: half (rounded down) on success, full on failure.
- Rules content is data: every entity has a slug `id` and a `source`. After editing
  `content/`, run `npm run content` and commit the generated files.
- A new class feature should be data first (grants, choice kinds, effects, `ac_calculations`);
  add a named rule in `rules/sheet.ts` only when it can't be expressed declaratively, and list
  it under "Named rules in code" in `docs/ARCHITECTURE.md`.
- Character builder: a `CharacterBuild` stores only choices, keyed by choice key
  (`<source key>#<choice id>`, e.g. `class:fighter#skills`). Derived values are always
  recomputed by `rules/sheet.ts`, never stored. See `docs/ARCHITECTURE.md`.

## Common commands

```bash
npm test                 # run tests
npm run check            # content up to date + lint + typecheck + tests (CI)
npm run format           # biome format + safe fixes
npm run content          # YAML → bundled JSON + JSON Schemas
npm run build            # dist/
npm run builder          # interactive builder from source (-- --load x.json --seed N --no-color)
npx tsx src/cli/main.ts validate examples/homebrew-pack   # validate a content pack
npm run serve            # HTTP API on localhost:8000
```

## Where things go

- New rules logic → `src/rules/` (pure functions, optional `{ rng }`), exported from `src/index.ts`.
- New content (class, feat, species…) → YAML in `content/srd-5.2.1/` (SRD only; homebrew needs its
  own `source` and folder), then `npm run content` and a concrete-character test in `tests/sheet.test.ts`.
- New content field or table → Zod schema in `src/models/content.ts` (+ `TABLE_SCHEMAS` in
  `src/content/catalog.ts` for a new table), then `npm run content` to regenerate `schemas/`.
- New HTTP route → `routes` in `src/http/index.ts` (validate the body with a Zod schema) + a test
  in `tests/http.test.ts` + the route table in README.md.
- Node-only code (fs, `node:*`) → `src/content/load.ts`, `src/http/node-server.ts` or `src/cli/`;
  export it from `src/node.ts`, never from `src/index.ts`.

## Generated files (don't edit by hand)

- `src/content/data/srd-5.2.1.json` and `schemas/*.schema.json`: from `npm run content`.
  CI fails (`npm run content -- --check`) if they're out of date, so commit them.
- `dist/`: from `npm run build` (git-ignored).

## API base

`GET /health` — liveness check  
`GET /v1/content` — table names and counts; `/v1/content/{table}`, `/v1/content/{table}/{id}`  
`POST /v1/builds/evaluate` — build → `{ report, sheet, choices (with options) }`  
`POST /v1/characters/` — validate a `Character`  
`POST /v1/characters/{name}/alive` — is the character above 0 HP  
`POST /v1/characters/{name}/passive-perception` — passive Perception (`?proficient=true`)  
`POST /v1/combat/roll` — roll any dice expression (`{"expression": "2d6+3"}`)  
`POST /v1/combat/attack` — full attack resolution  
`POST /v1/combat/saving-throw` — saving throw  
`POST /v1/spells/stats` — spell save DC + attack bonus  
`POST /v1/spells/attack` — spell attack  
`POST /v1/spells/save` — save-based spell (also returns `damage_dealt`)

Errors: 422 invalid body (Zod), 400 bad JSON or dice expression, 404 unknown route/entity,
405 wrong method. `createHandler({ catalog, rng, basePath, cors })` configures it.
