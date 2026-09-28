# Contributing

Thanks for helping! Rules content (classes, feats, spells, items) is the most valuable
contribution and needs no TypeScript at all.

## Setup

```bash
npm install
npm run check      # what CI runs: content up to date, leak guard, lint, typecheck, tests
```

Node 22.18 or newer is required (`.nvmrc` pins 24).

## Adding or fixing content

1. Edit or add YAML under `content/srd-5.2.1/` (a class is `classes/<id>.yaml`). Transcribe
   from the SRD 5.2.1. Don't copy text from any other source, and summarize long trait text.
   Much of the SRD content is generated from the SRD Markdown in `docs/srd-5.2.1/` (see
   [DATA-SOURCES.md](DATA-SOURCES.md)): change the importer's overlay tables, not the generated
   YAML, and rerun it.
   - Class levels 2–20, subclasses, invocations, Metamagic: `scripts/import-srd-classes.py`
     (`npm run content:import-classes`, needs Python 3 + PyYAML). Level 1 is edited in the YAML.
   - Spells: `scripts/import-srd-spells.ts`. Spell `mechanics` are drafted by its parser and
     used only for ids in `REVIEWED`, after checking them against the spell's text;
     `--report` lists drafts and skips. Hand-written ones go in `MECHANICS`.
   - Magic items and conditions: `scripts/import-srd-items.ts`.
   - Monsters: `scripts/import-srd-monsters.ts` (throws on anything it can't read; corrections to
     the Markdown go in `FIXES`, with the reason).
2. Run `npm run content`. It validates everything (schemas and cross-references) and
   regenerates the bundled JSON and JSON Schemas. Commit the generated files too.
3. Add a test with a concrete character in `tests/sheet.test.ts`, e.g. "a level 1 Wizard with
   Int 16 has spell save DC 13". A change to spell or monster mechanics shows up in the
   snapshots of `tests/casting.test.ts` and `tests/monsters.test.ts`: update them on purpose
   (`npx vitest run -u`) after checking the change against the SRD.
4. Update `DATA-SOURCES.md` if you add a new file.

Add the `# yaml-language-server: $schema=../../schemas/<table>.schema.json` comment at the top
of a YAML file to get autocompletion in your editor.

**This repository holds only SRD 5.2.1 content and invented homebrew** (examples and test
fixtures use `source: homebrew` or `test`). `npm run check` fails on anything else. Content
from other books belongs in your own pack, outside this repository; see "Writing your own pack"
in [docs/CONTENT.md](docs/CONTENT.md). If a rule is ambiguous, or can't be expressed with the
current schema, open an issue rather than inventing an interpretation; interpretations the
engine makes are listed in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Code

- `src/rules/` is pure logic: no I/O, no globals, and dice always go through an injectable `Rng`.
- Builds, catalogs and sheets are immutable, plain data. Setters return new objects.
- Data fields are `snake_case` (they're the wire and file format, shared with YAML and JSON);
  functions and variables are `camelCase`.
- `src/index.ts` and `src/http/` must not import Node built-ins, so they keep working in
  browsers and workers. Node-only code goes in `src/content/load.ts`, `src/http/node-server.ts`
  or `src/cli/`.
- Saved documents (builds, play states, encounters) change only through their functions
  (builder setters, `applyAction`, `applyEncounterAction`), which check the rules. Combat
  functions (`makeAttack`, `castSpell`, `useSaveAction`) return results and play actions; they
  never change a document themselves. Damage always goes through `takeDamage`.
- A change to the public exports updates `tests/__snapshots__/api.test.ts.snap`; note it in
  `CHANGELOG.md`.
- Run `npm run format` before committing.

## Pull requests

Keep each PR to one logical change, with tests. Describe any rules interpretation and cite
the SRD section it comes from.
