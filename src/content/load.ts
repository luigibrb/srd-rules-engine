/** Load a content pack from a directory of YAML (or JSON) files. Node.js only. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { type Catalog, type ContentPack, createCatalog, TABLE_NAMES } from "./catalog";

/**
 * Read a content directory laid out like `content/srd-5.2.1/`: `pack.yaml` (the manifest),
 * `creation.yaml`, `patches.yaml`, plus one file per table (`TABLE_NAMES`: `classes.yaml`, `spells.yaml`, `magic-items.yaml`…) or a folder of
 * files per table (`classes/<id>.yaml`).
 *
 * Every file is optional, so a homebrew pack can contain just `feats.yaml`. A file may hold
 * one entity or a list of them. `name` (default: the folder name) is also the `source` of
 * entities that don't declare one. The result is unvalidated: pass it to `createCatalog`.
 */
export function loadContentPack(dir: string, name: string = basename(dir)): ContentPack {
  const pack: ContentPack = { name };
  const manifest = readFirst(dir, "pack");
  if (manifest !== undefined) pack.manifest = manifest;
  const creation = readFirst(dir, "creation");
  if (creation !== undefined) pack.creation = creation;
  const patches = readFirst(dir, "patches");
  if (patches !== undefined) pack.patches = asList(patches);
  for (const table of TABLE_NAMES) {
    const entries: unknown[] = [];
    // `magic_items` → magic-items.yaml (either spelling works).
    const file = readFirst(dir, table) ?? readFirst(dir, table.replaceAll("_", "-"));
    if (file !== undefined) entries.push(...asList(file));
    const subdir = join(dir, table);
    if (existsSync(subdir)) {
      for (const entry of readdirSync(subdir).sort()) {
        if (/\.(ya?ml|json)$/.test(entry)) entries.push(...asList(readData(join(subdir, entry))));
      }
    }
    if (entries.length) pack[table] = entries;
  }
  return pack;
}

/** Load and validate one or more content directories, layered in order. */
export function loadCatalog(...dirs: string[]): Catalog {
  return createCatalog(...dirs.map((dir) => loadContentPack(dir)));
}

function readFirst(dir: string, stem: string): unknown {
  for (const ext of [".yaml", ".yml", ".json"]) {
    const path = join(dir, stem + ext);
    if (existsSync(path)) return readData(path);
  }
  return undefined;
}

function readData(path: string): unknown {
  const text = readFileSync(path, "utf-8");
  return path.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
}

function asList(data: unknown): unknown[] {
  if (data == null) return [];
  return Array.isArray(data) ? data : [data];
}
