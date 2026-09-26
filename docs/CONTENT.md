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
  weapon_proficiencies: [simple, martial]
  feats: [{feat: magic-initiate, params: {spell_list: cleric}}]   # params pre-answer the feat's choices
  resistances: [poison]
  cantrips: [prestidigitation]
  items: [{item: javelin, qty: 8}]
  gp: 15
  effects:
    - {target: speed, op: set, value: 35}
    - {target: ac, value: 1, when: wearing_armor}
    - {target: initiative, value: prof}   # "prof" = Proficiency Bonus
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

This is a small stand-in for the full Effect engine planned in the roadmap. Anything these
targets can't express goes in a trait's text, or in a feat's `unsupported` note, which the
builder shows to the player.

### Choices

```yaml
choices:
  - id: skills               # choice key becomes "<source key>#skills"
    label: Fighter skills
    kind: skill              # option | ability | skill | tool | skill_or_tool | language | feat | weapon_mastery
    count: 2
    allowed: [athletics, perception]   # optional whitelist
    category: standard       # optional filter (language/tool/feat/weapon category)
    step: proficiencies      # optional; defaults by kind
    hint: Shown under the options.
```

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
