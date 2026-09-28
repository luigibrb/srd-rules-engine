import { describe, expect, it } from "vitest";
import * as http from "../src/http/index";
import * as main from "../src/index";
import * as node from "../src/node";

// The names each entry point exports at runtime. A change here changes the public API: update
// the snapshot on purpose (`npx vitest run tests/api.test.ts -u`) and note it in CHANGELOG.md.
describe("public API", () => {
  it.each([
    ["srd-rules-engine", main],
    ["srd-rules-engine/http", http],
    ["srd-rules-engine/node", node],
  ])("%s", (_, entry) => {
    expect(Object.keys(entry).sort()).toMatchSnapshot();
  });

  it("the Node entry adds only file loading and the server", () => {
    const extra = Object.keys(node).filter((k) => !(k in main));
    expect(extra.sort()).toEqual(["loadCatalog", "loadContentPack", "serveNode"]);
  });
});
