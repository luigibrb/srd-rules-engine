# Roadmap review (Step 0)

Checked against the code on 2026-09-28. **Confirmed** = the code works as the roadmap assumes;
**Contradicted** = it doesn't; **Partly** = some of it exists. Paths are relative to the repo root.

## 1. Item by item

### A1. Connect combat to the builder: **Partly** (the gap is real; the sheet side is further along than assumed)

- **Two damage paths: confirmed.** `src/services/combat.ts` `applyDamage(character, n)` only
  subtracts from `Character.current_hit_points`, with no resistances, temporary HP, death saves or
  Concentration. The play action `damage` in `src/services/play.ts` (`applyAction`, `case
  "damage"`) does all of those on `CharacterState`, but it takes an already-rolled `amount`. Nothing
  connects the two.
- **`Character` is a separate snapshot: confirmed**, and it is more separate than the docs say
  (`src/models/character.ts`):
  - it uses full ability names (`strength`), while builds and sheets use `str`;
  - `character_class` is an enum of the 12 SRD classes, so a homebrew or private class can't even
    be represented;
  - it has no resistances, conditions or temporary HP.
- **"The sheet should produce real attack lines": already done.** `computeSheet` returns
  `attacks: AttackLine[]`, `attacks_per_action` and `critical_hit_on` (`src/rules/sheet.ts`,
  `AttackLine`, `unarmedStrike`, `attackLine`). These lines include proficiency, finesse, Martial
  Arts, Archery, magic weapon bonuses, Exhaustion, Heavy and GWF notes, mastery and versatile
  damage. What's missing is **structure**: `damage` is a display string (`"1d8+3 (1d10+3
  two-handed)"`), so nothing can roll it without parsing prose. `resolveAttack` doesn't use these
  lines; it takes `attackBonus` and dice by hand.
- **Consequence for the plan:** the combatant abstraction is still the right idea, but the work is
  mostly about (a) making `AttackLine` structured, and (b) moving the state-side damage logic into
  one pure function that both play and combat use.

### A2. Structured spell mechanics: **Partly** (and there are two spell models)

- **Catalog spells are text: confirmed.** `SpellDefSchema` (`src/models/content.ts`) has level,
  school, lists, casting time, range, components, duration, concentration and `description`, but no
  mechanics.
- **Not assumed: a second spell model exists.** `SpellSchema` in `src/models/spell.ts` already has
  `damage_dice`, `damage_type`, `save_ability` and `attack_type`. `resolveSpellSave`,
  `resolveSpellAttack` and the `/v1/spells/*` routes use this model; the catalog never does. So
  "takes dice by hand" is right: the caller fills in a free-standing `Spell`.
- **Also missing** from both models: cantrip scaling (the 5th, 11th and 17th level damage
  increases), upcasting, several damage instances, healing, and conditions applied on a failed save.
- **Size of the job:** in the 339 SRD spells, 91 descriptions have "NdM Type damage", 142 mention a
  saving throw, 25 a spell attack, 85 a named condition, 80 an area and 13 healing. A parser can
  draft most of this data; a human has to review it (the same pattern as the item importer's
  overlay).
- `castSpellSave` falls back to a Dexterity save when `save_ability` is null
  (`src/rules/spells.ts`). That's an invented default and should go.

### A3. Full Effect engine: **Partly**. It can be extended without rewriting content, but it needs a new concept

- **The fixed target list: contradicted, and it's worse than assumed.** `EffectSchema.target` is
  `z.string()`, not an enum. There is no fixed list, and nothing checks targets.
  `effectsFor` (`src/rules/sheet.ts`) matches target strings exactly, so a typo such as
  `target: speeed` is silently ignored. `when` isn't checked either, and it only knows the five
  armor conditions in `armorConditions`. Play conditions (`PlayContext.conditions`) never reach
  `when`.
- **What content uses today** (every target, SRD plus example): `speed`, `darkvision`, `attacks`,
  `score.<ability>`, `saves`, `ac`, `martial_arts.die`, `skill.<id>`, `initiative`, `hp_per_level`,
  `attack.critical`, `skill.unproficient`, `hp_per_class_level`, `checks`, `attack.ranged`. All
  existing effects are numeric, so extending the schema only adds things and no content has to be
  rewritten.
