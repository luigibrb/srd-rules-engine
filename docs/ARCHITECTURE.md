# Architecture

## Character builder (level 1)

### Step order

`STEPS` in `src/models/content.ts` defines the order, based on dependencies. Each step only
uses what earlier steps decided, and nothing important is asked before the facts that
constrain it are known. The order follows the 2024 rules (Class → Origin → Ability Scores →
Details) and Baldur's Gate 3, which lets you move freely between tabs.

1. **Class**: sets the primary ability, saves, armor training and skill list.
2. **Species**, including size, lineage and legacy (sub-choices that change speed,
   darkvision and resistances).
3. **Background**: sets which abilities can be raised, plus the origin feat, skills and tool.
4. **Ability scores**: standard array, point buy or 4d6, then the background's +2/+1 or
   +1/+1/+1. This comes after class and background so the builder can recommend where scores go.
5. **Equipment** comes before features so Weapon Mastery can mark weapons you carry and
   Fighting Style can preview its AC or attack effect.
6. **Features**: Fighting Style, Weapon Mastery, the Human Versatile feat, and feat
   sub-choices.
7. **Skills & tools** comes late so every fixed grant (background, species, feats) is known
   before free picks are spent. Duplicates are greyed out.
8. **Languages.**
9. **Name & alignment** is last because nothing depends on it (BG3 also asks for it last).

You can jump to any step. If a change upstream makes a later choice invalid,
`normalize` in `src/services/builder.ts` removes it and says why. For example, switching to Criminal
removes Stealth from Skilled.

### Layers

| Layer | Module | Responsibility |
|---|---|---|
| Content | `content/**/*.yaml`, `src/content/` | Static rules data; schema + cross-reference validation at load |
| Build | `src/models/build.ts` | The player's choices only; immutable |
| Resolution | `src/rules/build-resolution.ts` | Build + catalog → active sources, pending choices, option availability |
| Validation | `src/rules/build-validation.ts` | Errors (illegal), pending (missing), notes (not automated) |
| Sheet | `src/rules/sheet.ts` | Derived numbers with contributions (`AC 17 = 16 Chain Mail + 1 Defense`) |
| Workflow | `src/services/builder.ts` | Validated setters + normalization |
| UI | `src/cli/`, `src/http/` | Interactive shell and HTTP API; no rules logic |

### Sources and choices

A **source** is anything that grants something: base creation rules, the class, the species,
a chosen option (Wood Elf), the background, a feat, or an equipment package. Each source has
`Grants` (skills, tools, effects, items, …) and may declare **choices**. Answering a choice can
activate more sources. For example, Human → Versatile → Skilled adds a
"choose 3 skills or tools" choice.

Keys are flat strings so the build can store answers without nesting:

- `class:fighter#skills`
- `species:elf#lineage` (the answer `wood-elf` activates source `species:elf#lineage=wood-elf`)
- `feat:skilled@species:human#versatile#proficiencies`

Validation and the UI both use `Resolution.options(choice)`. It lists every option together
with the reason it's unavailable, if any, so the rules for what can be picked live in one
place.

### Effects (pre-engine)

`Effect{target, op: add|set|max, value: int|"prof", when}` covers the numbers level 1 needs
(`ac`, `initiative`, `speed`, `darkvision`, `hp_per_level`, `attack.ranged`). It's a small,
declarative stand-in for the full Effect engine (milestone 3). It already uses the same shape
(target/op/value/condition), so the content won't need rewriting later.

### Known gaps (flagged, not invented)

- Magic Initiate cantrip and level 1 spell picks: not automated yet. The builder shows this as
  a note.
- Starting gold (Fighter option C, background option B): shopping isn't automated.
- AC assumes you wear the best armor you own and are trained with. Equipping comes with the
  inventory milestone.
- Only the Fighter class is defined. Other classes are added as YAML under `classes/`.

## Runtime and packaging (TypeScript)

The engine was ported from Python to TypeScript so the same code can run in a browser
builder, a VTT client, an edge function and a server.

- **Isomorphic core.** `src/index.ts` and `src/http/` import no Node built-ins. The SRD is
  compiled from YAML to JSON at build time (`scripts/compile-content.ts`) and bundled, so no
  filesystem or YAML parser is needed at runtime. Node-only code (reading content
  directories, the `node:http` adapter, the CLI) is in `src/content/load.ts`,
  `src/http/node-server.ts` and `src/cli/`.
- **Schemas: Zod.** Content, builds and API payloads are Zod schemas. The TypeScript types
  are inferred from them, except for the recursive `Grants`/`ChoiceDef`/`ChoiceOption`,
  which are written by hand. The same schemas generate `schemas/*.schema.json` for content
  authors and for other languages.
- **snake_case data.** Fields keep the YAML/JSON names (`class_id`, `base_ac`), so content,
  saved builds, sheets and HTTP payloads share one format, and builds saved by the Python
  version still load. Functions are camelCase.
- **Immutability.** Catalogs are deep-frozen and builds are frozen. `updateBuild` replaces
  Pydantic's `model_copy`. Lookups by id go through `lookup()` (an `Object.hasOwn` check),
  so ids like `constructor` can't hit the prototype.
- **Content packs.** `createCatalog(...packs)` layers packs in order: a later pack adds
  entities and replaces earlier ones with the same id. Duplicate ids within one pack are
  errors. Cross-references are checked after layering.
- **Dice.** Every rolling function takes an optional `Rng` (`{ int(min, max) }`).
  `seededRng` (mulberry32) gives the same sequence on every platform; `scriptedRng` and
  `fixedRng` are for tests.
- **HTTP.** A Web-standard `fetch` handler with no router dependency. Request bodies are
  validated with the same Zod schemas (422 on failure). The Node adapter limits bodies to
  1 MB, and dice expressions are limited to 1000 dice of up to 1000 sides.
