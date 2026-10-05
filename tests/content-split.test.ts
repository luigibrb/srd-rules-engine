import { describe, expect, it } from "vitest";
import {
  CORE_TABLES,
  ContentError,
  type ContentPack,
  computeSheet,
  createCatalog,
  isLoaded,
  loadPack,
  lookup,
  splitPack,
  TABLE_NAMES,
  type TableName,
} from "../src/index";
import { srdCatalog, srdPack } from "../src/srd";
import { autocomplete, classBuild, fighterBuild } from "./helpers";

// The SRD split by table (what the build publishes in dist/srd-5.2.1/) and partial catalogs.

/** The split files as a server would serve them (JSON text), read back by `loadPack`. */
function served(pack: ContentPack) {
  const files = new Map(
    Object.entries(splitPack(pack)).map(([name, data]) => [name, JSON.stringify(data)]),
  );
  const fetched: string[] = [];
  const fetchJson = async (path: string) => {
    fetched.push(path);
    const text = files.get(path);
    if (text === undefined) throw new Error(`404 ${path}`);
    return JSON.parse(text);
  };
  return { files, fetched, fetchJson };
}

describe("splitPack and loadPack", () => {
  it("one file per table plus a manifest, read back into the same catalog", async () => {
    const { files, fetchJson } = served(srdPack);
    expect([...files.keys()].sort()).toEqual(
      ["manifest.json", ...TABLE_NAMES.map((t) => `${t}.json`)].sort(),
    );
    const manifest = JSON.parse(files.get("manifest.json") as string);
    expect(manifest.tables.monsters).toEqual({ file: "monsters.json", count: 330 });
    expect(manifest.manifest.id).toBe("srd-5.2.1");
    const catalog = createCatalog(await loadPack(fetchJson));
    const srd = srdCatalog();
    for (const t of TABLE_NAMES) {
      expect(Object.keys(catalog[t]).length, t).toBe(Object.keys(srd[t]).length);
    }
    expect(catalog.classes).toEqual(srd.classes);
    expect(catalog.spells.fireball).toEqual(srd.spells.fireball);
    expect(catalog.monsters["adult-red-dragon"]).toEqual(srd.monsters["adult-red-dragon"]);
    expect(catalog.creation).toEqual(srd.creation);
    expect(catalog.packs).toEqual(srd.packs);
  });

  it("only the tables asked for are fetched", async () => {
    const { fetched, fetchJson } = served(srdPack);
    const pack = await loadPack(fetchJson, { tables: CORE_TABLES });
    expect(fetched.sort()).toEqual(
      ["manifest.json", ...CORE_TABLES.map((t) => `${t}.json`)].sort(),
    );
    expect(pack.monsters).toBeUndefined();
    expect(pack.classes?.length).toBe(12);
  });
});

describe("a catalog with some tables", () => {
  const core = createCatalog([srdPack], { tables: CORE_TABLES });
  const casters = createCatalog([srdPack], { tables: [...CORE_TABLES, "spells"] });

  it("builds a fighter's sheet without spells, magic items or monsters", () => {
    expect(isLoaded(core.classes)).toBe(true);
    expect(isLoaded(core.monsters)).toBe(false);
    const sheet = computeSheet(fighterBuild(), core);
    expect(sheet.armor_class.total).toBe(
      computeSheet(fighterBuild(), srdCatalog()).armor_class.total,
    );
  });

  it("a wizard needs the spells table", () => {
    const wizard = autocomplete(classBuild("wizard"), casters);
    expect(computeSheet(wizard, casters).spells.length).toBeGreaterThan(0);
  });

  it("reading a table that wasn't loaded says so", () => {
    const message =
      "The table 'monsters' isn't loaded in this catalog (createCatalog's `tables` option)";
    expect(() => lookup(core.monsters, "goblin-warrior")).toThrow(ContentError);
    expect(() => lookup(core.monsters, "goblin-warrior")).toThrow(message);
    expect(() => Object.values(core.monsters)).toThrow(message);
    expect(() => core.monsters["goblin-warrior"]).toThrow(message);
  });

  it("patches to a table that isn't loaded are skipped", () => {
    const pack = {
      name: "patching",
      patches: [{ target: "monsters/goblin-warrior", op: "set", path: "hit_points", value: 99 }],
    };
    const tables: TableName[] = [...CORE_TABLES];
    expect(() => createCatalog([srdPack, pack], { tables })).not.toThrow();
    const full = createCatalog(srdPack, pack);
    expect(full.monsters["goblin-warrior"]?.hit_points).toBe(99);
  });
});
