# Writing content

Rules content is YAML validated against the schemas in `src/models/content.ts` (published
as `schemas/*.schema.json`). A **content pack** is a folder, and every file in it is optional:

| File | Holds | Schema |
|---|---|---|
| `creation.yaml` | Standard array, point buy, base grants (languages) | `creation.schema.json` |
| `species.yaml` | Species | `species.schema.json` |
| `backgrounds.yaml` | Backgrounds | `backgrounds.schema.json` |
| `classes/<id>.yaml` (or `classes.yaml`) | Classes (level 1 for now) | `classes.schema.json` |
| `feats.yaml` | Feats | `feats.schema.json` |
| `weapons.yaml`, `armor.yaml`, `gear.yaml`, `tools.yaml` | Equipment | … |
| `languages.yaml`, `masteries.yaml` | Languages, weapon mastery properties | … |
| `spells.yaml` | Spells: level, school, class `lists`, ritual, concentration, text | `spells.schema.json` |

A file can hold a single entity or a list. `.yml` and `.json` work too.

Start each file with a schema comment to get autocompletion and inline errors:

```yaml
# yaml-language-server: $schema=../../schemas/feats.schema.json
```

## Entities

Every entity has a slug `id` (lowercase letters, digits and hyphens), a `name`, a `source`
(`srd-5.2.1`, `homebrew`, …) and an optional `description`. A pack loaded after another
replaces entities that have the same id.

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
| `martial_arts.die` | `max` | Monk: `6` (a d6) |

Conditions for `when`: `wearing_armor`, `wielding_shield`. Armor Class alternatives such as
Unarmored Defense go in `ac_calculations`, not effects, because they don't stack.

This is a small stand-in for the full Effect engine planned in the roadmap. Anything these
targets can't express goes in a trait's text, or in a feat's `unsupported` note, which the
builder shows to the player.

### Choices

```yaml
choices:
  - id: skills               # choice key becomes "<source key>#skills"
    label: Fighter skills
    kind: skill              # option | ability | skill | tool | skill_or_tool | language | feat |
                             # weapon_mastery | spell | expertise
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
