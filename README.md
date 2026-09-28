# SRD Rules Engine

A rules engine and character builder for 5th-edition tabletop RPGs, based on the
**System Reference Document 5.2.1** (the 2024 rules). Written in TypeScript. It has no
framework dependencies and runs in Node, Deno, Bun, browsers and edge workers.

```ts
import { builder, computeSheet, createBuild, explainStat, srdCatalog } from "srd-rules-engine";

const catalog = srdCatalog();
let build = createBuild();
build = builder.setClass(build, catalog, "fighter").build;
build = builder.setSpecies(build, catalog, "dwarf").build;
build = builder.setAbilityMethod(build, catalog, "standard_array").build;
build = builder.setBaseScores(build, catalog, { str: 15, dex: 14, con: 13, int: 8, wis: 10, cha: 12 }).build;

const sheet = computeSheet(build, catalog);
sheet.max_hp?.total;              // 12
explainStat(sheet.max_hp!);       // "10 Fighter d10 + 1 Con + 1 Dwarf"  ← every number explains itself
```

## Why use it

- **Every number explains itself.** AC, HP, initiative and speed come with their
  contributions (`AC 17 = 16 Chain Mail + 1 Defense`), ready to show in a tooltip.
- **Tells you why a choice is illegal.** Every option comes with the reason it can't be
  picked ("already proficient from Soldier"). If an earlier change invalidates a later
  choice, the engine repairs the build and tells you what it removed.
- **Rules content is data.** Species, classes, backgrounds, feats and equipment are YAML,
  validated against schemas at load time. Every entity records where it came from
  (`source: srd-5.2.1`).
- **Homebrew is a first-class citizen.** Add a folder of YAML on top of the SRD. It can add
  new content or override SRD entities by id, and it is validated the same way.
- **Deterministic dice.** Every roll takes an optional `Rng`; `seededRng(42)` makes sessions
  replayable and tests exact.
- **Plain data in, plain data out.** Builds and sheets are JSON-serializable, so you can
  store them anywhere, send them over the wire and diff them.
- **Runs anywhere.** Browsers and workers can use the core, since the SRD is bundled as
  JSON. Filesystem loading and the Node server are in a separate entry point.

## Install

```bash
npm install srd-rules-engine
```

| Entry point | What | Runs on |
|---|---|---|
| `srd-rules-engine` | Engine, schemas, bundled SRD | everywhere |
| `srd-rules-engine/http` | `createHandler()`: the HTTP API as a `fetch` handler | everywhere |
| `srd-rules-engine/node` | Everything above, plus `loadContentPack(dir)` and `serveNode()` | Node |
| `srd-rules-engine/srd-5.2.1.json` | The SRD content as one JSON file | any language |
| `srd-rules-engine/schemas/*.json` | JSON Schemas for content files and builds | any language |

## Usage

### Building a character builder UI

A build stores only the player's choices. `evaluate()` resolves it against the catalog
and returns everything a UI needs: the active choices, every option with the reason it
can't be picked, what's still missing at each step, and the derived sheet.

```ts
import { BuildError, builder, createBuild, evaluate, issuesForStep, srdCatalog } from "srd-rules-engine";

const catalog = srdCatalog();
let build = createBuild();
build = builder.setClass(build, catalog, "fighter").build;
build = builder.setSpecies(build, catalog, "human").build;
build = builder.setBackground(build, catalog, "soldier").build;

const ev = evaluate(build, catalog);
const skills = ev.resolution.choice("class:fighter#skills")!;
ev.resolution.options(skills);
// [{ id: "acrobatics", name: "Acrobatics", unavailable: null, … },
//  { id: "athletics",  name: "Athletics",  unavailable: "already proficient from Soldier", … }, …]

issuesForStep(ev.report, "proficiencies").map((i) => i.message);
// ["Fighter skills: choose 2 more", "Skillful skill: choose 1 more", "Soldier gaming set: choose 1 more"]

// Setters validate input and throw BuildError with readable messages…
builder.setChoice(build, catalog, "class:fighter#skills", ["athletics", "history"]);
// BuildError: ["Athletics: already proficient from Soldier"]

// …and when an upstream change invalidates a later choice, they repair the build and explain:
const { build: next, notes } = builder.setBackground(build, catalog, "criminal");
// notes: ["Skilled proficiencies: removed Stealth (already proficient from Criminal)."]
```

