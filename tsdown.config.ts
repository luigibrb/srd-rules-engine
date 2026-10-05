import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "tsdown";
import { splitPack } from "./src/content/split";

export default defineConfig([
  {
    // One build so the entries share chunks (a single copy of every class and cache).
    // `index`, `srd` and `http` are platform-neutral; only `node` imports Node built-ins.
    // `index` doesn't contain the SRD data: `srd` (and `http`, `node`) bundle it.
    entry: {
      index: "src/index.ts",
      srd: "src/srd.ts",
      http: "src/http/index.ts",
      node: "src/node.ts",
    },
    format: ["esm", "cjs"],
    platform: "neutral",
    external: [/^node:/],
    dts: true,
    clean: true,
    hooks: {
      // The published JSON is minified (the repo copy stays formatted for reading), whole and
      // split by table (`dist/srd-5.2.1/manifest.json` + `<table>.json`, for `loadPack`).
      "build:done": () => {
        const data = JSON.parse(readFileSync("src/content/data/srd-5.2.1.json", "utf-8"));
        writeFileSync("dist/srd-5.2.1.json", JSON.stringify(data));
        mkdirSync("dist/srd-5.2.1", { recursive: true });
        for (const [file, content] of Object.entries(splitPack(data))) {
          writeFileSync(join("dist/srd-5.2.1", file), JSON.stringify(content));
        }
      },
    },
  },
  {
    entry: { cli: "src/cli/main.ts" },
    format: ["esm"],
    platform: "node",
    dts: false,
    clean: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
