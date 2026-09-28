# Architecture

How the engine is built and why. What comes next is in [ROADMAP.md](ROADMAP.md); how to write
content is in [CONTENT.md](CONTENT.md).

## Overview

Three kinds of saved documents, each plain JSON, and rules content as data:

- a **build** (`CharacterBuild`): the player's choices, from which every number is derived;
- a **play state** (`CharacterState`): what's spent or chosen at the table (HP, slots, items…);
- an **encounter** (`Encounter`): a fight's Initiative order, turns, monsters and timed effects.

Every change goes through a function that checks it against the rules and returns a new
document: builder setters for builds, `applyAction` for play states, `applyEncounterAction` for
encounters. Nothing derived is stored: sheets and combatants are recomputed from the documents
and the catalog.

| Layer | Module | Responsibility |
|---|---|---|
| Content | `content/**/*.yaml`, `src/content/` | Rules data in packs; schema + cross-reference validation at load |
| Build | `src/models/build.ts` | The player's choices only; immutable |
| Resolution | `src/rules/build-resolution.ts` | Build + catalog → active sources, pending choices, option availability |
| Validation | `src/rules/build-validation.ts` | Errors (illegal), pending (missing), notes (not automated) |
| Sheet | `src/rules/sheet.ts` | Derived numbers with contributions (`AC 17 = 16 Chain Mail + 1 Defense`), attack lines, toggles |
| Builder | `src/services/builder.ts` | Validated setters + normalization |
| Play | `src/models/state.ts`, `src/services/play.ts` | Play state and its actions; the play sheet |
| Combat | `src/rules/damage.ts`, `combatant.ts`, `casting.ts` | Damage, combatants, attacks, spells, saving throw effects (pure) |
| Encounters | `src/models/encounter.ts`, `src/services/encounter.ts` | Initiative, turns, action economy, timed effects |
| UI | `src/cli/`, `src/http/` | Interactive shell and HTTP API; no rules logic |

## Content and packs

Rules content is YAML validated by the Zod schemas in `src/models/content.ts` (published as
`schemas/*.schema.json`). A **content pack** is a folder; the SRD is one
(`content/srd-5.2.1/`), compiled to JSON and bundled.

- **Layering.** `createCatalog(...packs)` layers packs in order: a later pack adds entities and
  replaces earlier ones with the same id. Duplicate ids within one pack are errors.
  Cross-references are checked after layering. The catalog is deep-frozen.
- **Manifests.** A pack's `pack.yaml` gives its id, version, ruleset, default `source` and the
  packs it `requires` (checked against load order); without one, the pack's name is its id and
  default source (`homebrew` without a name). `catalog.packs` keeps the manifests
  (`GET /v1/content/packs`).
- **Patches.** `patches.yaml` edits an entity from an earlier pack by path (`set`, `append`,
  `remove`; list elements by index or `id`). A patch applies to the parsed entity (defaults
  filled in, so paths are stable), and the result is validated again, so a patch can't produce
  an invalid entity or change an id.
- **Sources.** Every entity has a `source`. `createCatalog(packs, { sources })` keeps only the
  entities and patches of those sources (the books a campaign allows). Builds may list the packs
  they need (`build.packs`); a missing one is a validation error.
- **Leak guard.** `npm run check:sources` (part of `npm run check`) fails if `content/` holds
  anything besides `srd-5.2.1/`, if a `source` in `content/` or the bundled JSON isn't
  `srd-5.2.1`, or if one in `examples/` or `tests/fixtures/` isn't `srd-5.2.1`, `homebrew` or
  `test`. Non-SRD content lives in separate, private packs.

