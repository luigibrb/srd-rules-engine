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
- Replacements and "after a rest" lists store the character's current state; rest-by-rest
  history (which spells were prepared on which day) belongs to session state, not the build.
- Features that roll dice or depend on the situation (Rage damage, Sneak Attack, Divine Strike,
  Potent Spellcasting) are shown as text and class resources, not added to attack lines.
- Starting-equipment items "of your choice" (a Bard's instrument, a Monk's tool) are
  placeholders, like the Soldier's gaming set.
- The combat model (`Character` in `src/models/character.ts`: HP, AC, ability scores) is a
  separate, hand-filled snapshot. It isn't derived from a build and sheet yet; bridging the two
  belongs with the session-state layer.

## Levels and multiclassing

Leveling follows Baldur's Gate 3: a character is created at level 1, then gains levels one at
a time. The build stores each level after the first as `{ class_id, hp }` (`hp: null` = the
fixed value, hit die / 2 + 1; a number = the stored Hit Die roll), so any level can be
recomputed or undone.

**Class content** has three parts:

- `grants`: core traits you get only when it's your first class (saves, skills, gear);
- `multiclass`: what you get instead when you multiclass into it (SRD "As a Multiclass
  Character");
- `features`: grants by class level, `1`–`20`. Level 1 features apply either way.

**Sources by level.** The first level in a class is the source `class:<id>` (core or multiclass
grants merged with level 1 features), so level 1 choice keys are the same as before; later
levels are `class:<id>:<class level>`. A `kind: subclass` choice picks the subclass, whose
features are sources `subclass:<id>:<class level>`. Every source and choice knows the character
level it was gained at, so the builder can ask each level's choices in order and validation
reports issues per level. `at_class_level` switches on more grants when the class reaches a
level (a subclass's spell table, the Land druid's resistance).

**Multiclassing** (SRD "Multiclassing"): taking a new class needs a score of 13+ in the primary
abilities of the new class and every class you have (`primary_mode: all` classes need all of
them). Spell slots come from the Multiclass Spellcaster table (in `creation.yaml`): full casters
count every level, Paladins and Rangers half (rounded up). The single-class Paladin and Ranger
tables match that formula, and a test checks it. Pact Magic slots are separate. Each class's
spell choices use that class's own table (its "levels you have slots for"). Extra Attack from
several classes doesn't stack (effects use `op: max`), and AC calculations never stack.

**Ability scores** are recomputed in level order: base scores, background bonus, then every
Ability Score Improvement, feat increase and fixed bonus (Primal Champion), each capped (20, or
the feat's own cap such as 30 for Epic Boons). Prerequisites are checked against the scores
from before the level where the choice is made.

**Feats and feature options** have prerequisites: character level, class level, ability scores,
other feats or features, a trait (Fighting Style feats need the Fighting Style feature),
Spellcasting, or knowing one of some spells. Eldritch Invocations and Metamagic options have the
same shape as feats but live in their own `features` table, so an Ability Score Improvement
("any feat you qualify for") can't pick one.

### Changing choices: replacements and lists

The SRD has two kinds of "change it later" rule, modeled differently:

- **"Whenever you gain a level, you can replace one…"** (history matters: you can't swap
  everything at once, and a spell swapped in at level 5 may be of a level you didn't have at
  level 1). The family's choices share a `tag` and have `swap: class_level` (or `any_level` for
  Magic Initiate). At each later qualifying level the engine adds an optional replacement choice
  (`<level source>#replace:<scope>:<tag>`) whose answer is `[old, new]`. Its new options are
  those of the family's latest choice at that level (so level and list upgrades apply);
  `same_level` keeps the spell level (Mystic Arcanum, Magic Initiate). A replaced Eldritch
  Invocation can't be one another invocation requires.
- **"After a Long Rest you can change…"** lists are one choice with `scaling`: count (and
  maximum spell level) by class level. You can re-pick them at any time; a level-up just makes
  them bigger.

A `SwapLedger` replays each family in level order (picks, then replacements) and
`Resolution.contributed(choice, atLevel)` gives what each choice really provides. When any
replacement is stored, `resolve` runs twice so that a replaced invocation's feature source (and
its own choices) disappears and the new one appears at the replacement's level.

### Changing the past (override mode)

Every setter works on any level, and three rules keep the result a legal character without
wiping everything after the edited level:

