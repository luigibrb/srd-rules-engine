import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createBuild,
  createEncounter,
  createState,
  DOCUMENT_VERSION,
  parseBuild,
  parseEncounter,
  parseState,
} from "../src/index";
import { catalog, fighterBuild } from "./helpers";

// Saved documents carry a format version: missing means 1, newer than this engine is refused.

describe("document versions", () => {
  it("new documents are written with the current version", () => {
    expect(DOCUMENT_VERSION).toBe(1);
    expect(createBuild().version).toBe(1);
    expect(createState(fighterBuild(), catalog).version).toBe(1);
    expect(createEncounter().version).toBe(1);
  });

  it("a document without a version is version 1", () => {
    const python = JSON.parse(
      readFileSync(join(import.meta.dirname, "fixtures/python-builder-save.json"), "utf-8"),
    );
    expect(python.version).toBeUndefined();
    expect(parseBuild(python).version).toBe(1);
    expect(parseState({}).version).toBe(1);
    expect(parseEncounter({}).version).toBe(1);
  });

  it("a document from a newer engine is refused with a clear message", () => {
    const newer = { version: DOCUMENT_VERSION + 1 };
    for (const parse of [parseBuild, parseState, parseEncounter]) {
      expect(() => parse(newer)).toThrow(/saved by a newer srd-rules-engine/);
    }
  });
});
