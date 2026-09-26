# Contributing

Thanks for helping! Rules content (classes, feats, spells, items) is the most valuable
contribution and needs no TypeScript at all.

## Setup

```bash
npm install
npm run check      # what CI runs: content up to date, lint, typecheck, tests
```

Node 22.18 or newer is required (`.nvmrc` pins 24).

## Adding or fixing content

1. Edit or add YAML under `content/srd-5.2.1/` (a class is `classes/<id>.yaml`). Transcribe
   from the SRD 5.2.1. Don't copy text from any other source, and summarize long trait text.
2. Run `npm run content`. It validates everything (schemas and cross-references) and
   regenerates the bundled JSON and JSON Schemas. Commit the generated files too.
3. Add a test with a concrete character in `tests/sheet.test.ts`, e.g. "a level 1 Wizard with
   Int 16 has spell save DC 13".
4. Update `DATA-SOURCES.md` if you add a new file.

Add the `# yaml-language-server: $schema=../../schemas/<table>.schema.json` comment at the top
of a YAML file to get autocompletion in your editor.

**Only SRD content goes in `content/srd-5.2.1/`.** Anything else must have a different
`source`, live in its own folder, and be listed in `DATA-SOURCES.md` together with its license.
If a rule is ambiguous, or can't be expressed with the current schema, open an issue rather
than inventing an interpretation.

## Code

- `src/rules/` is pure logic: no I/O, no globals, and dice always go through an injectable `Rng`.
- Builds, catalogs and sheets are immutable, plain data. Setters return new objects.
- Data fields are `snake_case` (they're the wire and file format, shared with YAML and JSON);
  functions and variables are `camelCase`.
- `src/index.ts` and `src/http/` must not import Node built-ins, so they keep working in
  browsers and workers. Node-only code goes in `src/content/load.ts`, `src/http/node-server.ts`
  or `src/cli/`.
- Run `npm run format` before committing.

## Pull requests

Keep each PR to one logical change, with tests. Describe any rules interpretation and cite
the SRD section it comes from.
