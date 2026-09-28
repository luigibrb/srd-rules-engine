# Changelog

All notable changes are documented here. This project follows
[Semantic Versioning](https://semver.org/); until 1.0, minor versions may contain breaking changes.

## [Unreleased]

### Changed
- Effect `target` and `when` are closed lists (`EFFECT_TARGETS`, `EFFECT_CONDITIONS`): content
  with an unknown target or condition is rejected at load instead of being silently ignored.
  The JSON Schemas list them for autocompletion.
- An entity without a `source` gets its pack's name (`homebrew` for a pack without a name)
  instead of `srd-5.2.1`. The bundled SRD is unchanged.
- Class content is split into core traits (`grants`), `multiclass` grants and `features` by
  level. Level 1 choice keys are unchanged, so existing builds still load.
- Sheet: `hit_die` became `hit_dice`; spell slots moved from each spellcasting line to
  `spell_slots` and `pact_magic`; Eldritch Invocations are `feature` choices
  (`feature:pact-of-the-tome@class:warlock#invocation`).
- Ported the engine from Python (FastAPI, Pydantic) to TypeScript. Saved builds keep the
  same JSON format, so characters saved by the Python builder still load.
- The HTTP API is now a framework-free `fetch` handler (`srd-rules-engine/http`) that runs on
  Node, Deno, Bun and Cloudflare Workers. Routes and payloads are unchanged.
- `/v1/spells/save` also returns `damage_dealt`.
- Dice expressions are limited to 1000 dice of up to 1000 sides.

### Added
- `rules/damage.ts`: `rollDamage`, `adjustDamage` (Immunity, Resistance, Vulnerability) and
  `takeDamage` (Temporary Hit Points, dropping to 0, massive damage, death save failures,
  Concentration DC), shared by the play action `damage` and the combat `applyDamage`.
- Attack lines have `kind`, `damage_parts` and `two_handed_damage_parts` (structured damage,
  ready for `rollDamage`); the `damage` string is built from them.
- Content pack manifests (`pack.yaml`: id, version, ruleset, default `source`, `requires`),
  checked against load order; `catalog.packs` lists them and `GET /v1/content/packs` serves them.
- Patches (`patches.yaml`): `set`, `append` and `remove` on a path of an entity from an earlier
  pack, validated again after patching (`applyPatch`, `PatchSchema`).
- `createCatalog(packs, { sources })` loads only the given sources.
- Builds can list the packs they need (`packs`, optional); a missing one is a validation error.
  The CLI builder records the packs loaded with `--content` when it saves.
- `tests/api.test.ts` snapshots the names each entry point exports.
- `npm run check:sources` (part of `npm run check`): fails if `content/` holds anything but
  the SRD, or if an example or test pack has a `source` other than `srd-5.2.1`, `homebrew` or
  `test`.
- Play state (`CharacterState`, `applyAction`, `computePlaySheet`, `createState`,
  `validateState`, `reconcileState`): HP and temporary HP, dying and death saves, massive damage,
  Short and Long Rests with Hit Dice, spell and Pact slots, limited-use features (`resources` in
  content), conditions and Exhaustion with their sheet effects, Concentration, Heroic
  Inspiration, inventory, equipment, Attunement, charges, coins, and today's picks for "after a
  rest" choices (`rest_change`). CLI `srd-rules play`; HTTP `/v1/state/*`.
- All 275 SRD magic items and the 15 conditions (`scripts/import-srd-items.ts`,
  `npm run content:import-items`). Magic weapons, armor, AC and save bonuses, ability score
  floors and resistances change the sheet.
- Replacements on level-up, following each SRD rule: "whenever you gain a level, you can
  replace one…" features (cantrips and prepared spells of Bards, Sorcerers and Warlocks; Cleric
  and Druid cantrips; Invocations; Metamagic; Mystic Arcanum; the Fighter's Fighting Style;
  Blessed and Druidic Warrior cantrips; Magical Discoveries; Magic Initiate on any level-up)
  get one optional `[old, new]` replacement per level. "After a Long Rest" lists (Cleric,
  Druid, Paladin, Ranger and Wizard prepared spells, Wizard cantrips, Weapon Mastery) are
  single lists that grow with the class and can be changed at any time.
