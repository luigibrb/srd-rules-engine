# Roadmap

What's done, the decisions behind it, and what comes next.

## Done

The P0–P7 plan came from a review of an earlier roadmap against the code (2026-09-28); each phase
was a branch merged into `main`. Details are in the CHANGELOG and the commits.

| Phase | What | Notes |
|---|---|---|
| P0 | Guard rails: closed effect targets and conditions, `source` defaults to the pack's name, leak guard | |
| P1 | Content packs: `pack.yaml` manifests, `patches.yaml`, filtering by source, builds that record their packs, public API snapshot | Patches apply to the parsed entity (defaults filled in, so paths are stable) and it's validated again. Exports stay `export *`, guarded by the snapshot |
| P2 | One damage function (`takeDamage`), structured attack damage (`damage_parts`) | Fixed on the way: the Blowgun's fixed damage added the ability modifier; Petrified didn't halve untyped damage |
| P3 | Combatants, `makeAttack` (critical range, Advantage, Versatile), `POST /v1/state/attack` | The `Character` functions weren't rebuilt on combatants (different result shapes): deprecated as they are |
| P4 | Spell mechanics as data and `castSpell`; 53 reviewed SRD spells, drafted by a parser in the importer | All 43 parser drafts reviewed against their text: 38 used, 2 rejected, 3 corrected; the review found and fixed 5 parser bugs |
| P5 | Effects: damage riders (Rage Damage, Sneak Attack, Divine Strike), Advantage, toggles (Rage) | A toggle's grants apply while it's active, so no new `when` conditions were needed |
| P6 | Monsters: all 330 SRD stat blocks, `combatantFromMonster`, `useSaveAction` | Reviewed by invariants on every stat block plus 15 golden ones; two Markdown typos corrected in the importer's `FIXES`. The bundled JSON grew to ~3.9 MB |
| P7 | Encounters: Initiative, turns and rounds, action economy, attacks and spells in turns, timed effects, Concentration saves, recharges, once-per-turn riders, Rage's duration | Split in two: the encounter document and turns (P7a), then the rules that need turns (P7b) |
| P8 | Conditions change rolls: Advantage and Disadvantage on attacks, automatic Critical Hits within 5 feet, automatic save failures, Initiative | "Within 5 feet" is given per attack (no positions yet). Encounters now track any condition with a known source, which gives Grappled's exception for the grappler |
| P9 | Legendary actions and Legendary Resistance: uses per round and per day (lair values), once-per-round actions, attacks, used actions and saving throw effects resolved in encounters | Legendary Resistance is spent automatically unless turned off per monster; legendary actions that cast spells stay text until monster spellcasting |
| P10 | Ability checks and skills (`rollAbilityCheck`, the encounter `check` action); Death Saving Throws rolled at the start of a dying character's turn | Automatic death saves can be turned off per encounter |
| P11 | Standard combat actions: Dodge, Disengage, Help, Grapple and Shove (with escaping and standing up), two-weapon fighting | Help and Dodge live in the encounter (`helps`, `dodging`), not in conditions; Help's Advantage covers weapon attacks, not spell attacks |
| P12 | Weapon Mastery effects in encounters: Graze, Vex, Sap, Slow, Topple, Push (noted), Cleave, Nick | Applied by default (`mastery: false` skips them); Vex, Sap and Slow are encounter marks with the same turn-based ends as effects |
| P13 | Monster spellcasting: 97 casting actions as data (spell lists, fixed levels, daily uses), monsters casting in encounters, legendary actions that cast, "X/Day" limits | One schema for every casting action (`casts`); a missing save DC or attack bonus is derived (flagged); a misspelled spell name corrected in the importer |
| P14 | Class features that change rolls: Danger Sense, Reckless Attack, Feral Instinct, Frenzy, Evasion, Reliable Talent, Primal Strike, Colossus Slayer, Potent Spellcasting, Potent Cantrip, Empowered Evocation, Elemental Affinity | Data first (new Advantage targets, rider gates, `spell_damage`); three named rules in code behind a closed `rules` list |
| P15 | Class features used in turns: Second Wind, Action Surge, Lay On Hands, Flurry of Blows, Patient Defense, Step of the Wind, Stunning Strike, Uncanny Dodge, Bardic Inspiration | One `actions` grant for all of them; the encounter action `feature`; Bardic Inspiration used automatically on a failed D20 Test (flagged) |
| P16 | Decisions after a roll (Bardic Inspiration, Legendary Resistance, Uncanny Dodge): `ask` stops the action with the roll shown until `decide`, `auto` uses them only when they can change the outcome; per combatant or per encounter | Resumed by replaying the action with its recorded dice, so nothing is undone; it replaces P15's automatic Bardic Inspiration and the `target_feature` option |
| P17 | `srd-rules fight`: an encounter in the terminal with saved characters and SRD monsters, decisions as y/n questions | Playing fights by hand led to fixes in the engine's notes (each target of a spell, skill names, which character refused a change) and in the CLI's name matching |
| P18a | Positions on a 5-foot grid (optional): distances, reach, normal and long range, close combat, thrown weapons, spell range, movement to a square with Opportunity Attacks noted, cover given per attack or target | Positions are optional: without them the caller still says what's within 5 feet or in range. Areas of effect are P18b |

## Decisions

