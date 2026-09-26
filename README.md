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

## Command line

```bash
npx srd-rules build                    # interactive level 1 character builder
npx srd-rules build --load characters/aerin.json --seed 7
npx srd-rules serve --port 8000        # HTTP API
npx srd-rules validate my-homebrew/    # check a content pack
npx srd-rules build --content my-homebrew/   # build with homebrew layered over the SRD
```

The builder walks you through Class, Species, Background, Ability Scores, Equipment,
Features, Skills & Tools, Languages, and Name & Alignment, in dependency order, and you can
jump between steps at any time. A live panel shows HP, AC, Initiative, Speed and Passive
Perception. Options you can't pick are greyed out with the reason, and picks that change
your numbers show a preview (`Defense · AC 16→17`).

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
| `POST /v1/builds/evaluate` | Build → validation report, derived sheet, and every choice with its options |
| `POST /v1/characters/` | Validate a combat-ready `Character` |
| `POST /v1/characters/{name}/alive` | Is the character above 0 HP |
| `POST /v1/characters/{name}/passive-perception` | Passive Perception (`?proficient=true`) |
| `POST /v1/combat/roll` | Roll a dice expression (`{"expression": "2d6+3"}`) |
| `POST /v1/combat/attack` | Attack roll and damage (crits double all dice) |
| `POST /v1/combat/saving-throw` | Saving throw |
| `POST /v1/spells/stats` | Spell save DC and attack bonus |
| `POST /v1/spells/attack` · `/v1/spells/save` | Spell attack or save (half damage on success) |

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

The `$schema` comment gives you autocompletion and inline errors in VS Code (with the YAML
extension) and other editors. See [`examples/homebrew-pack`](examples/homebrew-pack) and
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
| Character creation | Level 1, complete: all 9 SRD species and all 4 SRD backgrounds |
| Classes | Fighter (others are YAML files away; see [CONTRIBUTING](CONTRIBUTING.md)) |
| Combat | Attacks, damage, crits, saving throws, save-for-half spells |
| Not yet | Spell selection (Magic Initiate is flagged as a note), shopping with starting gold, levels 2+, conditions, the full Effect engine |

The design and the roadmap are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development

```bash
npm install
npm test               # vitest
npm run check          # content up to date + lint + typecheck + tests (what CI runs)
npm run builder        # run the CLI builder from source
npm run content        # recompile content/ YAML → bundled JSON + JSON Schemas
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
