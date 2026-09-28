# Writing content

Rules content is YAML validated against the schemas in `src/models/content.ts` (published
as `schemas/*.schema.json`). A **content pack** is a folder, and every file in it is optional:

| File | Holds | Schema |
|---|---|---|
| `pack.yaml` | The manifest: pack id, version, default `source`, required packs | `pack.schema.json` |
| `patches.yaml` | Changes to entities loaded by earlier packs | `patches.schema.json` |
| `creation.yaml` | Standard array, point buy, base grants (languages) | `creation.schema.json` |
| `species.yaml` | Species | `species.schema.json` |
| `backgrounds.yaml` | Backgrounds | `backgrounds.schema.json` |
| `classes/<id>.yaml` (or `classes.yaml`) | Classes: core traits, multiclass grants, features by level 1–20, table columns | `classes.schema.json` |
| `subclasses.yaml` | Subclasses (`class: <id>`, features by class level) | `subclasses.schema.json` |
| `features.yaml` | Selectable class features: Eldritch Invocations, Metamagic | `features.schema.json` |
| `feats.yaml` | Feats | `feats.schema.json` |
| `weapons.yaml`, `armor.yaml`, `gear.yaml`, `tools.yaml` | Equipment | … |
| `languages.yaml`, `masteries.yaml` | Languages, weapon mastery properties | … |
| `spells.yaml` | Spells: level, school, class `lists`, ritual, concentration, text | `spells.schema.json` |
| `magic-items.yaml` | Magic items: base item, bonuses, Attunement, charges, grants while active | `magic_items.schema.json` |
| `conditions.yaml` | Conditions: `implies`, `speed_zero`, levels (Exhaustion) | `conditions.schema.json` |

A file can hold a single entity or a list. `.yml` and `.json` work too.

Start each file with a schema comment to get autocompletion and inline errors:

```yaml
# yaml-language-server: $schema=../../schemas/feats.schema.json
```

## Entities

Every entity has a slug `id` (lowercase letters, digits and hyphens), a `name`, a `source`
(`srd-5.2.1`, `homebrew`, …) and an optional `description`. A pack loaded after another
replaces entities that have the same id.

`source` is optional: an entity without one gets its pack's name (the folder name when loaded
with `loadContentPack`, or `homebrew` for a pack without a name). Set it explicitly when the
content comes from a specific book, so it can be told apart from the SRD.

This repository only holds SRD 5.2.1 content and invented homebrew: `npm run check` fails if
`content/` has anything but `srd-5.2.1/`, or if an example or test pack has another `source`.

## Packs: manifest and patches

`pack.yaml` names the pack and says what it needs:

```yaml
id: my-homebrew              # lowercase slug; what builds and other packs refer to
version: 0.1.0
ruleset: "2024"              # informational
source: my-homebrew          # source of entities that don't declare one (default: id)
requires: [srd-5.2.1]        # packs that must be loaded before this one
```

Without a manifest, the folder name is the pack id and the default source. Loading a pack
twice, or before a pack it requires, is an error. `catalog.packs` lists the loaded manifests.

`patches.yaml` changes an entity from an earlier pack without copying it. Patches run in order,
after the pack's own entities, and the patched entity is validated again:

```yaml
- {target: spells/light, op: append, path: lists, value: warlock}
- {target: classes/fighter, op: set, path: grants.choices.skills.count, value: 3}
- {target: spells/fireball, op: remove, path: lists, value: [wizard]}
- {target: classes/fighter, op: remove, path: grants.choices.skills}
```

- `target` is `<table>/<id>`; `path` is dotted. In a list, a segment is an index (`0`) or the
  `id` of an element (`choices.skills`). Paths see the entity with its defaults filled in, so
  `grants.effects` exists even if the YAML left it out.
- `set` replaces a value (or adds a key); `append` adds one item or a list of items to a list;
  `remove` deletes what's at `path`, or, with a `value`, removes those items (or the elements
  with those ids) from the list.
