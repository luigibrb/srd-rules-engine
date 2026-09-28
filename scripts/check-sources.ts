/**
 * Leak guard: fail if content that isn't SRD 5.2.1 (or invented homebrew) is in the repo.
 *
 *   npm run check:sources      # also part of `npm run check` (CI)
 *
 * Checks every tracked or new (not ignored) file:
 * - `content/` holds only `content/srd-5.2.1/`;
 * - every `source` in `content/` and in the bundled JSON is `srd-5.2.1`;
 * - every `source` in the example packs and test fixtures is `srd-5.2.1`, `homebrew` or `test`.
 *
 * An entity without a `source` takes its pack's name, so content pasted into `content/srd-5.2.1/`
 * without one can't be told apart from the SRD: always give private packs an explicit `source`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const root = join(import.meta.dirname, "..");
const SRD = "srd-5.2.1";
const RULES: { prefix: string; allowed: readonly string[] }[] = [
  { prefix: "content/", allowed: [SRD] },
  { prefix: "src/content/data/", allowed: [SRD] },
  { prefix: "examples/", allowed: [SRD, "homebrew", "test"] },
  { prefix: "tests/fixtures/", allowed: [SRD, "homebrew", "test"] },
];

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf-8",
})
  .split("\n")
  .filter(Boolean);

const errors: string[] = [];
for (const file of files) {
  if (file.startsWith("content/") && !file.startsWith(`content/${SRD}/`)) {
    errors.push(`${file}: only content/${SRD}/ belongs in content/`);
  }
  const rule = RULES.find((r) => file.startsWith(r.prefix));
  if (!rule || !/\.(ya?ml|json)$/.test(file)) continue;
  let data: unknown;
  try {
    const text = readFileSync(join(root, file), "utf-8");
    data = file.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  } catch {
    continue; // deleted in the working tree, or not data: nothing to check
  }
  for (const [path, source] of sources(data, "")) {
    if (!rule.allowed.includes(source)) {
      errors.push(`${file}${path}: source '${source}' (allowed here: ${rule.allowed.join(", ")})`);
    }
  }
}

if (errors.length) {
  console.error(`Content that isn't SRD ${SRD} or homebrew:\n${errors.join("\n")}`);
  process.exit(1);
}
console.log(`sources ok: ${files.length} files checked`);

/** Every string `source` field in a parsed document, with its path. */
function* sources(value: unknown, path: string): Generator<[string, string]> {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) yield* sources(item, `${path}[${i}]`);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "source" && typeof child === "string") yield [`${path}.source`, child];
      else yield* sources(child, `${path}.${key}`);
    }
  }
}