Levels are added one at a time, like in Baldur's Gate 3. A level 5 character is a level 1
character plus four level-ups, each in any class you qualify for:

```ts
builder.levelUpOptions(build, catalog);
// [{ class_id: "fighter", class_level: 2, fixed_hp: 6, unavailable: null },
//  { class_id: "wizard", class_level: 1, unavailable: "Wizard needs Intelligence 13+" }, …]

build = builder.levelUp(build, catalog, "fighter").build;     // fixed Hit Points
build = builder.levelUp(build, catalog, "fighter", 7).build;  // a Hit Die roll of 7
evaluate(build, catalog).resolution.choicesForLevel(3);       // [class:fighter:3#subclass]
```

The build stores each level as `{ class_id, hp }`, so it stays small and replayable.

Changing the past uses the same setters: any past choice with `setChoice`, a past level's class
with `setLevelClass`, its Hit Points with `setLevelHp`. `previewChange(build, catalog, change)`
reports what a change would remove and what new choices it creates, before you apply it. Every
setter refuses (`BuildError`) a change that would leave the character illegal.

Builds are frozen, JSON-serializable objects: save them with `JSON.stringify` and load them
with `parseBuild(json)`. Choice keys (`class:fighter#skills`,
`feat:skilled@species:human#versatile#proficiencies`) are explained in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Playing: HP, slots, conditions, inventory

The build is the character's characteristics; what changes at the table lives in a separate
`CharacterState` (its own JSON). Every change is an action, checked against the rules:

```ts
import { applyAction, computePlaySheet, createState } from "srd-rules-engine";

let state = createState(build, catalog);        // full HP, starting gear (armor worn), gold
({ state } = applyAction(build, state, catalog, { type: "damage", amount: 9, damage_type: "fire" }));
({ state } = applyAction(build, state, catalog, { type: "add_item", item: "weapon-1", base: "longsword" }));
const { notes } = applyAction(build, state, catalog, { type: "short_rest", hit_dice: [{ die: 10 }] });
computePlaySheet(build, state, catalog).play;   // hp, hit dice, slots, uses, conditions, inventory…
```

Actions cover damage (resistances, temporary HP, dropping to 0, death saves, massive damage,
Concentration DCs), healing, Short and Long Rests, spell and Pact slots, limited-use features
(Rage, Channel Divinity, Second Wind…), conditions and Exhaustion (their effects show on the
sheet), Heroic Inspiration, items (equip, attune up to 3 with class restrictions, potions,
charges), coins, and today's picks for "after a rest" choices such as prepared spells: those
live in the state, so the build keeps its starting picks. An impossible action throws
`PlayError` with the reason. Magic items change the sheet: +1 weapons and armor, Ring of
Protection, Gauntlets of Ogre Power, Bracers of Defense, resistances…

After the build changes (a level-up, an edit), `reconcileState` fits the state to it again.

### Dice and combat

```ts
import { applyAction, combatantFromCharacter, makeAttack, roll, seededRng } from "srd-rules-engine";

roll("2d6+3", seededRng(42));
// { dice_expression: "2d6+3", rolls: [4, 3], modifier: 3, total: 10 }  ← same result every time

// A combatant is a character (build + play state) seen by combat: AC, HP, saves, attack lines.
const attacker = combatantFromCharacter(fighterBuild, fighterState, catalog);
const target = combatantFromCharacter(rogueBuild, rogueState, catalog);
const result = makeAttack(attacker, "Greatsword", target, { mode: "advantage", rng: seededRng(1) });
// result.hit, result.critical_hit, result.damage (rolled parts), result.outcome (a preview)
if (result.hit) {
  ({ state: rogueState } = applyAction(rogueBuild, rogueState, catalog, {
    type: "damage", instances: [...result.instances], critical: result.critical_hit,
  }));
}
```

Features you switch on (Rage) are play actions: `{ type: "activate", key: "barbarian:rage" }`
spends a use and applies Rage's Resistance, Rage Damage (already in the attack lines) and
Strength Advantage until it ends (Incapacitated, Heavy armor, a rest, `deactivate`). Optional
extra damage is listed on each attack line (`riders`) and added on request:
`makeAttack(rogue, "Dagger", target, { mode: "advantage", riders: [{ rider: "sneak-attack" }] })`.

