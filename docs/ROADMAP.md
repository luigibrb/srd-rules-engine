# Roadmap

What's done, and what comes next. The review that set the current plan, with the decisions and
what each phase did, is in [ROADMAP-REVIEW.md](ROADMAP-REVIEW.md).

## Done

| Phase | What |
|---|---|
| P0 | Guard rails: closed effect targets and conditions, `source` defaults to the pack's name, leak guard |
| P1 | Content packs: `pack.yaml` manifests, `patches.yaml`, filtering by source, builds that record their packs, public API snapshot |
| P2 | One damage function (`takeDamage`), structured attack damage (`damage_parts`) |
| P3 | Combatants, `makeAttack` (critical range, Advantage, Versatile), `POST /v1/state/attack` |
| P4 | Spell mechanics as data and `castSpell`; 53 reviewed SRD spells, drafted by a parser in the importer |
| P5 | Effects: damage riders (Rage Damage, Sneak Attack, Divine Strike), Advantage, toggles (Rage) |
| P6 | Monsters: all 330 SRD stat blocks, `combatantFromMonster`, `useSaveAction` |
| P7 | Encounters: Initiative, turns and rounds, action economy, attacks and spells in turns, timed effects, Concentration saves, recharges, once-per-turn riders, Rage's duration |

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
- **Smaller browser bundle (S).** The bundled SRD JSON is about 3.9 MB with monsters; a separate
  `srd-rules-engine/monsters` entry point would keep the core near 2.3 MB. A breaking change for
  code that reads `catalog.monsters` from `srdCatalog()`.
- **JSON Schemas for play documents (S).** `CharacterState` and `Encounter` have Zod schemas but
  no generated JSON Schema yet (builds and content do).

### Tools

- **Encounter CLI (M).** `srd-rules fight`: an encounter in the terminal with saved characters and
  SRD monsters.
- **Authoring toolkit (M).** Shared helpers in `scripts/lib/` for the importers (slugs, Markdown
  sections and tables, overlay merge, YAML output) and a documented "transcribe → draft → review →
  golden test" recipe, also for private packs. Optionally port `import-srd-classes.py` to
  TypeScript so every importer can use them.