**Importers.** Most SRD content is generated from the SRD 5.2.1 Markdown (`docs/srd-5.2.1/`,
git-ignored) by scripts that keep the SRD's text and take mechanics from overlay tables:
`import-srd-classes.py` (class levels 2–20, subclasses, invocations, Metamagic),
`import-srd-spells.ts`, `import-srd-items.ts` (magic items, conditions) and
`import-srd-monsters.ts`. Parsers only draft: spell mechanics are used after a review against the
text (`REVIEWED`, `REJECTED`, hand-written `MECHANICS`); the monster importer reads stat block
fields exactly, throws on anything unexpected, and corrects two values the Markdown garbles
(`FIXES`, with the reason). Their `--report` flags list what became data and what stayed text.

## Character builder (level 1)

### Step order

`STEPS` in `src/models/content.ts` defines the order, based on dependencies. Each step only
uses what earlier steps decided, and nothing important is asked before the facts that
constrain it are known. The order follows the 2024 rules (Class → Origin → Ability Scores →
Details), and you can move freely between steps.

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
10. **Name & alignment** is last because nothing depends on it.

You can jump to any step. If a change upstream makes a later choice invalid,
`normalize` in `src/services/builder.ts` removes it and says why. For example, switching to Criminal
removes Stealth from Skilled.

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

### Effects

Grants change numbers and rolls declaratively:

