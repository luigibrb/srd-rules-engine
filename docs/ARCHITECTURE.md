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
6. **Features**: Fighting Style, Weapon Mastery, Divine/Primal Order, Eldritch Invocation, the
   Human Versatile feat, and feat sub-choices.
7. **Spells** comes after features because a feature can decide which list you pick from
   (Magic Initiate's list, Thaumaturge's extra cantrip, Pact of the Tome).
8. **Skills & tools** comes late so every fixed grant (background, species, feats) is known
   before free picks are spent. Duplicates are greyed out.
   Expertise is asked last within the step, once every proficiency is known.
9. **Languages.**
10. **Name & alignment** is last because nothing depends on it (BG3 also asks for it last).

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

`Effect{target, op: add|set|max, value: int|"prof"|ability, min, when}` covers the numbers
level 1 needs (`ac`, `initiative`, `speed`, `darkvision`, `hp_per_level`, `attack.ranged`,
`skill.<id>`, `martial_arts.die`). An ability value means that ability's modifier; `min` is a
floor (Thaumaturge: "Wisdom modifier, minimum of +1"). It's a small, declarative stand-in for
the full Effect engine (milestone 3). It already uses the same shape
(target/op/value/condition), so the content won't need rewriting later.

Conditions available to `when`: `wearing_armor`, `wielding_shield`.

**Armor Class** is not a sum of effects: features like Unarmored Defense and Mage Armor are
*alternative* calculations that never stack with each other or with armor. Content declares
them as `ac_calculations` (`base` + ability modifiers, whether a Shield still applies). The
sheet evaluates every legal configuration (each owned and trained armor, or no armor with each
calculation; with or without a Shield), including conditional effects such as Defense, and
picks the highest. Ties go to the simpler option.

**Named rules in code (documented exceptions).** A few level 1 features change how attacks
work rather than a number: Martial Arts (Dex and the Martial Arts die for Unarmed Strikes and
Monk weapons, only without armor or Shield) is triggered by the `martial_arts.die` effect;
Great Weapon Fighting adds a note to two-handed melee attacks. Both live in `rules/sheet.ts`.

### Spells

Spells are content (`spells.yaml`: level, school, class `lists`, ritual, concentration, full
text). A class declares `spellcasting` (list, ability, slots, `pact` for Warlocks) and its
picks as `kind: spell` choices:

- `spell_level` and `spell_list` filter the options; `ritual: true` keeps only rituals.
- `spell_list: $spell_list` takes the list from a sibling choice's answer (Magic Initiate); a
  `spellcasting.ability` can do the same (`$spellcasting_ability`).
- `subset_of: spellbook` limits options to what a sibling choice picked (a Wizard prepares from
  the spellbook). The sheet lists the pool as `spellbook`, not as prepared spells.
- `always_prepared: true` marks picks that don't count against a class's limit (Magic
  Initiate, Pact of the Tome); `grants.spells` does the same for fixed spells (Hunter's Mark,
  Speak with Animals).
- A spell you already have from any other source is unavailable ("already known from Ranger"),
  except between a pool and its subset.

### Known gaps (flagged, not invented)

- Starting gold (Fighter option C, background option B): shopping isn't automated.
- AC assumes you wear the best armor you own and are trained with. Equipping comes with the
  inventory milestone.
- Level 1 only, so no subclasses (they start at level 3) and no Warlock invocations with a
  level prerequisite.
- Starting-equipment items "of your choice" (a Bard's instrument, a Monk's tool) are
  placeholders, like the Soldier's gaming set.
- The combat model (`Character` in `src/models/character.ts`: HP, AC, ability scores) is a
  separate, hand-filled snapshot. It isn't derived from a build and sheet yet; bridging the two
  belongs with the session-state layer.

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
- **Services.** The Python `character_service`, `combat_service` and `spell_service` were
  merged into `src/services/combat.ts`. Functions that returned tuples now return objects
  (`{ attack, damage, target }`, `{ build, notes }`).
- **HTTP.** A Web-standard `fetch` handler with no router dependency. Request bodies are
  validated with the same Zod schemas (422 on failure). The Node adapter limits bodies to
  1 MB, and dice expressions are limited to 1000 dice of up to 1000 sides.