- A patch can't create an entity or change its id. It has a `source` too (default: the pack's),
  so filtering by source drops it along with the pack's entities.

To use only some sources (the books a campaign allows), pass them to `createCatalog`:
`createCatalog([srdPack, mine], { sources: ["srd-5.2.1", "my-homebrew"] })`. Creation rules
always load; an entity that refers to a filtered-out one fails the cross-reference check.

A build can list the packs it needs (`packs: [my-homebrew]`); loading it without them gives
"Needs content pack 'my-homebrew', which isn't loaded". The CLI builder records the packs
loaded with `--content` when it saves.

## Grants

Species, classes, backgrounds, feats and choice options all give the character things
through `grants`:

```yaml
grants:
  size: medium
  skills: [perception]
  tools: [thieves-tools]
  languages: [elvish]
  saving_throws: [str, con]
  armor_training: [light, medium, heavy, shield]
  weapon_proficiencies: [simple, martial, "martial:light"]   # category, category:property, or weapon id
  feats: [{feat: magic-initiate, params: {spell_list: cleric}}]   # params pre-answer the feat's choices
  resistances: [poison]
  cantrips: [prestidigitation]
  spells: [hunters-mark]                # always prepared
  spellcasting: {list: wizard, ability: int, slots: [2]}   # slots per spell level; pact: true for Warlocks
  ac_calculations: [{name: Unarmored Defense, abilities: [dex, con], shield: true}]
  items: [{item: javelin, qty: 8}]
  gp: 15
  effects:
    - {target: speed, op: set, value: 35}
    - {target: ac, value: 1, when: wearing_armor}
    - {target: initiative, value: prof}   # "prof" = Proficiency Bonus
    - {target: skill.arcana, value: wis, min: 1}   # an ability = its modifier; min = floor
  traits: [{name: Trance, text: "You don't need to sleep."}]
  choices: [...]
```

### Effects

| `target` | Ops used | Example |
|---|---|---|
| `ac` | `add` | Defense: `+1` while `wearing_armor` |
| `initiative` | `add` | Alert: `prof` |
| `speed` | `set`, `max` | Wood Elf: `max 35` |
| `darkvision` | any (highest wins) | Drow: `120` |
| `hp_per_level` | `add` | Dwarven Toughness: `1` |
| `attack.ranged` | `add` | Archery: `2` |
| `skill.<skill id>` | `add` | Thaumaturge: `wis`, `min: 1` |
| `martial_arts.die` | `max` | Monk: `6` (a d6), `8` at level 5… |
| `attacks` | `max` | Extra Attack: `2`; Fighter 11: `3` |
| `attack.critical` | `min` | Champion: `19` |
| `saves` / `save.<ability>` | `add` | Aura of Protection: `cha`, `min: 1` |
| `skill.unproficient` | `add` | Jack of All Trades: `half_prof` |
| `hp_per_class_level` | `add` | Draconic Resilience: `1` × Sorcerer level |
| `checks` | `add` | Stone of Good Luck: `1` (ability checks) |
| `score.<ability>` | `max` | Gauntlets of Ogre Power: Strength `19` |

Conditions for `when`: `wearing_armor`, `wielding_shield`, `wearing_heavy_armor`,
`not_wearing_heavy_armor`, `unarmored` (no armor and no Shield). Armor Class alternatives such as
Unarmored Defense go in `ac_calculations`, not effects, because they don't stack.

These targets and conditions are the complete list: anything else is rejected when the pack
loads ("unknown effect target 'speeed'"), and the JSON Schemas offer them for autocompletion.

This is a small stand-in for the full Effect engine planned in the roadmap. Anything these
targets can't express goes in a trait's text, or in a feat's `unsupported` note, which the
builder shows to the player.

### Choices

```yaml
choices:
  - id: skills               # choice key becomes "<source key>#skills"
    label: Fighter skills
    kind: skill              # option | ability | skill | tool | skill_or_tool | language | feat |
                             # weapon_mastery | spell | expertise | subclass | ability_increase | feature
    count: 2
    allowed: [athletics, perception]   # optional whitelist
    category: standard       # optional filter (language/tool/feat/weapon category); a string or a list
    step: proficiencies      # optional; defaults by kind
    hint: Shown under the options.
```