- **Numeric effects** (`effects`): `Effect{target, op: add|set|max|min, value: int|"prof"|
  "half_prof"|ability, min, when}`. An ability value means that ability's modifier; `min` is a
  floor (Thaumaturge: "Wisdom modifier, minimum of +1"). `target` and `when` are closed lists
  (`EFFECT_TARGETS`, `EFFECT_CONDITIONS`; the table is in [CONTENT.md](CONTENT.md#effects)):
  anything else is rejected at load, and the sheet's lookups are typed against the same lists.
  `when` knows what the character wears (`wearing_armor`, `unarmored`…).
- **Damage riders** (`damage_riders`): extra damage on the attacks they apply to (by ability,
  weapon or Unarmed Strike, weapon property or kind). The amount is dice, a flat bonus, or a
  column of the source class's table read at its current level (Rage Damage, Sneak Attack).
  Automatic riders become a damage part of every matching attack line; optional ones are listed
  on the line (`riders`) and `makeAttack` adds them on request, checking `requires:
  advantage_or_ally` and asking for the damage type when there's a choice. The latest rider with
  an id wins (Divine Strike 1d8 → 2d8 at Cleric 14).
- **Advantage** (`advantages`: `save.<ability>`, `check.<ability>`): listed on the sheet with
  its source; `rollSavingThrow` applies it and cancels it against Disadvantage.
- **Toggles** (`toggles`): features switched on in play (Rage). Their grants apply while active,
  which covers "while raging" without a new `when` condition (see "Play state").

**Armor Class** is not a sum of effects: features like Unarmored Defense and Mage Armor are
*alternative* calculations that never stack with each other or with armor. Content declares
them as `ac_calculations` (`base` + ability modifiers, whether a Shield still applies). The
sheet evaluates every legal configuration (each owned and trained armor, or no armor with each
calculation; with or without a Shield), including conditional effects such as Defense, and
picks the highest. Ties go to the simpler option.

### Spell choices

Spells are content (`spells.yaml`: level, school, class `lists`, ritual, concentration, full
text, and `mechanics` for casting; see "Casting spells"). A class declares `spellcasting`
(list, ability, slots, `pact` for Warlocks) and its picks as `kind: spell` choices:

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

## Levels and multiclassing

A character is created at level 1, then gains levels one at a time. The build stores each level after the first as `{ class_id, hp }` (`hp: null` = the
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
level (a subclass's spell table, the Land druid's resistance, Improved Blessed Strikes).

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
slots and uses, active toggles, the inventory, coins, and `choices`: today's picks for choices
marked `rest_change` (prepared spells, Weapon Mastery…). The state stores only what's *spent* or
*chosen*; maxima always come from the build, so they never go stale.

- **Actions** (`PlayActionSchema`, plain JSON) go through `applyAction(build, state, catalog,
  action, { rng })` → `{ state, notes }`, or throw `PlayError`. After every action the result is
  passed through `reconcileState`, so an accepted action can't leave an invalid state.
- **The played build.** `playBuild` overlays `state.choices` on the build (only for
  `rest_change` choices); `computePlaySheet` computes the sheet from it with a `PlayContext`
  (carried items, active conditions, Exhaustion, active toggles), then adds the live `play`
  block. A rest-change pick is validated by running the builder's `setChoice` on the played
  build, so it follows exactly the same rules as a build pick.
- **Items.** An inventory entry points at a catalog item; magic items made from a mundane one
  store its `base` (Weapon, +1 → `longsword`) and kinds a `variant`. A magic item is *active*
  when worn/held (or carried, per `active_when`) and attuned if required; active items become
  sources, so their grants use the same machinery as feats. A magic weapon's bonus applies to
  its attack line whenever attunement allows (you wield it to attack). With a play context, AC
  comes from the equipped armor and Shield instead of the best armor owned.
- **Conditions** are data: `implies` (Unconscious → Incapacitated, Prone) and `speed_zero`.
  Exhaustion is a level on the state; the sheet applies −2 per level to d20 tests and −5 ft per
  level to speed. Incapacitated ends Concentration.
- **Toggles.** `state.active` holds the keys of toggles switched on (like resources:
  `barbarian:rage`); `activate` spends the toggle's `uses`, `deactivate` ends it, and active
  toggles are sources, like magic items. `reconcileState` ends a toggle whose `blocked_when`
  effect condition holds (Heavy armor) or whose `ends_on` condition is active (Incapacitated);
  `no_spells` drops Concentration, refuses new Concentration and makes the combatant unable to
  cast. In an encounter, `extends_each_turn` toggles also end at the end of a turn they weren't
  extended in (see "Encounters").
- **Build changes** don't touch the state; `reconcileState` clamps spent resources, drops
  rest-change picks that no longer fit, ends attunements that are no longer allowed and toggles
  that are gone.

## Combat

Combat is pure functions over **combatants**; they never change a document themselves. They
return rolls, damage instances and the play actions that apply them, and the caller (or an
encounter) applies those to each target's own document.

### Damage

`rules/damage.ts` holds the damage rules, shared by play, combat and encounters:

- `rollDamage(parts, { critical, rng })` rolls `DamagePart`s (`{ dice, bonus, type }`). A
  Critical Hit doubles each part's dice, not its bonus; a part never goes below 0.
- `adjustDamage` applies Immunity, then Resistance (halved, rounded down), then Vulnerability
  (doubled), per instance and per type; `"all"` covers every type, including untyped damage
  (Petrified). Several Resistances to one type count once.
- `takeDamage(vitals, instances, defenses, { critical })` sums the adjusted instances, takes
  Temporary Hit Points first, and reports dropping to 0, dying (massive damage, or damage at 0
  HP at least the maximum), Death Saving Throw failures and the Concentration DC. The caller
  updates its own state (conditions, death saves, Concentration).

Every attack line on the sheet carries its damage as parts (`damage_parts`, and
`two_handed_damage_parts` for Versatile weapons), and its display string is built from them.
A fixed damage amount (the Blowgun's 1) gets no ability modifier (SRD "Damage Rolls").

### Combatants and attacks

A `Combatant` (`rules/combatant.ts`) is what combat needs to know about a creature: AC, HP and
Temporary HP, saving throw bonuses, damage defenses, conditions and condition immunities, attack
lines, critical range, attacks per action, spellcasting (DC, attack bonus, modifier per
feature), Advantage, saving throw effects. It's a read-only view built from something else:
`combatantFromCharacter(build, state, catalog)` (from the play sheet),
`combatantFromMonster(monster, state)` (a stat block), `combatantFromSnapshot(character)` (the
deprecated `Character` model), or `encounterCombatant(encounter, id, ctx)`.

`makeAttack(attacker, attackName, target, { mode, two_handed, riders, ally_adjacent, rng })`
rolls the d20 (twice with Advantage or Disadvantage), decides hit and Critical Hit, adds the
requested riders, rolls the damage parts, and previews `takeDamage` on the target.
`rollSavingThrow` rolls a save with the combatant's bonus and Advantage. `POST /v1/state/attack`
does an attack between two characters and applies it.

### Casting spells

Catalog spells can carry `mechanics` (attack or save, damage by type, healing, targets,
upcasting, Cantrip Upgrade, conditions, area). `castSpell(caster, spell, targets, { slot_level,
pact, spellcasting, mode, rng })` in `rules/casting.ts` resolves them between combatants: a spell
attack per target (per beam for Eldritch Blast), or a save with the damage rolled once for all
targets; healing; conditions on a hit or a failed save (not for a target immune to them). It
returns each target's result with the play actions that apply it (`targets[i].actions`) and the
caster's (`spend_slot` or `spend_pact_slot`, `set_concentration`). `POST /v1/state/cast` checks
that the caster has the spell and applies everything to the states.

The spellcasting feature used is the one asked for, else the one with the best save DC whose
spell list has the spell, else the best overall (a species' fixed spells). A spell without
`mechanics` is still cast (slot, Concentration) with a note that its effects are in the text.

53 SRD spells have mechanics: 11 hand-written golden spells with worked tests, 38 drafts from
the importer's parser reviewed against their text, and 4 corrected by hand (`tests/casting.test.ts`
snapshots them all). The other 286 are cast with their text: 207 have nothing to model (utility
spells), and 79 have effects the parser deliberately doesn't guess (damage after casting, several
saves, tables…).

### Monsters

`monsters` is a content table (330 SRD stat blocks, generated by
`scripts/import-srd-monsters.ts`; 423 attack rolls and 163 saving throw effects structured, the
rest as SRD text). `tests/monsters.test.ts` checks every stat block's invariants (HP dice, saves,
PB by CR, Passive Perception, damage averages) and compares 15 golden stat blocks field by field
with the Markdown.

`combatantFromMonster(monster, { hp, temp_hp, conditions })` turns a stat block into a combatant:
its attacks become attack lines (`ability: null`), its Multiattack the number of attacks per
action, its saving throw effects `save_actions`, its condition Immunities
`condition_immunities`. `useSaveAction(user, name, targets)` resolves a breath weapon like a save
spell (one damage roll, half per type on a success, conditions on a failure). Legendary actions,
spellcasting and "X/Day" uses are text for now.

### Encounters

An `Encounter` (`src/models/encounter.ts`) is its own saved document: combatants, the Initiative
order, the round and whose turn it is, what each combatant has spent this turn (action, Bonus
Action, reaction, movement, attacks left, once-per-turn riders), expended recharge abilities, and
timed effects. Monsters live in it (catalog id, current HP, Temporary HP, conditions,
Concentration, `defeated`); characters are referenced by a key into the caller's characters
(build + state), so their HP and conditions stay in their `CharacterState`.

`applyEncounterAction(encounter, action, { catalog, characters, rng })` → `{ encounter, states,
notes, result }`, or `EncounterError`. `states` holds the character states the action changed;
`result` is the roll of an `attack`, `save_action` or `cast`. `POST /v1/encounters/apply` runs a
list of actions.

- **Setup and order:** `add_monster` (average or rolled HP), `add_character`, `remove`,
  `roll_initiative` (d20 + Initiative bonus; Disadvantage when surprised; one roll per group of
  identical monsters), `set_initiative`, `set_order` (ties only), `start`, `next_turn`, `end`.
- **Economy:** `use` (action, Bonus Action or reaction), `move`, `dash`. An action, Bonus Action
  and movement only on your turn; a reaction at any time, once until the start of your next
  turn; nothing while Incapacitated; movement up to your Speed (0 while a condition sets it to
  0), plus your Speed again with Dash.
- **Resolving in one step:** `attack` (the first attack of a turn uses the action; Extra Attack
  or a monster's Multiattack allow more; `reaction: true` is an Opportunity Attack; once-per-turn
  riders are enforced, and each turn, anyone's, resets them), `save_action` (a monster's saving
  throw effect; one with a Recharge is `expended` and rolled for on a d6 at the start of the
  monster's turns) and `cast` (the casting time decides the action, Bonus Action or reaction;
  the caster must have the spell).
- **Effects by hand:** `effects` applies play actions (what `makeAttack`, `castSpell` and
  `useSaveAction` return) to a character's state or to a monster (damage with its defenses,
  healing, Temporary HP, conditions with its immunities), optionally as timed effects.
- **Timed effects** (`encounter.effects`) are conditions with a duration or tied to
  Concentration: `ends: { at: start|end, of, count }` counts that combatant's turn starts or ends
  ("until the end of its next turn", N rounds); one set during `of`'s own turn doesn't count that
  turn's end. A Concentration effect ends when its source stops concentrating on it. `cast`
  records a Concentration spell's conditions this way, for its duration ("up to 1 minute": 10
  rounds). A condition goes when its last effect ends; `end_effect` ends one early.