1. **A pick is judged as of its own level.** "Already proficient / known / have this feat" only
   counts what the character had at that level (choices at the same level count both ways;
   "after a rest" lists are judged now). So an edit to level 3 can take something a later level
   also took, and the *later* pick gives way.
2. **Repair, don't wipe.** `normalize` walks choices in level order and removes only picks
   whose source disappeared or that became illegal; everything else is kept, and the removed
   picks show up again as pending questions.
3. **Refuse what repair can't fix.** After applying and repairing, `commit` validates the whole
   build; any error that wasn't there before (a later multiclass level whose prerequisite is no
   longer met, say) makes the change fail with the validator's own message, and the build is
   unchanged. The guard has no rules of its own, so anything the validator checks is enforced.

`previewChange` runs a change and diffs the result (picks removed, new pending questions) so
UIs can ask for confirmation. `setLevelClass` changes a past level's class: class features follow
the Nth level *in* a class (`class:fighter:3`), so they move along with their choices.

## Play state

The build holds characteristics; a separate `CharacterState` (`src/models/state.ts`) holds what
changes at the table: HP (`current: null` = at the maximum, so it follows level-ups), temporary
HP, spent Hit Dice, death saves, conditions, Exhaustion, Concentration, Heroic Inspiration, spent
slots and uses, the inventory, coins, and `choices`: today's picks for choices marked
`rest_change` (prepared spells, Weapon Mastery…). The state stores only what's *spent* or
*chosen*; maxima always come from the build, so they never go stale.

- **Actions** (`PlayActionSchema`, plain JSON) go through `applyAction(build, state, catalog,
  action, { rng })` → `{ state, notes }`, or throw `PlayError`. After every action the result is
  passed through `reconcileState`, so an accepted action can't leave an invalid state.
- **The played build.** `playBuild` overlays `state.choices` on the build (only for
  `rest_change` choices); `computePlaySheet` computes the sheet from it with a `PlayContext`
  (carried items, active conditions, Exhaustion), then adds the live `play` block. A
  rest-change pick is validated by running the builder's `setChoice` on the played build, so it
  follows exactly the same rules as a build pick.
- **Items.** An inventory entry points at a catalog item; magic items made from a mundane one
  store its `base` (Weapon, +1 → `longsword`) and kinds a `variant`. A magic item is *active*
  when worn/held (or carried, per `active_when`) and attuned if required; active items become
  sources, so their grants use the same machinery as feats. A magic weapon's bonus applies to
  its attack line whenever attunement allows (you wield it to attack). With a play context, AC
  comes from the equipped armor and Shield instead of the best armor owned.
- **Conditions** are data: `implies` (Unconscious → Incapacitated, Prone) and `speed_zero`.
  Exhaustion is a level on the state; the sheet applies −2 per level to d20 tests and −5 ft per
  level to speed. Incapacitated ends Concentration.
- **Build changes** don't touch the state; `reconcileState` clamps spent resources, drops
  rest-change picks that no longer fit and ends attunements that are no longer allowed.

Interpretations: a Long Rest doesn't remove conditions (the SRD ties them to their source);
attuning is recorded immediately, with a note that it takes a Short Rest; damage while Petrified
is halved (Resistance to all damage).

### Interpretations (flagged, not invented)

- **A spell or Expertise choice needs no more picks than there are options left.** With the
  SRD's 27 cantrips, a multiclass caster can already know every cantrip on a short list (the
  Cleric has seven), and a multiclass Wizard may have none of the skills Scholar needs. The SRD
  doesn't cover this; the builder accepts fewer picks instead of blocking the character. A spell
  choice whose list isn't chosen yet (Magic Initiate) still needs its full count.
- **A repeatable feat that must differ each time** (Magic Initiate: a different spell list) stops
  being offered once every option is used.
- **"A Warlock cantrip that deals damage"** (Agonizing Blast, Eldritch Spear, Repelling Blast)
  is Chill Touch, Eldritch Blast, or Poison Spray, the SRD Warlock cantrips that deal damage with
  an attack roll or save.
- **Class feature text for levels 2–20 is the SRD's own**, generated from the Markdown; level 1
  traits stay summarized. Only features that change the sheet's numbers or ask a choice are
  modeled; the rest (Rage damage, Sneak Attack dice, Channel Divinity…) is shown as text and
  as class resources.

### Named rules in code (documented exceptions)

Martial Arts (the `martial_arts.die` effect) and Great Weapon Fighting's note live in
`rules/sheet.ts`, as before. Everything level-related above is data.

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
