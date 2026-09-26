# Changelog

All notable changes are documented here. This project follows
[Semantic Versioning](https://semver.org/); until 1.0, minor versions may contain breaking changes.

## [Unreleased]

### Changed
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