- **What Sneak Attack, Rage and Divine Strike need** isn't another numeric target. They need:
  1. **damage riders**: extra dice or a flat bonus added to some attacks. That means a new value
     kind (dice) and a filter on the attack (melee, Strength-based, finesse or ranged, once per
     turn);
  2. **state-driven conditions**: "while raging" has nowhere to live, because `CharacterState` has no
     "active feature" flag. Rage is only a use counter (`uses_spent["barbarian:rage"]`);
  3. **class-table values**: the dice already exist as data. `progression` columns such as `Sneak
     Attack: [1d6, 1d6, 2d6, …]` (`content/srd-5.2.1/classes/rogue.yaml`) and `Rages` are shown as
     class resources but never used in calculations.
- **Named rules in code** today: Martial Arts and GWF in `sheet.ts` (documented), plus hard-coded
  ids that aren't documented: `great-weapon-fighting`, and `petrified`, `unconscious` and
  `incapacitated` in `src/services/play.ts`.
- The feat `unsupported` note exists (`src/rules/build-validation.ts`), but no SRD feat uses it.

### A4. Monsters: **Confirmed missing**; the source data is good

- There's no monster table or model. `docs/srd-5.2.1/monsters-A-Z.md` (235 stat blocks) and
  `animals.md` (95) use a regular format: AC, Initiative, HP with its dice, Speed, an ability table
  with saves, Immunities, Senses, CR/XP/PB, and actions such as `_Melee Attack Roll:_ +4, reach 5
  ft. _Hit:_ 5 (1d6 + 2) Bludgeoning damage.`. An importer with an overlay, like
  `import-srd-items.ts`, fits well.
- This depends on A1 (the combatant interface) and on structured damage (A1/A2); monster actions
  are "attack line + damage" too.

### A5. Encounter state: **Confirmed missing**; the parts it would hook into are thinner than assumed

- There's no initiative, turn, round or action-economy code anywhere.
- **Concentration** is `CharacterState.concentration: string | null` (a name, not a spell id). The
  `damage` action only adds a note ("Constitution saving throw, DC 12"); it doesn't roll the save.
- **Conditions** are a list of ids with no duration and no source (`state.conditions`), so a
  per-round tick has nothing to count down yet.
- An encounter needs its own state document (a list of combatants, a turn pointer and round,
  effects with a duration), next to the per-character `CharacterState`.

### B1. Patch semantics for packs: **Confirmed needed**

- `createCatalog` (`src/content/catalog.ts`) validates each entity, then assigns
  `tables[table][id] = parsed`. That's a whole-entity replacement, done per table.
- Two things to design:
  1. Patches must be applied **before** schema validation (to the raw merged object), or the
     patch would have to be a full valid entity.
  2. Grants are deeply nested (`choices[].options[].grants`), so "append to `lists`" is easy but
     "add a choice to class level 3" needs a path syntax.

### B2. Pack manifest: **Confirmed missing**

- A pack is `{ name?, creation?, <table>?: unknown[] }`. `loadContentPack` takes the name from the
  folder name, and there's no version, dependency or ruleset information.
- **Related finding:** builds don't record which packs they need (`CharacterBuildSchema` in
  `src/models/build.ts`). A build that uses private ids fails validation with "unknown id" when
  it's loaded without the private pack, and doesn't say which pack is missing.

### B3. Filtering by `source`: **Partly; the data isn't reliable yet**

- Every entity has `source`, but **it defaults to `"srd-5.2.1"`** (`entity` in
  `src/models/content.ts`, and `CreationSchema.source` too). A private entity that leaves it out is
  silently labelled SRD. That has to be fixed before filtering by source, or the leak guard, can
  be trusted.

### B4. Ruleset scope: **No code impact yet**

- The engine is 2024-only in practice: `STEPS` order, species and background ability bonuses, and
  Weapon Mastery are all 2024 rules. Nothing in the code refers to a 2014 ruleset. Your default
  (target 2024, convert older material manually) fits the code as it is.

### B5. Table registry: **Contradicted as a small change**

- `Catalog` is a fixed TypeScript interface, `TABLE_SCHEMAS` is a constant, and
  `validateReferences` and `allGrants` walk the known tables by name. Tables that packs define
  would be untyped, and nothing in the rules would read them. Two things cover most of the need:
  - maneuvers, infusions and similar options fit the existing `features` table (`kind: feature` +
    `category`, as Eldritch Invocations do);
  - monsters belong in core (A4).

### B6. Leak guard: **Missing, and harder than one check because of the `source` default**