A natural 1 always misses. A natural 20 (19 for a Champion) is a Critical Hit: it hits whatever
the AC and doubles every damage die. `rollSavingThrow(combatant, "dex", 15)` rolls a save with
the sheet's bonus. The older functions that take a hand-filled `Character` (`resolveAttack`,
`attackRoll`) are deprecated; `combatantFromSnapshot` turns a `Character` into a combatant.
Monsters come from the catalog: `combatantFromMonster(catalog.monsters["adult-red-dragon"])`
attacks with `makeAttack(dragon, "Rend", target)` and breathes with `useSaveAction(dragon,
"Fire Breath", targets)`.

`castSpell(caster, catalog.spells.fireball, targets, { slot_level: 5 })` casts a catalog spell
whose `mechanics` are modeled: attack or save (half damage on a success), upcasting, Cantrip
Upgrade, healing and conditions, with the play actions that apply the result. 53 SRD spells have
reviewed mechanics; the others are cast with their text. The older `Character` spell
functions (`resolveSpellAttack`, `resolveSpellSave`, `spellSaveDc`) are deprecated.

Attack lines on the sheet carry their damage ready to roll, and `takeDamage` applies the rules
for Resistance, Vulnerability, Immunity, Temporary Hit Points and dropping to 0:

```ts
const greatsword = sheet.attacks.find((a) => a.name === "Greatsword")!;
const hit = rollDamage(greatsword.damage_parts, { critical: true, rng: seededRng(3) });
takeDamage({ hp: 7, temp: 0, max: 7 }, hit.parts.map((p) => ({ amount: p.total, type: p.type })),
  { resistances: ["slashing"] });
// { dealt, absorbed, hp, temp, dropped_to_zero, died, death_save_failures, concentration_dc, notes }
```
Without an `rng`, rolls use `Math.random()`.

## Command line

```bash
npx srd-rules build                    # interactive level 1 character builder
npx srd-rules build --load characters/aerin.json --seed 7
npx srd-rules play --load characters/aerin.json   # track HP, slots, items in play
npx srd-rules serve --port 8000        # HTTP API
npx srd-rules validate my-homebrew/    # check a content pack
npx srd-rules build --content my-homebrew/   # build with homebrew layered over the SRD
```

The builder walks you through Class, Species, Background, Ability Scores, Equipment,
Features, Spells, Skills & Tools, Languages, and Name & Alignment, in dependency order, and you can
jump between steps at any time. A live panel shows HP, AC, Initiative, Speed and Passive
Perception. Options you can't pick are greyed out with the reason, and picks that change
your numbers show a preview (`Defense · AC 16→17`). `save` writes the build to
`characters/<name>.json`. Builds saved by the earlier Python version of the builder load
unchanged.