- **Concentration saves** are rolled automatically when a concentrating combatant takes damage
  (DC 10 or half the damage); a failure ends its Concentration effects.
- **Turn hooks.** At the end of a turn: effects counting turn ends, and `extends_each_turn`
  toggles (Rage) that weren't extended that turn (an attack roll, a save forced, a Bonus Action,
  or `extend`) end, except in the turn they started. At the start of a turn: effects counting
  turn starts, recharge rolls, and once-per-turn riders reset for everyone.
- A monster dies at 0 Hit Points (SRD "Monster Death") and its turns are skipped, as are a dead
  character's; a character at 0 HP is reminded to make a Death Saving Throw.

## Interpretations (flagged, not invented)

Where the SRD is silent or ambiguous, the engine picks a reading and lists it here.

**Character building**

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
  traits stay summarized. Features that change numbers or rolls are modeled as data (effects,
  riders, Advantage, toggles); the rest is text and class resources.

**Play**

- A Long Rest doesn't remove conditions (the SRD ties them to their source).
- Attuning is recorded immediately, with a note that it takes a Short Rest.
- Damage while Petrified is halved, typed or not (Resistance to all damage).
- A Short or Long Rest ends every active toggle (Rage lasts at most 10 minutes).

**Damage and attacks**

- Damage that Temporary Hit Points absorb entirely calls for no Concentration save and causes no
  Death Saving Throw failure, and the Concentration DC uses the damage that got past them (the
  SRD says "if you take damage"; this keeps Temporary Hit Points a full buffer).
