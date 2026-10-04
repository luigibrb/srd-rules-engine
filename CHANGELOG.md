# Changelog

All notable changes are documented here. This project follows
[Semantic Versioning](https://semver.org/); until 1.0, minor versions may contain breaking changes.

## [Unreleased]

### Changed
- A monster's legendary saving throw effects are no longer in `save_actions`: only the
  encounter action `legendary` uses them.
- The published `srd-5.2.1.json` is minified (about 2 MB instead of 3.8 MB).
- Docs: README reorganized by use (builder, play, combat, spells, monsters, encounters, packs);
  ARCHITECTURE.md restructured, with every flagged interpretation in one section;
  `docs/ROADMAP.md` (what's done, decisions, next steps) replaces the roadmap review;
  "Writing your own pack, step by step" in CONTENT.md.
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
- Class features that change rolls: Danger Sense, Reckless Attack (ends at the start of your
  next turn in encounters), Feral Instinct, Frenzy, Evasion (also the Assassin's), Reliable
  Talent, Primal Strike, Colossus Slayer, Potent Spellcasting, Potent Cantrip, Empowered
  Evocation, Elemental Affinity. Content: Advantage targets `initiative`, `attack.str`,
  `attacked` and the `{target, unless}` form; toggle `ends_at_turn_start`; rider `while_active`,
  `requires: target_damaged` and `{progression, die}` damage; grants `rules` (`FEATURE_RULES`)
  and `spell_damage`. Sheet `rules` and `spell_damage`; combatant `rules`,
  `proficient_skills`, `spell_damage`.
- Monster spellcasting: monster action fields `casts` (the Spellcasting action's lists, other
  actions that cast spells, legendary actions that use Spellcasting; 97 in the SRD) and `per_day`
  ("(2/Day)"); `monsterSpells`, `MonsterSpellLine`; monster combatants get a spellcasting line
  per casting action. The encounter action `cast` works for monsters (`via` picks the action;
  fixed levels, daily uses, Recharge), `legendary` casts a legendary action's spell, and
  "(N/Day)" attacks and saving throw effects are limited (`daily_used`). The encounter `cast`
  action's `targets` is optional.
- Weapon Mastery properties in encounters: Graze (damage on a miss), Vex, Sap and Slow (encounter
  `masteries`, ending on the attacker's turns), Topple (Constitution save or Prone), Push (noted),
  Cleave (`attack` with `cleave: true`, once per turn; `AttackLine.cleave_damage_parts`), Nick
  (the Light extra attack as part of the Attack action). `attack` takes `mastery: false` to skip
  them; `makeAttack` takes `cleave`.
- Standard combat actions in encounters: `dodge`, `disengage` (and `dash`) with `bonus_action`
  for features that allow it; `help` (an ally's next attack roll against an enemy, or its next
  check with a skill you're proficient in); `unarmed` (Grapple and Shove: a Strength or
  Dexterity save against 8 + Strength modifier + Proficiency Bonus; size limit); `escape`
  (Athletics or Acrobatics against the grapple's escape DC; `effects` takes `escape_dc`);
  `stand` (half the Speed); `attack` with `opportunity` (refused against a Disengaged target)
  and `light_extra` (the Light property's extra attack as a Bonus Action). Grapples end when
  the grappler is Incapacitated. Encounter fields `dodging`, `disengaged`, `light_attacks`,
  `helps`, effects' `escape_dc`; `AttackLine.light_extra_damage_parts` (Two-Weapon Fighting
  keeps the modifier); `Combatant.size`; `makeAttack` options `modes` and `light_extra`;
  `rollAbilityCheck` option `modes`.
- Ability checks and skills: `rollAbilityCheck`, the sheet's `ability_checks`, combatants'
  `ability_checks` and `skills`, the condition field `ability_checks` (Poisoned, Frightened), the
  encounter action `check`. Encounters roll a dying character's Death Saving Throw at the start of
  its turn (`createEncounter({ auto_death_saves: false })` to keep the reminder instead).
- Legendary actions and Legendary Resistance: monster fields `legendary_uses`,
  `legendary_resistance`, and `once_per_round`, `attacks`, `uses` on legendary actions;
  combatants' `legendary_actions` and `legendary_resistance` (a failed save succeeds instead,
  `SaveResult.legendary_resistance`); `MonsterState` `in_lair`, `legendary_resistance_used`,
  `auto_legendary_resistance`. Encounter action `legendary` (after another creature's turn, uses per
  round and in the lair, once-per-round limits), Legendary Resistance counted in encounters,
  `add_monster` `in_lair` and `auto_legendary_resistance`.
- Conditions change rolls: condition fields `attack_rolls`, `attacked`, `attacked_beyond_5ft`,
  `critical_within_5ft`, `fail_saves`, `save_disadvantage`, `initiative`,
  `except_against_source`; `Combatant.condition_rolls`, `conditionRolls`, `attackMode`,
  `resolveMode`. Attacks and spell attacks get Advantage or Disadvantage from both sides'
  conditions (`within_5ft` option; `reasons` in the result), automatic Critical Hits within 5 feet
  on Paralyzed or Unconscious targets; saves fail automatically (`automatic_failure`) or roll
  with Disadvantage; Initiative too. `combatantFromMonster` takes the catalog's `conditions`.
- Encounters track a condition applied with a `source` even without a duration (Grappled's
  exception for the grappler), and drop an effect whose condition was removed.
- `npm run content` reports the bundled SRD's size (minified, gzipped, largest tables) and
  fails when the gzipped size is over the budget (`MAX_GZIP_KB`).
- Encounter turn rules: `attack` (Attack action with Extra Attack / Multiattack, Opportunity
  Attacks, once-per-turn riders), `save_action` (Recharge), `cast` (casting time, prepared
  spells, Concentration spells' conditions as effects), timed effects with durations
  (`effects` with `rounds` / `until`, `end_effect`), automatic Concentration saves on damage,
  Rage ending when not extended (`extends_each_turn` toggles, `extend`). Monsters have
  `multiattack`. `applyEncounterAction` also returns the `result` of an attack, save or cast.
- Encounters: an `Encounter` document and `applyEncounterAction` (add monsters and characters,
  Initiative with surprise and group rolls, turn order and ties, rounds and turns, action /
  Bonus Action / reaction, movement and Dash, `effects` routing attack and spell results to
  monsters and characters, Monster Death), `encounterCombatant`, `currentCombatant`.
  `POST /v1/encounters/apply`.
- Monsters: a `monsters` content table with all 330 SRD stat blocks (`import-srd-monsters.ts`),
  `combatantFromMonster`, and `useSaveAction` for saving throw effects such as breath weapons.
  Combatants have `condition_immunities` (respected by spells and save effects) and
  `save_actions`; attack lines' `ability` can be `null` (monsters).
- Effects, step 1: `damage_riders` (dice, flat or a class table column; automatic or optional;
  Rage Damage, Sneak Attack, Divine Strike), `advantages` (`save.str`…, applied by
  `rollSavingThrow`) and `toggles` (features switched on in play: Rage). Play state `active`,
  actions `activate`/`deactivate`, CLI `on`/`off`; `makeAttack` takes `riders` and
  `ally_adjacent` (also in `POST /v1/state/attack`). Attack lines have `ability`, `weapon`,
  `properties` and `riders`; the sheet has `advantages` and `toggles`.
- Spell `mechanics` (attack or save, damage by type, healing, targets, upcasting, Cantrip
  Upgrade, conditions, area) for 53 reviewed SRD spells (drafted by a parser in
  `import-srd-spells.ts`, each checked against its text), and `castSpell` to resolve them between
  combatants, with the play actions that apply the result. `POST /v1/state/cast`.
- Combatants have `level` and `spellcasting` (save DC, attack bonus, modifier per feature).
- Combatants (`rules/combatant.ts`): `combatantFromCharacter` (build + play state),
  `combatantFromSnapshot` (the old `Character`), `makeAttack` (attack lines, critical range,
  Advantage/Disadvantage, two-handed Versatile damage, a preview of the damage),
  `rollSavingThrow`, `rollD20`. `POST /v1/state/attack` resolves an attack between two
  characters and applies the damage to the target's state.
- The play action `damage` accepts `instances: [{ amount, type }]` instead of `amount`, each
  adjusted for its own type.
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
- Level-up to 20, one level at a time: `levelUp`, `setLevelHp`, `removeLastLevel`,
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

### Deprecated
- The `Spell` model (`SpellSchema`) and the `Character` spell functions (`spellSaveDc`,
  `spellAttackBonus`, `castSpellAttack`, `castSpellSave`, `castSpellDamage`, `resolveSpellAttack`,
  `resolveSpellSave`), and `POST /v1/spells/attack` and `/save`: use `castSpell` and
  `POST /v1/state/cast`. Kept until 1.0.
- `resolveAttack` and `attackRoll` (hand-filled `Character`): use `makeAttack` with combatants.
  `POST /v1/combat/attack` too: use `POST /v1/state/attack`. Kept until 1.0.

### Fixed
- `GET /v1/content/magic_items` (and `magic-items`) returned 404: table names with `_` didn't match.
- The Blowgun's fixed damage no longer adds the ability modifier (SRD "Damage Rolls").
- While Petrified, untyped damage is halved too (Resistance to all damage).