Taken with the P0–P7 plan; they still hold.

- Patches are a small list of operations (`set`, `append`, `remove` on a path), not JSON Merge
  Patch, which can't append to lists.
- Builds may list the packs they need (`packs`, optional), so loading one without them says so.
- The `Character`-based API and its routes stay as deprecated adapters until 1.0.
- `import-srd-classes.py` stays in Python for now.
- The leak guard runs in CI (`npm run check`); no pre-commit hook dependency.
- No `ruleset` field beyond the manifest's informational one: the engine targets the 2024
  rules, and older material is converted by hand.
- No registry for new tables from packs: selectable options (maneuvers, infusions) fit the
  `features` table with a `category`, and monsters are a core table.
- A spell's or monster's mechanics are used only after a review against the SRD text; what a
  parser can't read safely stays text.

## Next steps

Grouped by area, roughly in order of value for a VTT. Sizes are rough: S (a day or less), M (a
few days), L (a week or more). "Flagged" items are interpretations listed in
[ARCHITECTURE.md](ARCHITECTURE.md#interpretations-flagged-not-invented) that a rule could replace.

### Combat rules

- **The other actions (S).** Hide (the Invisible condition while hidden, found by Search),
  Ready (a trigger and a reaction), Influence, Study and Utilize are left to the GM; Help's
  Advantage and Sap's Disadvantage don't reach spell attack rolls yet.
- **Areas of effect on the grid (M, P18b).** Spheres, cubes, cones, lines and emanations choosing
  their targets from positions (a point, a direction), so `cast` needs no target list.
- **A map (L).** Walls, Difficult Terrain and obstacles on the grid: paths and their cost, line
  of sight, cover worked out instead of given.
- **Ongoing area effects (L).** Spells and traits that deal damage when a creature enters an area
  or starts its turn there (Moonbeam, Spirit Guardians, Cloud of Daggers, a Remorhaz's swallowed
  creature): an encounter "zone" with triggers. Most of the 79 spells left as text need this.
- **Legendary actions, what's left (M).** Legendary actions, their spells and Legendary
  Resistance are resolved (P9, P13); still text: the movement, teleports or healing that come with
  some of them.
- **Monster spellcasting, what's left (S).** A Multiattack's "replace one attack with a use of
  Spellcasting"; spells with a casting time of a minute or more (the Magic action on each turn,
  with Concentration); the two casting actions left as text (Pit Fiend, Unicorn); restrictions
  such as "self only".
- **Smaller flagged items (S each).** Divine Strike only on your own turns; which attacks a
  Multiattack allows; Rage's 10-minute cap; Dash with a Fly or Swim Speed; durations written only
  in a spell's text (Color Spray's blindness "until the end of your next turn").

### Content coverage

- **Spells left as text (L, ongoing).** 79 spells have effects the parser doesn't read
  (listed by `npx tsx scripts/import-srd-spells.ts --report`): hand-written `MECHANICS` entries,
  or new parser patterns, each reviewed against the SRD text. Many need ongoing area effects
  first.
- **Spell mechanics the schema can't express yet (M).** A flat bonus per dart (Magic Missile),
  spells with both an attack and a save, and riders on a hit such as Guiding Bolt's Advantage on
  the next attack.
- **Monster save effects left as text (M).** 19 effects without plain damage or conditions
  (slowing, weakening, curses), listed by `import-srd-monsters.ts --report`.
- **Class features used in turns, what's left (M).** Indomitable (a reroll of a failed save),
  Channel Divinity options (Divine Spark, Turn Undead, Sacred Weapon), Cunning Strike, Relentless
  Rage, Brutal Strike, Innate Sorcery, Deflect Attacks, Agonizing Blast (a choice of cantrip),
  Stunning Strike's successful-save effects, Lay On Hands' cure for Poisoned.
- **Magic items' active powers (L).** Wands, staffs and items with actions are text; charges are
  tracked, their effects aren't.
- **Starting gold and shopping (S).** Fighter option C and background option B.

### Engine and API

- **A `version` field on builds and states (S).** When the first migration is needed; a document
  without one is version 1.
- **1.0 cleanup (M).** Remove the deprecated `Character` API (`resolveAttack`, `attackRoll`, the
  `Spell` model, the `Character` spell functions, `/v1/combat/attack`, `/v1/spells/attack` and
  `/save`), and stop exporting internal helpers (`answers`, `definedEntries`, `replaceErrors`,
  `choiceIssues`, `classLevelKey`, `entityName`…) with explicit exports.
- **Split content by table (M).** The whole SRD is bundled into the core entry (about 2 MB
  minified, 290 KB gzipped; monsters, magic items and spells are three quarters of it). When
  `npm run content` reports it over its gzip budget, publish the large tables as separate JSON
  assets loaded on demand (monsters and magic items first), with `srdCatalog()` still returning
  every table for servers.
- **JSON Schemas for play documents (S).** `CharacterState` and `Encounter` have Zod schemas but
  no generated JSON Schema yet (builds and content do).

### Tools

- **Authoring toolkit (M).** Shared helpers in `scripts/lib/` for the importers (slugs, Markdown
  sections and tables, overlay merge, YAML output) and a documented "transcribe → draft → review →
  golden test" recipe, also for private packs. Optionally port `import-srd-classes.py` to
  TypeScript so every importer can use them.