- `source: srd-5.2.1` in `content/` proves nothing while it's the default. A useful guard checks
  **paths and content** together:
  - `content/` contains only `srd-5.2.1/`, and `examples/` only packs that declare
    `source: homebrew` explicitly;
  - every entity in the compiled SRD JSON is `srd-5.2.1`, and no id is missing from the SRD
    Markdown headings.

### B7. Public API stability: **Partly**

- The exports map is clean (`.`, `./node`, `./http`, the JSON and the schemas; ESM + CJS + d.ts).
- `src/index.ts` uses `export *` for almost every module, so internal helpers are public by
  accident, and any rename is a breaking change.
- The version is `0.1.0`, and there's no API snapshot. The npm `files` field also ships
  `content/` (YAML), which is fine for SRD content.

### B8. Authoring pipeline: **Partly**

- **The pattern exists** (Markdown → parser → overlay tables for mechanics → YAML →
  `npm run content` → tests) in three importers. One is Python (`import-srd-classes.py`), so it
  can't reuse the TypeScript schemas.
- **Options already fit:** maneuvers and infusions fit `features` + `kind: feature` + `category`
  (and `prerequisite`, `tag`/`swap` for "replace one when you gain a level").

## 2. Docs vs code

1. **Effect targets.**
   - ARCHITECTURE.md "Effects (pre-engine)" lists level 1 targets only, and says `when` supports
     `wearing_armor` and `wielding_shield`. Code: 15 targets in use, and five `when` conditions
     (CONTENT.md is closer).
   - Neither doc says that targets aren't validated.
2. **Stale gap in ARCHITECTURE.md "Known gaps":** "AC assumes you wear the best armor… Equipping
   comes with the inventory milestone". With a play state, AC already comes from the equipped
   armor (`wornArmorClass`).
3. **Stale plan in ARCHITECTURE.md "Known gaps":** "bridging [combat] belongs with the
   session-state layer". The session-state layer shipped; the bridge didn't.
4. **"Named rules in code"** leaves out the hard-coded condition ids in `play.ts` (`petrified`
   halves damage; `unconscious` and `incapacitated` drive death saves and Concentration).
5. **CONTENT.md:**
   - "Every entity has… a `source`" doesn't say that it defaults to `srd-5.2.1`;
   - its file table leaves out `magic-items.yaml` and `conditions.yaml` (they're explained further
     down).
6. **Two spell models aren't documented:**
   - README "Dice and combat" presents `resolveSpellSave` next to the catalog, but the function
     takes the separate `Spell` model;
   - `CharacterSchema` uses the 12 SRD class names as a fixed enum, which the docs don't mention
     either.
7. **`loadContentPack`'s doc comment** (`src/content/load.ts`) lists the original 10 files, with no
   spells, subclasses, features, magic items or conditions.

## 3. Revised roadmap

The main changes from your order: small guard rails come first; a slim pack foundation (B) comes
before combat, because it's cheap and unblocks your private repo; and A1 is split.

| Phase | Items | Why here |
|---|---|---|
| **P0: Guard rails** | B6 leak guard (paths + compiled sources); validate effect `target`/`when` against a registry; `source` defaults to the pack name instead of `srd-5.2.1` for non-bundled packs; fix the doc mismatches above | Small, and nothing breaks. The leak guard is only trustworthy once the `source` default is fixed; target validation makes later effect work safe |
| **P1: Pack foundation** | B2 manifest (`pack.yaml`: id, version, `requires`); B1 patches (a `patches:` section per pack, applied before validation, with a small op set: `set`, `append`, `remove` on a path); B3 source/pack filtering in `createCatalog` options; B7 explicit exports + an export-name snapshot test | Independent of combat; lets the private repo start. Patches are the riskiest part of this phase, so they get their own commits |
| **P2: Structured attacks + one damage function** | A1a: `AttackLine` gets structured `damage: [{dice, bonus, type}]`, keeping the current string as `damage_text`; A1b: pull the damage rules out of `play.ts` into a pure `rules/damage.ts` (resistance, **immunity/vulnerability**, temp HP, 0 HP, massive damage, Concentration DC), used by the play action | Unifies the two paths without a new model yet |
| **P3: Combatant** | A1c: a `Combatant` view (`combatantFromCharacter(build, state, catalog)`); `resolveAttack(attacker, attackLine, target)` returns a damage result for the target's state; the old `Character` API stays as a deprecated adapter (HTTP routes unchanged) | Needs P2 |
| **P4: Spell mechanics** | A2: merge `Spell` into `SpellDef` as an optional `mechanics` block (attack/save, damage instances, cantrip scaling, upcasting, on-save, conditions, area); import-spells parser + reviewed overlay; spells cast from a `Combatant` | Needs P3. Large (339 spells) but mechanical |
| **P5: Effect engine, step 1** | A3: dice-valued riders (`attack.damage` with filters), `progression:<column>` values, a state toggle for active features (`state.active: ["barbarian:rage"]`) usable in `when`; model Rage, Sneak Attack and Divine Strike as the proof | Needs structured attacks (P2); worth doing before monsters so monsters reuse riders |
| **P6: Monsters** | A4: `monsters` table + schema, importer for the 330 stat blocks with an overlay, `combatantFromMonster` | Needs P3 (and P5 for special traits) |
| **P7: Encounter** | A5: `EncounterState` (combatants, initiative, round/turn, per-turn action economy, timed effects), Concentration saves rolled, condition durations | Needs everything above |
| **Dropped / deferred** | B5 table registry (the `features` table and core monsters cover it; revisit if a real need appears); B4 `ruleset` field (only as informational manifest metadata in P1) | See §1 |
| **Ongoing** | B8 authoring: a shared `scripts/lib/` (slug, clean, Markdown section and table helpers, overlay merge, YAML dump), and a documented "transcribe → overlay → validate → golden test" recipe in CONTENT.md; used by P4 and P6 | Built as those phases need it, not up front |

