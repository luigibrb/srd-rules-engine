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
scripts/           # compile-content.ts
examples/          # homebrew-pack (tested in tests/content.test.ts)
data/srd-5-2-1/    # SRD 5.2.1 Markdown: authoritative rules reference (git-ignored)
docs/              # ARCHITECTURE.md (design decisions), CONTENT.md (authoring guide)
tests/             # vitest; *.test.ts
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
npm run serve            # HTTP API on localhost:8000
```

## API base

See the route table in README.md (`src/http/index.ts`). Includes `GET /health`,
`/v1/content/...`, `POST /v1/builds/evaluate`, `/v1/characters/...`, `/v1/combat/...`,
`/v1/spells/...`.
