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

- **Conditions that change rolls (M).** Advantage and Disadvantage from conditions are the
  caller's today (`mode`): an attacker that's Blinded, Invisible, Prone, Restrained or Poisoned;
  a target that's Blinded, Paralyzed, Prone (within 5 ft or not), Restrained, Stunned or
  Unconscious; automatic Critical Hits on a Paralyzed or Unconscious target within 5 feet;
  automatic failures on Strength and Dexterity saves while Paralyzed, Stunned or Unconscious.
  Needs the conditions' mechanics as data (like `speed_zero`) and positions or a "within 5 feet"
  flag on attacks.
- **Positions, reach and cover (L).** Distances, reach and range (normal and long range),
  Half and Three-Quarters Cover, areas of effect choosing their targets. Today the caller decides
  who is in range and in an area.
- **Legendary actions and Legendary Resistance (M).** Uses per round, spent after another
  creature's turn and regained at the start of the monster's turn; Legendary Resistance uses per
  day. Both are in the stat blocks' text (`legendary_text`, the trait's name).
- **Monster spellcasting (M).** Read the Spellcasting action's spell lists into catalog ids with
  their DC, attack bonus and uses (at will, 1/Day), so monsters can `cast`.
- **"X/Day" and other limited monster uses (S).**
- **Ongoing area effects (L).** Spells and traits that deal damage when a creature enters an area
  or starts its turn there (Moonbeam, Spirit Guardians, Cloud of Daggers, a Remorhaz's swallowed
  creature): an encounter "zone" with triggers. Most of the 79 spells left as text need this.
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
- **Class features still text (M, ongoing).** Features that roll dice or change rolls in
  situations: Reckless Attack, Danger Sense, Potent Spellcasting, Channel Divinity options,
  Bardic Inspiration, Cunning Strike… Most fit the existing riders, Advantage and toggles.
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

- **Encounter CLI (M).** `srd-rules fight`: an encounter in the terminal with saved characters and
  SRD monsters.
- **Authoring toolkit (M).** Shared helpers in `scripts/lib/` for the importers (slugs, Markdown
  sections and tables, overlay merge, YAML output) and a documented "transcribe → draft → review →
  golden test" recipe, also for private packs. Optionally port `import-srd-classes.py` to
  TypeScript so every importer can use them.
