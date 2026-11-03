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
| P21 | More zones: moves followed square by square (zones entered on the way, a creature held stops), damage per 5 feet moved (Spike Growth), saves the caster may force (Conjure Animals, Conjure Woodland Beings) as a decision, Stinking Cloud, Sleet Storm, Flaming Sphere | A move to a square goes straight, diagonals first, unless a `path` is given; forced saves default to enemies only (flagged) |
| P20 | Spell areas that last (zones): Moonbeam, Spirit Guardians, Cloudkill, Insect Plague, Incendiary Cloud, Black Tentacles, Web, Grease; saves on entering, at the start or end of a turn, when the zone moves; `zone_save`, `move_zone`, `end_zone`; escaping a spell's hold | Entering is judged by where a move ends (flagged); a zone's later rolls get no feature bonuses. Walls, Spike Growth, the Conjure spells and Stinking Cloud stay text |
| P19 | Spell mechanics the schema couldn't express: flat damage bonuses, darts and rays (Magic Missile, Scorching Ray), a save after an attack (Ice Knife), hit riders (Guiding Bolt), conditions until the caster's next turn; Help, Vex and Sap on spell attack rolls | Guiding Bolt's Advantage is an encounter mark like Vex's, usable by anyone. Darts share one damage roll (flagged). Five spells gained mechanics: Magic Missile, Scorching Ray, Ice Knife, Disintegrate, Finger of Death |
| P18b | Areas of effect on the grid: spells' and monster effects' Spheres, Cylinders, Cubes, Cones, Lines and Emanations choose their targets from a point or a direction; monster save effects' areas and ranges read from their text | How shapes cover squares is an engine reading (flagged): a square is in when its center is inside |
| P22 | What a combatant can do now: `combatantOptions` (attacks, spells, features, monster abilities, legendary and standard actions, zones, each with cost, targets and the reason it's refused) and `checkAction` (a dry run); `POST /v1/encounters/options` and `/check`; the fight CLI's `options` built on them | Legality comes from a dry run of `applyEncounterAction` with fixed dice, never re-derived; pure helpers moved out of the encounter's `run` first |
| P23 | The bundled SRD out of the main entry: `srd-rules-engine/srd`; the SRD published split by table with `splitPack`/`loadPack`; catalogs with only some tables (`tables`, `CORE_TABLES`); a gzip budget for the core tables | Reading a table that wasn't loaded throws instead of returning nothing. Validating the full SRD at startup took about 70 ms in Node, so precompiled content is still parsed |
| P24a | A map for encounters: walls between squares, Difficult Terrain and blocked squares (`set_terrain`, `add_wall`, `remove_wall`), step costs, creatures' spaces passed through or not, the cheapest path around obstacles, zones that are Difficult Terrain, Opportunity Attacks judged at the step that leaves reach; the fight CLI draws them | Walls are segments between grid corners, so a diagonal can't cut a corner (flagged); a move goes straight when it can, else by the cheapest path; Spirit Guardians' halved Speed is left for later |
| P24b | Cover and line of effect from the map: cover worked out for attacks, spells and save effects (walls, blocked squares, creatures in between), Total Cover can't be targeted, areas and zones stop at walls, Dexterity saves get cover from an area's point of origin; options leave out targets behind Total Cover | The DMG's corner-lines method (flagged); creatures give Half Cover against areas too; cover given by the caller still wins |
| P25 | Previews for a map: `reachableSquares`, `previewMove` (path, cost, zones on the way, Opportunity Attacks), `previewArea` (squares, creatures and their cover); routes `/v1/encounters/reachable`, `/preview-move`, `/preview-area` | Built on the planning `move` and `cast` use (`planMove`, `placeArea`, moved out of the encounter's `run`), so a preview and the action agree |
| P26 | Events (what an action changed, as data), refusal codes on every refusal, undo by replaying a history of actions with their dice; the fight CLI's `undo` | Events come from comparing documents before and after, not from each rule; codes from one table of message patterns |
| P27 | Odds in options: chance to hit and to crit, or that the target fails its save, and the average damage; `attackOdds`, `failOdds`, `averageDamage`; shown by the fight CLI's `options` | Read from the option's dry run (its d20 is 10), so they use the modifiers the engine would; Legendary Resistance and Bardic Inspiration aren't counted |
| P28 | The other actions: Hide (Invisible while hidden, ended by attacks, Verbal spells, being found), Search, Ready (a held spell with Concentration, a readied move) and `release`, Study, Influence, Utilize; in options and the fight CLI | Line of sight for Hide is read as Three-Quarters Cover from every enemy (flagged); triggers are the caller's |
| P29a | Class features used in turns: Indomitable (a decision), Deflect Attacks, Stunning Strike's successful-save effects, Lay On Hands' cure, Innate Sorcery, Channel Divinity's Divine Spark and Turn Undead | Data first: new `actions` fields (several targets, range, creature types, the spell save DC, save damage, effects on a success, conditions removed); one named rule (`indomitable`) |
| P29b | Cunning Strike (Poison, Trip, Withdraw), Brutal Strike (Forceful, Hamstring, Staggering, Sundering), Relentless Rage, Agonizing Blast, Sacred Weapon; saves repeated at the end of each turn | Strikes are `attack` options checked before the roll; four named rules; Withdraw, Forceful Blow and Sacred Weapon simplified (flagged) |
| P30 | Wall spells on the map: Wall of Force, Stone and Ice between squares; Blade Barrier, Wall of Thorns and Wall of Fire as zones of squares (cover, movement cost, Difficult Terrain, a damaging side, damage without a save) | Straight walls only; rings, domes, breaking walls are text (flagged) |
| P31 | Smaller rules: toggles with a duration (Rage's 10 minutes, Innate Sorcery, Sacred Weapon), Divine Strike only on your own turns, Spirit Guardians' halved Speed | Durations count the character's turn starts in an encounter |
| P32 | More spells as data: Hunter's Mark and Hex (marks on the caster's hits, `move_mark`), Divine Smite (after a hit, doubled on a crit, more against Fiends and Undead), Flame Strike, Chain Lightning, Mass Suggestion (Charmed until damaged) | 84 spells with mechanics; the rest of each spell's text (Hex's ability, Chain Lightning's 30 feet) stays the GM's (flagged) |
| P33 | Shopping: SRD prices and weights for 100 items of gear and every tool (`scripts/import-srd-gear.ts`), the play actions `buy` and `sell` with change, carried weight for gear; `buy`/`sell` in `srd-rules play` | Paid with the smallest coins first; sold for half (SRD); magic items need a price |
| P34 | Monster traits in turns: damage auras, Death Burst and Death Throes, Regeneration, Aura of Authority (14 traits, read from their sentences by the importer) | A regenerating monster at 0 HP is Unconscious until it dies or regenerates (flagged) |
| P35 | Table settings out of the encounter: `EncounterSettings` (decisions, Death Saving Throws, positions) given with each call, recorded on each history step; document format 2 (version 1 histories migrate, `legacyEncounterSettings` for encounters); the halt on a noticed point removed (event `noticed`) | Per-combatant decisions by combatant id or character key |
| P36 | Summoned creatures: stat block templates that scale (`summons`, `rules/templates.ts`), `mechanics.summon` for the SRD's seven summoning spells, their turns after the caster's or their own, their endings; casting outside a fight; when things end in pure functions (`services/lifetimes.ts`) | Commands to a summoned creature are the table's; Find Steed's mount rules are text (flagged) |
| P37 | Summons from features: a feature that casts a spell without a slot, spending its uses (the Druid's Wild Companion), or brings creatures itself, their stat blocks scaling with the class level | Casting Find Familiar through Wild Companion with a spell slot instead is by hand; the familiar leaving on a Long Rest is text |
| P38 | Content schema gaps: grants at a character level (the SRD lineages' level 3 and 5 spells), an attunement limit from content, feats exclusive to their category, a one-third caster progression, dice in spell damage bonuses | A one-third caster rounds up (flagged) |
| P39 | Reactions to another creature's d20 roll (`modifies_roll`): offered after the roll as a decision, the reaction and use spent; the College of Lore's Cutting Words | Offered only in the reactor's interest (flagged); Cutting Words on damage rolls is by hand |
| P40 | Spell hit riders as marks: Shocking Grasp (no Opportunity Attacks), Ray of Frost (−10 ft Speed), Chill Touch (no healing); Chromatic Orb's chosen damage type | Chromatic Orb's leap and Starry Wisp's light stay text (flagged) |
| P41 | The content gaps left: spells added to a character's spell lists, a tool or another when already proficient, a save around the creature a ranged or melee hit struck | Homebrew tests (no SRD example) |
| P42 | Light riders: a failed save's marks (`on_failed_save`), `outlined` (Advantage against) and `revealed` (no benefit from the Invisible condition) | Faerie Fire, Starry Wisp |
| P43 | Devious Strikes: Daze, Knock Out and Obscure as Cunning Strike effects, each paid with its dice of Sneak Attack | SRD Rogue level 14 |
| P44 | Deflect Attacks' redirect: a feature action right after its user's reaction took an attack's damage to 0 (`after_damage_reduced`), with the attack's damage type and range | SRD Monk level 3 |
| P45 | Font of Magic: spell slots and Sorcery Points exchanged (`slot_exchange`), created slots in the play state until a Long Rest | SRD Sorcerer level 2 |
| P46 | Metamagic on `cast` (Careful, Distant, Extended, Heightened, Quickened, Subtle, Transmuted, Twinned) and "One Spell with a Spell Slot per Turn" | Empowered and Seeking Spell are by hand (flagged) |
| P47 | Subclass features in turns: Wholeness of Body, Open Hand Technique, Survivor, Sculpt Spells, Dark One's Blessing, Fiendish Resilience | Data where it fits (an action, a rest-change choice); five named rules |

## Decisions

Taken with the P0–P7 plan; they still hold.

- Patches are a small list of operations (`set`, `append`, `remove` on a path), not JSON Merge
  Patch, which can't append to lists.
- Builds may list the packs they need (`packs`, optional), so loading one without them says so.
- The `Character`-based attack and spell functions and their routes were removed before 1.0;
  the other `Character` routes (validation, alive, passive Perception, saving throw, spell stats)
  stay.
- Saved documents carry one format version (`DOCUMENT_VERSION`); a format change migrates older
  versions when they're parsed.
- `import-srd-classes.py` stays in Python for now.
- The leak guard runs in CI (`npm run check`); no pre-commit hook dependency.
- No `ruleset` field beyond the manifest's informational one: the engine targets the 2024
  rules, and older material is converted by hand.
- No registry for new tables from packs: selectable options (maneuvers, infusions) fit the
  `features` table with a `category`, and monsters are a core table.
- A spell's or monster's mechanics are used only after a review against the SRD text; what a
  parser can't read safely stays text.

## Next steps

In priority order: each tier before the next, items within a tier in any order. Sizes are rough:
S (a day or less), M (a few days), L (a week or more). "Flagged" items are interpretations listed
in [ARCHITECTURE.md](ARCHITECTURE.md#interpretations-flagged-not-invented) that a rule could
replace. A feature asked for by non-SRD content is built as a general rule, with an SRD example
or invented homebrew in its tests.

### Priority 1: now

- **Split the encounter reducer by area (M, alongside features).** `applyEncounterAction` runs
  every action in one closure whose helpers share and change the document: turn timing, effects
  and Concentration, action economy, attack situation, spells' targets, zones, monster traits in
  turns. Move each area into its own module of functions that take plain facts and return what
  happens (effects that end, saves due, refusals with their reasons), applied by the reducer,
  with direct tests; no change in behavior (the seeded demo and the history replays keep the
  dice in the same order). Done area by area, when a feature touches it; what ends effects,
  marks, zones and summons is done (`services/lifetimes.ts`, P36), and a turn's spell limits,
  Metamagic and Daze (`services/spell-turn.ts`). The new functions stay
  internal.

### Priority 2: next

- **Spell riders, what's left (S).** Chromatic Orb's leap on doubles.
- **Spells left as text (L, ongoing).** 41 spells have effects the parser doesn't read
  (listed by `npx tsx scripts/import-srd-spells.ts --report`): hand-written `MECHANICS` entries,
  or new parser patterns, each reviewed against the SRD text. Many need the riders above, or
  ongoing area effects, first.
- **Class features used in turns, what's left (M).** Wild Shape, Empowered and Seeking Spell
  (rerolls after the roll); subclass features still text: Mindless Rage, Retaliation,
  Intimidating Presence, Peerless Skill, Preserve Life and the Life Domain's healing features,
  Land's Aid, Nature's Ward and Sanctuary, Heroic Warrior, Fleet Step, Quivering Palm, Aura of
  Devotion, Smite of Protection, Holy Nimbus, Horde Breaker, the Hunter's later features, the
  Thief's features, Dragon Wings and Companion, Dark One's Own Luck, Hurl Through Hell,
  Overchannel.

### Priority 3: later

- **Created items that expire (M).** Items a spell or feature creates for a while (Goodberry's
  berries): in the inventory with their duration, gone when it ends.
- **Magic items' active powers (L).** Wands, staffs and items with actions are text; charges are
  tracked, their effects aren't.
- **Monster traits, what's left (M).** Traits worded differently from the four read so far
  (Sunlight Sensitivity, Engulf, Magic Resistance…).
- **Legendary actions, what's left (M).** Legendary actions, their spells and Legendary
  Resistance are resolved (P9, P13); still text: the movement, teleports or healing that come with
  some of them.
- **Monster spellcasting, what's left (S).** A Multiattack's "replace one attack with a use of
  Spellcasting"; spells with a casting time of a minute or more (the Magic action on each turn,
  with Concentration); the two casting actions left as text (Pit Fiend, Unicorn); restrictions
  such as "self only".
- **Monster save effects left as text (M).** 23 effects without plain damage or conditions
  (swallowing, slowing, weakening, curses), listed by `import-srd-monsters.ts --report`.
- **Lair actions (M).** Actions a creature takes in its lair, on Initiative count 20, for packs
  whose monsters have them (the SRD gives only extra legendary uses in a lair).
- **Light and obscurement (M).** Bright Light, Dim Light and Darkness on the map, Darkvision and
  Heavily Obscured areas: noticing points of interest, hiding and attacking see only walls today
  (flagged).
- **Walls, what's left (M).** Ringed walls, domes and globes, breaking a wall's sections, Wall of
  Ice's frigid air, walls that cut through a creature's space.
- **Smaller flagged items (S each).** Which attacks a Multiattack allows; Dash with a Fly or Swim
  Speed (movement modes).

### Priority 4: when needed

- **Public rules layer (M).** For clients with their own data (a bot, another tabletop): the
  functions split out of the encounter reducer, exported as a documented layer under the
  documents and their reducers (`makeAttack`, `takeDamage`, `castSpell`, `rollByHand` already
  work this way), possibly with its own entry point. When a client needs a rule without the
  `Encounter` document.
- **Views for one viewer (M).** An encounter and query results as one participant may see them
  (hidden creatures, what only the GM knows), for shared play.
- **Authoring toolkit (M).** Shared helpers in `scripts/lib/` for the importers (slugs, Markdown
  sections and tables, overlay merge, YAML output) and a documented "transcribe → draft → review →
  golden test" recipe, also for private packs. Optionally port `import-srd-classes.py` to
  TypeScript so every importer can use them. Grown from the importers as they need it.
