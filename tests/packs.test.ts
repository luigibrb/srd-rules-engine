import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ContentPack,
  createCatalog,
  evaluate,
  srdCatalog,
  srdPack,
  updateBuild,
} from "../src/index";
import { loadContentPack } from "../src/node";
import { fighterBuild } from "./helpers";

// Invented homebrew only: this repo holds no non-SRD content.
const lanternPack = (extra: Partial<ContentPack> = {}): ContentPack => ({
  name: "lantern-folder",
  manifest: { id: "lantern", version: "0.1.0", requires: ["srd-5.2.1"] },
  gear: [{ id: "glow-jar", name: "Glow Jar" }],
  ...extra,
});

describe("pack manifests", () => {
  it("the SRD declares itself", () => {
    expect(srdCatalog().packs).toEqual([
      expect.objectContaining({ id: "srd-5.2.1", version: "5.2.1", ruleset: "2024" }),
    ]);
  });

  it("names the pack and the default source of its entities", () => {
    const layered = createCatalog(srdPack, lanternPack());
    expect(layered.packs.map((p) => p.id)).toEqual(["srd-5.2.1", "lantern"]);
    expect(layered.gear["glow-jar"]?.source).toBe("lantern");
    const withSource = lanternPack({
      manifest: { id: "lantern", source: "lantern-book", requires: ["srd-5.2.1"] },
    });
    expect(createCatalog(srdPack, withSource).gear["glow-jar"]?.source).toBe("lantern-book");
  });

  it("a pack without a manifest gets a minimal one", () => {
    const layered = createCatalog(srdPack, { name: "loose", gear: [] });
    expect(layered.packs[1]).toMatchObject({ id: "loose", version: null, requires: [] });
  });

  it("required packs must be loaded first, and only once", () => {
    expect(() => createCatalog(lanternPack(), srdPack)).toThrow(
      /lantern: needs pack 'srd-5.2.1', loaded before it/,
    );
    expect(() => createCatalog(srdPack, lanternPack(), lanternPack())).toThrow(
      /lantern: the pack is loaded twice/,
    );
  });
});

describe("patches", () => {
  const patched = (...patches: unknown[]) => createCatalog(srdPack, lanternPack({ patches }));

  it("append to a list without copying the entity", () => {
    const c = patched({ target: "spells/fireball", op: "append", path: "lists", value: "warlock" });
    expect(c.spells.fireball?.lists).toEqual(["sorcerer", "wizard", "warlock"]);
    expect(c.spells.fireball?.source).toBe("srd-5.2.1");
    expect(srdCatalog().spells.fireball?.lists).toEqual(["sorcerer", "wizard"]);
  });

  it("set a nested field, finding list elements by id", () => {
    const c = patched({
      target: "classes/fighter",
      op: "set",
      path: "grants.choices.skills.count",
      value: 3,
    });
    const skills = evaluate(fighterBuild(), c).resolution.choice("class:fighter#skills");
    expect(skills?.definition.count).toBe(3);
  });

  it("remove items by value or by id", () => {
    const c = patched(
      { target: "spells/fireball", op: "remove", path: "lists", value: ["wizard"] },
      { target: "classes/fighter", op: "remove", path: "grants.choices.skills" },
    );
    expect(c.spells.fireball?.lists).toEqual(["sorcerer"]);
    expect(c.classes.fighter?.grants.choices.map((ch) => ch.id)).not.toContain("skills");
  });

  it("apply in order, after the pack's own entities", () => {
    const c = patched(
      { target: "gear/glow-jar", op: "set", path: "description", value: "Bright." },
      { target: "gear/glow-jar", op: "set", path: "description", value: "Brighter." },
    );
    expect(c.gear["glow-jar"]?.description).toBe("Brighter.");
  });

  it("refuse what they can't do, saying where", () => {
    const bad: [unknown, RegExp][] = [
      [{ target: "spells/no-such", op: "set", path: "level", value: 1 }, /no spells 'no-such'/],
      [{ target: "potions/x", op: "set", path: "a", value: 1 }, /unknown table 'potions'/],
      [{ target: "spells/fireball", op: "set", path: "a.b", value: 1 }, /no 'a'/],
      [{ target: "spells/fireball", op: "append", path: "level", value: 1 }, /isn't a list/],
      [{ target: "spells/fireball", op: "set", path: "level", value: 12 }, /patches\[0\]/],
      [{ target: "spells/fireball", op: "set", path: "id", value: "big-ball" }, /change the id/],
      [{ target: "spells/fireball", op: "remove", path: "lists", value: "bard" }, /has none/],
    ];
    for (const [patch, message] of bad) expect(() => patched(patch)).toThrow(message);
  });

  it("load from patches.yaml and pack.yaml", () => {
    const dir = mkdtempSync(join(tmpdir(), "lantern-"));
    writeFileSync(join(dir, "pack.yaml"), "id: lantern\nrequires: [srd-5.2.1]\n");
    writeFileSync(
      join(dir, "patches.yaml"),
      "- {target: spells/fireball, op: append, path: lists, value: [bard]}\n",
    );
    const c = createCatalog(srdPack, loadContentPack(dir));
    expect(c.packs.map((p) => p.id)).toEqual(["srd-5.2.1", "lantern"]);
    expect(c.spells.fireball?.lists).toContain("bard");
  });
});

describe("filtering by source", () => {
  it("keeps only the enabled sources' entities and patches", () => {
    const pack = lanternPack({
      patches: [{ target: "spells/fireball", op: "append", path: "lists", value: "warlock" }],
    });
    const all = createCatalog([srdPack, pack], {});
    expect(all.gear["glow-jar"]).toBeDefined();
    const srdOnly = createCatalog([srdPack, pack], { sources: ["srd-5.2.1"] });
    expect(srdOnly.gear["glow-jar"]).toBeUndefined();
    expect(srdOnly.spells.fireball?.lists).toEqual(["sorcerer", "wizard"]);
    expect(srdOnly.packs.map((p) => p.id)).toEqual(["srd-5.2.1", "lantern"]);
  });

  it("reports entities that refer to a filtered-out one", () => {
    const pack = lanternPack({
      feats: [
        {
          id: "jar-keeper",
          name: "Jar Keeper",
          source: "srd-5.2.1-compatible",
          category: "origin",
          grants: { items: [{ item: "glow-jar" }] },
        },
      ],
    });
    expect(() =>
      createCatalog([srdPack, pack], { sources: ["srd-5.2.1", "srd-5.2.1-compatible"] }),
    ).toThrow(/jar-keeper: unknown item 'glow-jar'/);
  });
});

describe("builds that need packs", () => {
  it("report a missing pack instead of unknown ids", () => {
    const build = updateBuild(fighterBuild(), { packs: ["lantern"] });
    const missing = evaluate(build, srdCatalog()).report.issues.filter(
      (i) => i.severity === "error",
    );
    expect(missing.map((i) => i.message)).toEqual([
      "Needs content pack 'lantern', which isn't loaded",
    ]);
    const layered = createCatalog(srdPack, lanternPack());
    expect(evaluate(build, layered).report.issues.filter((i) => i.severity === "error")).toEqual(
      [],
    );
  });

  it("builds without the field are unchanged", () => {
    expect("packs" in fighterBuild()).toBe(false);
  });
});