- Override mode: change any past choice, a past level's class (`setLevelClass`) or its Hit
  Points. Picks are judged as of their own level, so later picks that stop fitting are
  removed and asked again while the rest is kept; `previewChange` shows the effect first; every
  setter refuses a change that would leave the character illegal. CLI `edit`; HTTP `preview`,
  `set-level-class`, `set-level-hp`.
- `scripts/import-srd-classes.py` (`npm run content:import-classes`): the generator of class
  levels 2–20, subclasses, invocations, Metamagic and feats.
- Level-up to 20, in the style of Baldur's Gate 3: `levelUp`, `setLevelHp`, `removeLastLevel`,
  `levelUpOptions`; builds store `levels: [{ class_id, hp }]`. Multiclassing with its
  prerequisites, partial proficiencies, combined spell slots and separate Pact Magic.
- Every SRD class feature to level 20 (feature text from the SRD), and the 12 SRD subclasses.
- All 339 SRD spells; Ability Score Improvement, Grappler and the Epic Boon feats; Eldritch
  Invocations and Metamagic (`features` table); feat prerequisites.
- Content schema: `features` by class level, `multiclass`, `progression` (class table columns),
  `subclasses`, `at_class_level`, choice kinds `subclass`, `ability_increase`, `feature`,
  `ability_bonuses`, spell choice `max_spell_level`/`school`/`tag`/`known_only`.
- Sheet: `classes`, `hit_dice`, `attacks_per_action`, `critical_hit_on`, `spell_slots`,
  `pact_magic`, `resources`, `features`; traits carry their source and level.
- HTTP: `POST /v1/builds/set-choice`, `/v1/builds/level-up`, `/v1/builds/remove-level`.
- All 12 SRD classes at level 1 (Barbarian, Bard, Cleric, Druid, Monk, Paladin, Ranger, Rogue,
  Sorcerer, Warlock and Wizard join the Fighter), and a Spells step in the builder.
- The 84 SRD cantrips and level 1 spells (`spells` table, imported by
  `scripts/import-srd-spells.ts`).
- Spell choices (`kind: spell`) filtered by level, class list (or the list another choice picked,
  as in Magic Initiate), and the Ritual tag; `subset_of` for a Wizard's prepared spells.
  Magic Initiate is now fully automated.
- `kind: expertise`; alternative AC calculations (`ac_calculations`: Unarmored Defense, Mage
  Armor); Martial Arts; effect values that use an ability modifier, with a minimum.
- Weapon proficiencies by property (`martial:light`, `martial:finesse`); Weapon Mastery only
  offers weapons you're proficient with.
- The sheet has `spellcasting` (DC, attack bonus, slots), `spells` and `spellbook`, and marks
  skills with Expertise.
- Elf, Gnome and Tiefling lineage spells use the spellcasting ability chosen for the lineage;
  Forest Gnomes always have Speak with Animals prepared.
- Content packs: `createCatalog(srdPack, homebrewPack)` layers homebrew over the SRD.
- `srd-rules validate <dir>` checks a content pack.
- JSON Schemas for every content file and for saved builds (`schemas/`).
- The SRD as one JSON file: `srd-rules-engine/srd-5.2.1.json`.
- HTTP: `GET /v1/content/...` and `POST /v1/builds/evaluate`.
- `seededRng`, `scriptedRng` and `fixedRng` for deterministic dice.

### Fixed
- The Blowgun's fixed damage no longer adds the ability modifier (SRD "Damage Rolls").
- While Petrified, untyped damage is halved too (Resistance to all damage).