Once level 1 is complete, `up` levels up the character, like in Baldur's Gate 3: pick a class
(your own, or a new one if you meet the multiclass prerequisites, with the reason shown when
you don't), take the fixed Hit Points or roll, then answer that level's choices (subclass, feat
or Ability Score Improvement, new spells, invocations…). Where the rules allow it, each
level-up also offers optional replacements ("Replace one: Bard cantrips", Eldritch Invocations,
Metamagic, the Fighter's Fighting Style…). `L5` revisits level 5, and `down` removes the last
level.

`edit` changes the past without rebuilding: pick a level, then its class, Hit Points or any
choice (say, the subclass you chose at level 3 on a level 7 character). Before anything
changes you see a preview: which later picks no longer fit and will be removed (and asked
again), and which new questions appear. Picks that still fit are kept. A change that would
make a later level illegal (a multiclass prerequisite no longer met, say) is refused, with the
reason.

`play` tracks a built character at the table with short commands: `dmg 7 fire`, `heal 5`,
`short 10 10`, `long`, `slot 2`, `use 1`, `cond poisoned`, `exh 1`, `prep 1` (today's prepared
spells), `add weapon-1 base=longsword`, `equip 3`, `attune 3`, `money +5gp`; `help` lists them.
`save` writes `characters/<name>.state.json`; resume it with `--state`.

## HTTP API

`createHandler()` returns a Web-standard `(Request) => Promise<Response>`, so it deploys
unchanged to most runtimes:

```ts
import { createHandler } from "srd-rules-engine/http";
const handler = createHandler({ cors: true });

Deno.serve(handler);                              // Deno
Bun.serve({ fetch: handler });                    // Bun
export default { fetch: handler };                // Cloudflare Workers
// Node: import { serveNode } from "srd-rules-engine/node"; serveNode(handler, { port: 8000 })
```

| Route | |
|---|---|
| `GET /health` | Liveness check |
| `GET /v1/content` · `/v1/content/{table}` · `/v1/content/{table}/{id}` | Browse the catalog |
| `GET /v1/content/packs` | The loaded content packs (manifests), in load order |
| `POST /v1/builds/evaluate` | Build → validation report, derived sheet, level-up options, and every choice with its options |
| `POST /v1/builds/set-choice` · `/v1/builds/level-up` · `/v1/builds/remove-level` · `/v1/builds/set-level-class` · `/v1/builds/set-level-hp` | Change a build the same way the builder does (validated, repaired, with notes) |
| `POST /v1/builds/preview` | What a `set-choice` or `set-level-class` change would remove and add, without applying it |
| `POST /v1/state/new` | Build → a fresh play state |
| `POST /v1/state/apply` | `{ build, state, action }` (one action or a list, all or nothing) → `{ state, notes }` |
| `POST /v1/state/sheet` · `/v1/state/reconcile` | Play sheet and state issues · fit a state to a changed build |
| `POST /v1/state/cast` | `{ caster: {build, state}, spell, targets: [{build, state}], slot_level?, pact? }` → the spell's results, the caster's state (slot spent, Concentration) and the targets' states |
| `POST /v1/state/attack` | `{ attacker: {build, state}, target: {build, state}, attack, mode?, two_handed?, riders?, ally_adjacent? }` → the attack, and the target's state after the damage |
| `POST /v1/characters/` | Validate a combat-ready `Character` |
| `POST /v1/characters/{name}/alive` | Is the character above 0 HP |
| `POST /v1/characters/{name}/passive-perception` | Passive Perception (`?proficient=true`) |
| `POST /v1/combat/roll` | Roll a dice expression (`{"expression": "2d6+3"}`) |
| `POST /v1/combat/attack` | Attack roll and damage (crits double all dice); deprecated, use `/v1/state/attack` |
| `POST /v1/combat/saving-throw` | Saving throw |
| `POST /v1/spells/stats` | Spell save DC and attack bonus |
| `POST /v1/spells/attack` · `/v1/spells/save` | Spell attack or save (half damage on success); deprecated, use `/v1/state/cast` |

Invalid bodies return `422` with a readable message; bad dice expressions return `400`.

## Homebrew and custom content

A content pack is a folder laid out like [`content/srd-5.2.1/`](content/srd-5.2.1). Every
file is optional:

```yaml
# my-homebrew/feats.yaml
# yaml-language-server: $schema=../node_modules/srd-rules-engine/schemas/feats.schema.json
- id: lucky-streak
  name: Lucky Streak
  source: homebrew
  category: origin
  grants:
    effects: [{target: initiative, value: 1}]
    choices: [{id: skill, label: Lucky Streak skill, kind: skill}]
```

```ts
import { createCatalog, loadContentPack, srdPack } from "srd-rules-engine/node";
const catalog = createCatalog(srdPack, loadContentPack("my-homebrew"));
```

Leave out `source` and entities take the pack's name (`my-homebrew` above). A pack can also
have a manifest (`pack.yaml`: id, version, required packs) and `patches.yaml`, which changes
SRD entities in place (`{target: spells/light, op: append, path: lists, value: warlock}`)
instead of copying them. `createCatalog([srdPack, pack], { sources: [...] })` keeps only the
sources a campaign allows. The `$schema`
comment gives you autocompletion and inline errors in VS Code (with the YAML extension) and
other editors. See [`examples/homebrew-pack`](examples/homebrew-pack) and
[docs/CONTENT.md](docs/CONTENT.md).

## Using it from another language

The engine is TypeScript, but you don't need TypeScript to use it:

- **Data only:** `srd-5.2.1.json` holds every validated entity with defaults filled in, and
  `schemas/` describes both content files and saved builds.
- **Rules as a service:** run `npx srd-rules serve` (or deploy the handler) and call
  `POST /v1/builds/evaluate` from Python, Go, C#, GDScript, or anything else.

## Status

| Area | Coverage |
|---|---|
| Character creation | Complete: all 12 SRD classes, 9 species, 4 backgrounds |
| Levels | 1–20 with multiclassing (prerequisites, partial proficiencies, combined spell slots, Pact Magic), fixed or rolled Hit Points, Ability Score Improvements, feats with prerequisites, Epic Boons |
| Class features | Every SRD class feature to level 20 and every SRD subclass (one per class). Numbers the sheet computes: HP, AC options (Unarmored Defense, Draconic Resilience, Mage Armor), Extra Attack, Martial Arts, Expertise, Jack of All Trades, Aura of Protection, Champion critical range, speed bonuses, subclass spells; the rest is shown as the SRD text |
| Spells | All 339 SRD spells with full text; class spell choices by level, Wizard spellbook, Magical Secrets, Mystic Arcanum, Eldritch Invocations, Metamagic; casting with modeled mechanics (attack or save, upcasting, Cantrip Upgrade, healing, conditions) for 53 reviewed spells; the rest are cast with their text |
| Combat | Attacks, damage, crits, saving throws, save-for-half spells |
| Changing choices | Every SRD replacement rule: one pick per level for "whenever you gain a level" features, free lists for "after a Long Rest" ones; changing any past choice, a past level's class or Hit Points, with a preview and legality checks |
| Play | Session state: HP, death saves, rests, slots, limited uses, conditions and Exhaustion, concentration, inventory with 275 SRD magic items (attunement, charges, potions), coins, prepared spells for the day |
| Monsters | All 330 SRD stat blocks (monsters and animals) as data: AC, HP, speed, abilities, saves, defenses, CR; attacks and saving throw effects (breath weapons) usable in combat; other traits as text |
| Effects | Numeric effects, features you switch on in play (Rage: Resistance, Rage Damage, Strength Advantage, no spells), damage riders from class tables (Sneak Attack, Divine Strike), Advantage on saves |
| Not yet | Shopping with starting gold, most other class features' dice and triggers (shown as text), most magic items' active powers, turns and rounds |

The design and the roadmap are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Project layout

| Path | Contents |
|---|---|
| `src/rules/` | Pure rules logic: dice, combat, spells, ability scores, build resolution and validation, sheet |
| `src/services/` | Workflows: the character builder (setters, normalization), play state (actions), combat and spell resolution |
| `src/models/` | Zod schemas and types for content, builds, characters and spells |
| `src/content/` | Catalog creation and validation, the bundled SRD, loading content from disk |
| `src/http/` | HTTP API (`fetch` handler) and the Node server adapter |
| `src/cli/` | The `srd-rules` command: interactive builder, `play`, `serve`, `validate` |
| `content/srd-5.2.1/` | Rules content as YAML: the source of truth |
| `schemas/`, `src/content/data/` | Generated by `npm run content` (JSON Schemas, bundled SRD JSON) |
| `examples/homebrew-pack/` | A sample content pack layered over the SRD |
| `docs/` | [Architecture](docs/ARCHITECTURE.md) and [content authoring](docs/CONTENT.md) |

## Development

```bash
npm install
npm test               # vitest
npm run check          # content up to date + lint + typecheck + tests (what CI runs)
npm run builder        # run the CLI builder from source
npm run content        # recompile content/ YAML → bundled JSON + JSON Schemas
npm run content:import-classes   # regenerate class levels 2–20 from the SRD Markdown (Python)
npm run build          # build dist/
```

Contributions are very welcome, especially content (classes, feats, spells).
[CONTRIBUTING.md](CONTRIBUTING.md) explains how.

## License and attribution

The code is licensed under the [MIT License](LICENSE).

This work includes material taken from the System Reference Document 5.2.1 ("SRD 5.2.1") by
Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is
licensed under the Creative Commons Attribution 4.0 International License, available at
https://creativecommons.org/licenses/by/4.0/legalcode. [DATA-SOURCES.md](DATA-SOURCES.md)
lists where each piece of content comes from.

This project is not affiliated with, endorsed, sponsored, or approved by Wizards of the Coast.