- A magic weapon's damage bonus still applies to fixed damage (only the ability modifier is
  excluded).
- A roll in an extended critical range (19 with Improved Critical) is a Critical Hit and so hits
  regardless of AC, like a natural 20 (SRD "Critical Hit"). A natural 1 misses even inside such
  a range. Natural 20s and 1s mean nothing special on saving throws.

**Spells**

- On a successful save for half, each damage type is halved separately (rounded down), since
  Resistance applies per type.
- Healing that several targets receive is rolled once, like damage.
- Each beam's damage preview is against the target as it was before the spell.

**Monsters**

- A "First Failure" is what a failed save does; the second failure stays text.
- Conditions a stat block gives only to targets of some size or HP, or after being swallowed or
  engulfed, stay text; so does damage that depends on something ("if the attack roll had
  Advantage").
- Who can be targeted (size limits, range) is the caller's to decide.

**Encounters**

- Initiative ties go to the higher Initiative bonus, then the order combatants joined (the SRD
  leaves ties to the GM and players: `set_order`).
- Dash uses the walking Speed.
- A monster's Multiattack is a number of attacks for the action (summed from its text; the
  Hydra's is `null`), without checking which attacks.
- "Once per turn" resets on every creature's turn; Divine Strike's "once on each of your turns"
  is treated the same.
- A monster's spell slots aren't tracked.
- Ending the fight keeps active effects; they stop counting down.
- Rage's 10-minute cap isn't enforced.

## Known gaps

What the engine doesn't do yet is listed with sizes in [ROADMAP.md](ROADMAP.md). The main ones:
conditions don't change rolls on their own (the caller passes Advantage or Disadvantage),
there are no positions, reach or cover, legendary actions and monster spellcasting are text,
79 spells keep their effects in text, and shopping with starting gold isn't automated.
Starting-equipment items "of your choice" (a Bard's instrument, a Monk's tool) are placeholders,
like the Soldier's gaming set.

## Named rules in code (documented exceptions)

Most rules are data; these are code, by name:

- `rules/sheet.ts`: Martial Arts (Dex and the Martial Arts die for Unarmed Strikes and Monk
  weapons, only without armor or Shield) is triggered by the `martial_arts.die` effect; Great
  Weapon Fighting adds a note to two-handed melee attacks.
- `services/play.ts` knows a few SRD condition ids: `petrified` halves all damage (Resistance to
  all damage), `unconscious` is added at 0 HP and removed when you regain Hit Points, and
  `incapacitated` (or a condition that implies it) ends Concentration and toggles with `ends_on`.
- `services/encounter.ts`: `incapacitated` stops actions and reactions, `petrified` gives a
  monster Resistance to all damage, and a monster at 0 HP is defeated (SRD "Monster Death").

## Runtime and packaging (TypeScript)

The engine was ported from Python to TypeScript so the same code can run in a browser
builder, a VTT client, an edge function and a server.

- **Isomorphic core.** `src/index.ts` and `src/http/` import no Node built-ins. The SRD is
  compiled from YAML to JSON at build time (`scripts/compile-content.ts`) and bundled, so no
  filesystem or YAML parser is needed at runtime. Node-only code (reading content
  directories, the `node:http` adapter, the CLI) is in `src/content/load.ts`,
  `src/http/node-server.ts` and `src/cli/`.
- **Schemas: Zod.** Content, builds, play states, encounters and API payloads are Zod schemas.
  The TypeScript types are inferred from them, except for the recursive `Grants`/`ChoiceDef`/
  `ChoiceOption`/`ToggleDef`, which are written by hand. The same schemas generate
  `schemas/*.schema.json` for content authors and for other languages (content files, pack
  manifests, patches and builds).
- **snake_case data.** Fields keep the YAML/JSON names (`class_id`, `base_ac`), so content,
  saved documents, sheets and HTTP payloads share one format, and builds saved by the Python
  version still load. Functions are camelCase.
- **Immutability.** Catalogs are deep-frozen and builds are frozen; play states and encounters
  are cloned by every action. Lookups by id go through `lookup()` (an `Object.hasOwn` check), so
  ids like `constructor` can't hit the prototype.
- **Dice.** Every rolling function takes an optional `Rng` (`{ int(min, max) }`).
  `seededRng` (mulberry32) gives the same sequence on every platform; `scriptedRng` and
  `fixedRng` are for tests.
- **Public API.** `tests/api.test.ts` snapshots the names each entry point exports; changing
  the snapshot is a deliberate API change, noted in the CHANGELOG. Some internal helpers are
  exported through `export *` and will be hidden before 1.0 (see [ROADMAP.md](ROADMAP.md)). The
  `Character`-based combat and spell functions from the Python version (`resolveAttack`,
  `attackRoll`, `resolveSpellSave`…) are deprecated adapters, kept until 1.0.
- **HTTP.** A Web-standard `fetch` handler with no router dependency. Request bodies are
  validated with the same Zod schemas (422 on failure). The Node adapter limits bodies to
  1 MB, and dice expressions are limited to 1000 dice of up to 1000 sides.
