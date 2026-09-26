import { copyFileSync } from "node:fs";
import { defineConfig } from "tsdown";

export default defineConfig([
  {
    // One build so the entries share chunks (a single copy of every class and cache).
    // `index` and `http` are platform-neutral; only `node` imports Node built-ins.
    entry: { index: "src/index.ts", http: "src/http/index.ts", node: "src/node.ts" },
    format: ["esm", "cjs"],
    platform: "neutral",
    external: [/^node:/],
    dts: true,
    clean: true,
    hooks: {
      "build:done": () => copyFileSync("src/content/data/srd-5.2.1.json", "dist/srd-5.2.1.json"),
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
