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
  models/          # Zod schemas + types: content, pack (manifest, patches), build, state (play),
                   #   character, combat, spell
  content/         # catalog.ts (createCatalog, lookup), load.ts (fs, Node only), srd.ts (bundled SRD)
  content/data/    # GENERATED srd-5.2.1.json — do not edit, run `npm run content`
  rules/           # pure logic: dice, rng, ability-scores, casting, combat, combatant, damage, spells,
                   #   build-resolution, build-validation, sheet
  services/        # builder.ts (setters + normalize + evaluate), play.ts (play state actions),
                   #   combat.ts (HP, attacks, spells)
  http/            # index.ts: fetch handler (platform-neutral); node-server.ts: node:http adapter
  cli/             # srd-rules bin: build (interactive builder), play, serve, validate
content/srd-5.2.1/ # rules content as YAML (source of truth)
schemas/           # GENERATED JSON Schemas for content files and builds
scripts/           # compile-content.ts; check-sources.ts (leak guard: SRD/homebrew only);
                   #   import-srd-spells.ts (SRD Markdown → spells.yaml);
                   #   import-srd-items.ts (→ magic-items.yaml, conditions.yaml);
                   #   import-srd-classes.py (Python: class levels 2–20, subclasses, features, feats;
                   #   level-2+ mechanics live in its OVERLAY tables, not in the generated YAML)
examples/          # homebrew-pack (tested in tests/content.test.ts)
docs/              # ARCHITECTURE.md (design decisions), CONTENT.md (authoring guide),
                   #   ROADMAP-REVIEW.md (roadmap, decisions, phase progress)
  srd-5.2.1/       # SRD 5.2.1 Markdown: authoritative rules reference (git-ignored)
tests/             # vitest; classes.test.ts: every class × species × background completes;
                   #   levels.test.ts: every class to 20, seeded random multiclass paths to 20
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
- Combat works on `Combatant`s (`rules/combatant.ts`: a read-only view; `combatantFromCharacter`
  in `services/play.ts`). `makeAttack` returns rolls + damage `instances`; the caller applies
  them (play action `{ type: "damage", instances, critical }`). The `Character`-based
  `resolveAttack`/`attackRoll` are deprecated adapters kept until 1.0.
- Spells: `mechanics` on catalog spells (from the MECHANICS overlay in import-srd-spells.ts,
  never hand-edited in spells.yaml); `castSpell` in `rules/casting.ts`. A new spell's mechanics
  need a golden test in `tests/casting.test.ts` checked against the SRD text.
- Taking damage always goes through `takeDamage` in `rules/damage.ts` (Resistance, temp HP,
  0 HP, death); attack damage is `DamagePart[]` (`rollDamage`), never parsed from display text.
- Rules content is data: every entity has a slug `id` and a `source` (default: the pack's name).
  After editing `content/`, run `npm run content` and commit the generated files.
- This repo holds only SRD 5.2.1 content and invented homebrew (`source: homebrew` or `test`),
  including examples and test fixtures; `npm run check:sources` enforces it. Non-SRD content
  belongs in a separate private pack.
- Packs: `pack.yaml` (id, `requires`, default `source`) + `patches.yaml` (edit earlier packs'
  entities by path; never copy an SRD entity to tweak it). `catalog.packs` = loaded manifests.
  Changing a public export updates `tests/__snapshots__/api.test.ts.snap`: note it in CHANGELOG.
- Effect `target`/`when` values are closed lists in `src/models/content.ts`: a new target needs
  an entry there and a consumer in `rules/sheet.ts`.
- A new class feature should be data first (grants, choice kinds, effects, `ac_calculations`);
  add a named rule in `rules/sheet.ts` only when it can't be expressed declaratively, and list
  it under "Named rules in code" in `docs/ARCHITECTURE.md`.
- Levels: `build.levels` = `[{ class_id, hp }]` for levels 2+ (BG3 style: build level 1, then
  level up). Class content = `grants` (core) + `multiclass` + `features` by level; sources are
  `class:<id>` (first level in it), `class:<id>:<n>`, `subclass:<id>:<n>`. Every source/choice
  has `level` (character level); use `choicesForLevel(n)` / `issuesForLevel`.
- Changing choices: "gain a level → replace one" families = same `tag` + `swap`; the engine adds
  optional `#replace:<scope>:<tag>` choices answered `[old, new]`. "After a rest" lists use
  `scaling`. Aggregations must use `Resolution.contributed()`, not `selected()`.
- Override: choices are judged as of their own level (`at(choice)` in option views); every
  setter returns through `commit()` (refuses new validation errors); `previewChange` diffs.
- Play state: `CharacterState` (separate JSON) stores only what's spent/chosen at the table;
  maxima come from the build. Change it only via `applyAction` (JSON actions, `PlayError` on
  refusal); every result goes through `reconcileState`. `rest_change` choices can be re-picked
  in play (`state.choices`, overlaid by `playBuild`). Limited uses = `resources` in grants.
- Character builder: a `CharacterBuild` stores only choices, keyed by choice key
  (`<source key>#<choice id>`, e.g. `class:fighter#skills`). Derived values are always
  recomputed by `rules/sheet.ts`, never stored. See `docs/ARCHITECTURE.md`.

## Common commands

```bash
npm test                 # run tests
npm run check            # content up to date + leak guard + lint + typecheck + tests (CI)
npm run format           # biome format + safe fixes
npm run content          # YAML → bundled JSON + JSON Schemas
npm run build            # dist/
npm run builder          # interactive builder from source (-- --load x.json --seed N --no-color)
npx tsx src/cli/main.ts validate examples/homebrew-pack   # validate a content pack
npx tsx src/cli/main.ts play --load characters/x.json [--state x.state.json]   # play mode
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
`GET /v1/content` — table names and counts; `/v1/content/{table}`, `/v1/content/{table}/{id}`;
`/v1/content/packs` — loaded pack manifests  
`POST /v1/builds/evaluate` — build → `{ report, sheet, levels, level_up_options, choices (with options) }`  
`POST /v1/builds/set-choice` · `/level-up` · `/remove-level` · `/set-level-class` · `/set-level-hp` — workflow setters  
`POST /v1/builds/preview` — effect of a set-choice / set-level-class change, without applying it  
`POST /v1/state/new` · `/apply` · `/sheet` · `/reconcile` — play state (HP, slots, conditions, inventory)
`POST /v1/state/cast` — cast a catalog spell (slot spent, effects applied to targets' states)
`POST /v1/state/attack` — one character attacks another (combatants); damage applied to the target's state  
`POST /v1/characters/` — validate a `Character`  
`POST /v1/characters/{name}/alive` — is the character above 0 HP  
`POST /v1/characters/{name}/passive-perception` — passive Perception (`?proficient=true`)  
`POST /v1/combat/roll` — roll any dice expression (`{"expression": "2d6+3"}`)  
`POST /v1/combat/attack` — full attack resolution (deprecated `Character` API)  
`POST /v1/combat/saving-throw` — saving throw  
`POST /v1/spells/stats` — spell save DC + attack bonus  
`POST /v1/spells/attack` — spell attack  
`POST /v1/spells/save` — save-based spell (also returns `damage_dealt`)

Errors: 422 invalid body (Zod), 400 bad JSON, dice expression, or a refused setter/action (`detail`: messages), 404 unknown route/entity,
405 wrong method. `createHandler({ catalog, rng, basePath, cors })` configures it.