Spell choices add filters:

```yaml
  - id: prepared
    label: Wizard prepared spells
    kind: spell
    count: 4
    spell_level: 1           # 0 = cantrips
    spell_list: wizard       # or "$spell_list": the answer to a sibling choice
    ritual: false            # true: Ritual spells only
    subset_of: spellbook     # only spells a sibling choice picked
    always_prepared: false   # true: doesn't count against the class's prepared spells
```

Weapon Mastery choices accept `weapon_kind: melee` (Barbarian). `kind: expertise` offers the
skills you're proficient in.

`kind: option` takes inline `options`, each with its own `grants`. Picking an option
activates those grants, which can include further choices (Human → Versatile → Skilled →
"choose 3 skills or tools").

## Classes and levels

```yaml
id: fighter
hit_die: 10
primary_abilities: [str, dex]       # multiclassing needs 13+ in these (any; all with primary_mode: all)
subclass_level: 3
progression:                         # class table columns, 20 values; shown as class resources
  Second Wind: [2, 2, 2, 3, …]
grants: {…}                          # core traits: only for a character's first class
multiclass: {weapon_proficiencies: [martial], armor_training: [light, medium, shield]}
features:
  "1": {…}                           # level 1 features (starting or multiclass)
  "3":
    choices: [{id: subclass, label: Fighter subclass, kind: subclass}]
  "4":
    choices: [{id: feat, label: Ability Score Improvement or feat, kind: feat}]
  "5":
    effects: [{target: attacks, op: max, value: 2}]     # Extra Attack
```

A subclass lists its features by class level, and `at_class_level` switches grants on later:

```yaml
- id: life-domain
  class: cleric
  features:
    "3":
      spells: [aid, bless, cure-wounds, lesser-restoration]
      at_class_level:
        - {level: 5, grants: {spells: [mass-healing-word, revivify]}}
```

Spell choices grow with the class: `max_spell_level` (spells of level 1 up to it), `spell_list`
(one list or several: Magical Secrets), `tag` and `subset_of` (the Wizard's spellbook: every
`spellbook` choice has `tag: wizard-spellbook`, prepared choices use `subset_of:
wizard-spellbook`), `school` (Evoker), `known_only` (Agonizing Blast: one of your cantrips).

Choices that can change later:

```yaml
  - id: cantrips                  # "Whenever you gain a Bard level, you can replace one…"
    kind: spell
    tag: bard-cantrips            # the family: every Bard cantrip choice shares it
    swap: class_level             # one replacement per Bard level (any_level: per character level)
    same_level: false             # true: the replacement must be the same spell level
  - id: prepared                  # "After a Long Rest, you can change your list…"
    kind: spell
    scaling:                      # one list that grows; count and max spell level by class level
      count: [4, 5, 6, 7, 9, …]
      max_spell_level: [1, 1, 2, 2, 3, …]
    rest_change: long             # changeable in play after a rest (short | long): the play
                                  # state keeps today's picks, the build keeps the starting ones
```

Limited-use features declare `resources` in their grants; the play sheet lists them with their
maximum and the state tracks what's spent:

```yaml
resources:
  - id: rage                      # key in play: "barbarian:rage" (class) or "<source key>:rage"
    name: Rage
    max: {progression: [2, 2, 3, 3, 3, 4, …]}   # or value, ability (+ min), proficiency,
                                                #   per_class_level (Lay on Hands: 5)
    recharge: long                # short | long
    short_rest_regain: 1          # regain this many on a Short Rest (Rage, Channel Divinity)
on_long_rest: [heroic_inspiration]   # Human: Resourceful
```

### Spell mechanics

A spell's `mechanics` says what it does, so `castSpell` can resolve it; anything it doesn't
cover stays in the text. For the SRD, `scripts/import-srd-spells.ts` writes them (edit it, not
`spells.yaml`):

