import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import * as http from "../src/http/index";
import * as main from "../src/index";
import * as node from "../src/node";
import * as srd from "../src/srd";

// The names each entry point exports at runtime. A change here changes the public API: update
// the snapshot on purpose (`npx vitest run tests/api.test.ts -u`) and note it in CHANGELOG.md.
describe("public API", () => {
  it.each([
    ["srd-rules-engine", main],
    ["srd-rules-engine/http", http],
    ["srd-rules-engine/node", node],
    ["srd-rules-engine/srd", srd],
  ])("%s", (_, entry) => {
    expect(Object.keys(entry).sort()).toMatchSnapshot();
  });

  it("the Node entry adds only the bundled SRD, file loading and the server", () => {
    const extra = Object.keys(node).filter((k) => !(k in main));
    expect(extra.sort()).toEqual([
      "loadCatalog",
      "loadContentPack",
      "serveNode",
      "srdCatalog",
      "srdPack",
    ]);
  });

  it("the main entry doesn't import the bundled SRD data, even indirectly", () => {
    // Follow relative imports from src/index.ts: none may reach content/srd.ts or the JSON.
    const root = join(import.meta.dirname, "../src");
    const seen = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, "utf-8");
      for (const m of text.matchAll(/from "(\.[^"]+)"/g)) {
        const spec = m[1] as string;
        if (spec.endsWith(".json")) {
          seen.add(join(dirname(file), spec));
          continue;
        }
        const base = join(dirname(file), spec);
        visit(existsSync(`${base}.ts`) ? `${base}.ts` : join(base, "index.ts"));
      }
    };
    visit(join(root, "index.ts"));
    const reached = [...seen].map((f) => relative(root, f));
    expect(reached).toContain("services/encounter.ts");
    expect(reached.filter((f) => f === "content/srd.ts" || f.endsWith(".json"))).toEqual([]);
  });
});