**Migrations.** None of P0–P7 has to change the shape of a saved build or state:
- new state fields (`active`) come with defaults, so old states still parse;
- the encounter is a new document;
- the `source` default only affects packs loaded from disk; the bundled SRD already has explicit
  sources.

One suggestion: add an optional `version` field to builds and states in P1, so future migrations
have something to check against.

## 4. Open questions

1. **Order:** OK to put the P0 and P1 pack work before the combat items (your list had A first)?
2. **Patch format:** a small op list (`{target: spells/fireball, op: append, path: lists, value:
   [warlock]}`), or JSON Merge Patch (RFC 7386; simpler, but it can't append to arrays)? I
   recommend the op list.
3. **Builds and packs:** should a build record the packs it needs (for example an optional
   `packs: ["my-private@1"]`), so loading it without them gives a clear error?
4. **The old `Character` API and `/v1/characters`, `/v1/combat/*`, `/v1/spells/*` routes:** keep
   them as deprecated adapters until 1.0, or replace them in P3 (a breaking change at 0.x)?
5. **Python importer:** port `import-srd-classes.py` to TypeScript so all importers share
   `scripts/lib/`, or leave it alone? The port is sizeable (850 lines), and not needed for any
   phase.
6. **Scope of P5:** which features should the first step of the Effect engine prove? I suggest
   Rage (toggle + damage + resistance), Sneak Attack (progression dice, once per turn) and Divine
   Strike (a rider limited to once per turn).
7. **Leak guard hook:** CI only, or also a pre-commit hook? A hook needs a dev dependency (for
   example `simple-git-hooks`) or a documented `git config core.hooksPath`.

## 5. Decisions (2026-09-28)

Approved with the recommendations above:

1. Pack work (P0, P1) comes before the combat items.
2. Patches are a small op list (`set`, `append`, `remove` on a path), not JSON Merge Patch.
3. Builds may record the packs they need (optional field, added in P1).
4. The old `Character` API and its routes stay as deprecated adapters until 1.0.
5. `import-srd-classes.py` stays in Python for now.
6. P5 proves Rage, Sneak Attack and Divine Strike.
7. The leak guard runs in CI (`npm run check`); no pre-commit hook dependency.

## 6. Progress

- **P0 (done, branch `p0-guard-rails`):** closed effect `target`/`when` lists with load-time
  errors; `source` defaults to the pack's name; `npm run check:sources` leak guard in
  `npm run check`; the doc mismatches in §2 fixed.
- **P1 (done, branch `p1-packs`):** `pack.yaml` manifests with `requires`; `patches.yaml`
  (`set`/`append`/`remove`); `createCatalog(packs, { sources })`; optional `build.packs`,
  recorded by the CLI on save; API export snapshot; `GET /v1/content/packs`. Deviations:
  patches apply to the *parsed* entity and are validated again (not "before validation": with
  defaults filled in, paths are stable); exports stay `export *`, with the snapshot as the guard
  and the accidental internal exports listed for 1.0; no `version` field on builds and states
  yet (a build without one is version 1, so it can wait for the first real migration).
