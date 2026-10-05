/**
 * Compile `content/srd-5.2.1/` (YAML) into the JSON bundled with the package, and generate
 * JSON Schemas for content authors (editor autocompletion and validation for YAML files).
 *
 *   npm run content             write the outputs
 *   npm run content -- --check  fail if the outputs are out of date (used in CI)
 *
 * Both report the bundle's size and fail if its gzipped size is over MAX_GZIP_KB: past that,
 * the content should be split by table (docs/ROADMAP.md, "Split content by table").
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { createCatalog, TABLE_NAMES, TABLE_SCHEMAS } from "../src/content/catalog";
import { loadContentPack } from "../src/content/load";
import { CharacterBuildSchema } from "../src/models/build";
import { CreationSchema } from "../src/models/content";
import { EncounterActionSchema, EncounterSchema } from "../src/models/encounter";
import { CombatantOptionsSchema } from "../src/models/options";
import { PackManifestSchema, PatchSchema } from "../src/models/pack";
import { CharacterStateSchema, PlayActionSchema } from "../src/models/state";

const root = join(import.meta.dirname, "..");
/** Budget for the bundled SRD, gzipped (what a browser downloads). */
const MAX_GZIP_KB = 1024;
const check = process.argv.includes("--check");
const outputs = new Map<string, string>();

// 1. The SRD pack, validated and normalized (defaults filled in).
const catalog = createCatalog(loadContentPack(join(root, "content/srd-5.2.1")));
const pack = {
  name: "srd-5.2.1",
  manifest: catalog.packs[0],
  creation: catalog.creation,
  ...Object.fromEntries(TABLE_NAMES.map((t) => [t, Object.values(catalog[t])])),
};
outputs.set("src/content/data/srd-5.2.1.json", `${JSON.stringify(pack, null, 4)}\n`);

// 2. JSON Schemas: one per content file kind, the saved character build, play documents.
const schema = (s: z.ZodType, title: string, list: boolean) => {
  const json = z.toJSONSchema(list ? z.union([s, z.array(s)]) : s, {
    io: "input",
    unrepresentable: "any",
  });
  return `${JSON.stringify({ ...json, title }, null, 2)}\n`;
};
outputs.set(
  "schemas/creation.schema.json",
  schema(CreationSchema, "Character creation rules", false),
);
for (const table of TABLE_NAMES) {
  outputs.set(
    `schemas/${table}.schema.json`,
    schema(TABLE_SCHEMAS[table], `${table} content`, true),
  );
}
outputs.set("schemas/pack.schema.json", schema(PackManifestSchema, "Content pack manifest", false));
outputs.set("schemas/patches.schema.json", schema(PatchSchema, "Content patches", true));
outputs.set("schemas/build.schema.json", schema(CharacterBuildSchema, "Character build", false));
// Play documents and the actions that change them (frontends, servers, other languages).
outputs.set(
  "schemas/state.schema.json",
  schema(CharacterStateSchema, "Character play state", false),
);
outputs.set("schemas/encounter.schema.json", schema(EncounterSchema, "Encounter", false));
outputs.set("schemas/play-action.schema.json", schema(PlayActionSchema, "Play action", true));
outputs.set(
  "schemas/encounter-action.schema.json",
  schema(EncounterActionSchema, "Encounter action", true),
);
// A computed result, not a document: what `POST /v1/encounters/options` returns.
outputs.set(
  "schemas/options.schema.json",
  `${JSON.stringify(
    {
      ...z.toJSONSchema(CombatantOptionsSchema, { io: "output", unrepresentable: "any" }),
      title: "Combatant options",
    },
    null,
    2,
  )}\n`,
);

let stale = 0;
for (const [rel, content] of outputs) {
  const path = join(root, rel);
  const current = existsSync(path) ? readFileSync(path, "utf-8") : null;
  if (current === content) continue;
  if (check) {
    console.error(`out of date: ${rel}`);
    stale += 1;
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    console.log(`wrote ${rel}`);
  }
}
if (stale) {
  console.error("Run `npm run content` and commit the result.");
  process.exit(1);
}
console.log(
  `content ok: ${TABLE_NAMES.map((t) => `${Object.keys(catalog[t]).length} ${t}`).join(", ")}`,
);

// 3. Size: minified and gzipped, and the largest tables.
const minified = JSON.stringify(pack);
const kb = (bytes: number) => Math.round(bytes / 1024);
const gzipKb = kb(gzipSync(minified).length);
const largest = TABLE_NAMES.map(
  (t) => [t, JSON.stringify(Object.values(catalog[t])).length] as const,
)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 3)
  .map(([t, size]) => `${t} ${Math.round((100 * size) / minified.length)}%`);
console.log(
  `bundle: ${kb(minified.length)} KB minified, ${gzipKb} KB gzip (${largest.join(", ")})`,
);
if (gzipKb > MAX_GZIP_KB) {
  console.error(
    `The bundled SRD is over its budget (${gzipKb} KB > ${MAX_GZIP_KB} KB gzipped): ` +
      'split content by table (docs/ROADMAP.md, "Split content by table").',
  );
  process.exit(1);
}
