# Changelog

All notable changes are documented here. This project follows
[Semantic Versioning](https://semver.org/); until 1.0, minor versions may contain breaking changes.

## [Unreleased]

### Changed
- Ported the engine from Python (FastAPI, Pydantic) to TypeScript. Saved builds keep the
  same JSON format, so characters saved by the Python builder still load.
- The HTTP API is now a framework-free `fetch` handler (`srd-rules-engine/http`) that runs on
  Node, Deno, Bun and Cloudflare Workers. Routes and payloads are unchanged.
- `/v1/spells/save` also returns `damage_dealt`.
- Dice expressions are limited to 1000 dice of up to 1000 sides.

### Added
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
