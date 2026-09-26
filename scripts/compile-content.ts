/**
 * Compile `content/srd-5.2.1/` (YAML) into the JSON bundled with the package, and generate
 * JSON Schemas for content authors (editor autocompletion and validation for YAML files).
 *
 *   npm run content             write the outputs
 *   npm run content -- --check  fail if the outputs are out of date (used in CI)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { createCatalog, TABLE_NAMES, TABLE_SCHEMAS } from "../src/content/catalog";
import { loadContentPack } from "../src/content/load";
import { CharacterBuildSchema } from "../src/models/build";
import { CreationSchema } from "../src/models/content";

const root = join(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const outputs = new Map<string, string>();

// 1. The SRD pack, validated and normalized (defaults filled in).
const catalog = createCatalog(loadContentPack(join(root, "content/srd-5.2.1")));
const pack = {
  name: "srd-5.2.1",
  creation: catalog.creation,
  ...Object.fromEntries(TABLE_NAMES.map((t) => [t, Object.values(catalog[t])])),
};
outputs.set("src/content/data/srd-5.2.1.json", `${JSON.stringify(pack)}\n`);

// 2. JSON Schemas: one per content file kind, plus the saved character build.
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
outputs.set("schemas/build.schema.json", schema(CharacterBuildSchema, "Character build", false));

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