- `parseMechanics` drafts mechanics from the common phrasings ("makes a Dexterity saving
  throw, taking 8d6 Fire damage on a failed save or half as much…", "Make a ranged spell
  attack… On a hit…", "regains Hit Points equal to…", upcasting, Cantrip Upgrade, conditions,
  areas). It skips, with a reason, anything that happens after casting, several saves, damage
  outside the sentence that resolves the save or hit, tables and fixed DCs.
- A draft is used only if its id is in `REVIEWED`, after a check against the spell's text;
  `REJECTED` records drafts the review found wrong, and `MECHANICS` holds hand-written ones
  (they win over drafts).
- `npx tsx scripts/import-srd-spells.ts --report` lists every draft (`NEW` = not reviewed yet)
  and every skip. `tests/casting.test.ts` snapshots all mechanics, so a change shows in review.

The same approach suits your own packs: transcribe the text, draft mechanics with a parser or by
hand, validate with `srd-rules validate`, and pin the result with a test.

```yaml
id: fireball
mechanics:
  save: {ability: dex, on_success: half}     # or none; `attack: ranged | melee` instead
  damage: [{dice: 8d6, type: fire}]          # add_modifier: true adds the spellcasting modifier
  upcast: {damage: [{dice: 1d6, type: fire}]}   # per slot level above; also heal, targets
  area: {shape: sphere, size: 20}
# Others: heal: {dice: 2d8, add_modifier: true}; targets: 1; cantrip_scaling: dice | beams;
#         conditions: [{condition: paralyzed, on: failed_save}]   # or on: hit
```

A spell has an attack roll or a save, not both. Damage from a save is rolled once for every
target; each damage type is halved separately on a successful save (`on_success: half`).

### Magic items and conditions

`magic-items.yaml` and `conditions.yaml` are generated by `scripts/import-srd-items.ts`
(mechanics in its overlay tables). A magic item's fields:

```yaml
id: weapon-1
category: weapon                  # armor | potion | ring | rod | scroll | staff | wand | weapon | wondrous
rarity: Uncommon
attunement: false                 # attunement_classes: [paladin]; attunement_spellcaster: true
base: {kind: weapon, categories: [simple, martial]}   # made from a mundane item (ids, except…)
bonus: {attack: 1, damage: 1}     # also ac, spell_attack
grants: {effects: [{target: score.str, op: max, value: 19}]}   # while active; any grants
active_when: equipped             # or carried
charges: 7
consumable: true                  # with heal: 2d4+2 for potions
variants: [{id: fire, name: Fire, grants: {resistances: [fire]}}]   # Ring of Resistance
```

A magic item's grants apply while it's active: worn or held (or carried, for `active_when:
carried`), and attuned if it needs Attunement. Effect targets only items use: `score.<ability>`
(`op: max` sets a floor, like Gauntlets of Ogre Power) and `checks` (Stone of Good Luck).
Conditions have `speed_zero`, `implies` (Unconscious → Incapacitated, Prone) and `levels`
(Exhaustion).

Feats and features can have a `prerequisite`:

```yaml
prerequisite:
  level: 4                              # character level
  class_level: {class: warlock, level: 5}
  abilities: {any_of: [str, dex], min: 13}
  requires: [pact-of-the-blade]         # feats or features you have
  trait: Fighting Style                 # a feature, by name
  spellcasting: true
  spells: [eldritch-blast]              # know one of these
```

`kind: ability_increase` choices raise scores by 1 per pick (pick the same ability twice for +2)
up to `max_score` (default 20); `ability_bonuses` gives fixed increases with their own cap.

## Checking your work

```bash
npx srd-rules validate path/to/pack     # schema + cross-reference check, layered over the SRD
npx srd-rules build --content path/to/pack
```

The errors say exactly where the problem is:

```
my-pack/feats[0] (Bad_ID):
  ✖ ids are lowercase slugs
    → at id
```
