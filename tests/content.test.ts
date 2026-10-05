import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { catalogItem } from "../src/content/catalog";
import {
  type CharacterBuild,
  ContentError,
  createCatalog,
  evaluate,
  lookup,
  srdPack,
  TABLE_NAMES,
} from "../src/index";
import { loadCatalog, loadContentPack } from "../src/node";
import * as svc from "../src/services/builder";
import { catalog, fighterBuild } from "./helpers";

const CONTENT_DIR = join(import.meta.dirname, "..", "content", "srd-5.2.1");

describe("SRD catalog", () => {
  it("loads the SRD subset", () => {
    expect(Object.keys(catalog.classes)).toEqual([
      "barbarian",
      "bard",
      "cleric",
      "druid",
      "fighter",
      "monk",
      "paladin",
      "ranger",
      "rogue",
      "sorcerer",
      "warlock",
      "wizard",
    ]);
    expect(Object.keys(catalog.species)).toHaveLength(9);
    expect(new Set(Object.keys(catalog.backgrounds))).toEqual(
      new Set(["acolyte", "criminal", "sage", "soldier"]),
    );
    expect(Object.keys(catalog.weapons)).toHaveLength(38);
    expect(Object.keys(catalog.armor)).toHaveLength(13);
    expect(Object.values(catalog.spells).filter((sp) => sp.level === 0)).toHaveLength(27);
    expect(Object.values(catalog.spells).filter((sp) => sp.level === 1)).toHaveLength(57);
  });

  it("the bundled JSON matches the YAML sources", () => {
    expect(loadCatalog(CONTENT_DIR)).toEqual(catalog);
  });

  it("every entity tracks its source", () => {
    for (const table of TABLE_NAMES) {
      for (const entity of Object.values(catalog[table])) {
        expect(entity.source, `${table}/${entity.id}`).toBe("srd-5.2.1");
      }
    }
  });

  it("weapon and armor rows match the SRD", () => {
    const greatsword = catalog.weapons.greatsword;
    expect([greatsword?.damage, greatsword?.mastery]).toEqual(["2d6", "graze"]);
    expect(greatsword?.properties).toEqual(expect.arrayContaining(["heavy", "two-handed"]));
    expect(catalog.weapons.longsword?.versatile_damage).toBe("1d10");
    const chain = catalog.armor["chain-mail"];
    expect([chain?.base_ac, chain?.dex_cap, chain?.strength]).toEqual([16, 0, 13]);
    expect(catalog.armor["hide-armor"]?.dex_cap).toBe(2);
  });

  it("the point buy table totals the standard array", () => {
    const { point_buy: pb, standard_array } = catalog.creation;
    expect(standard_array.reduce((sum, s) => sum + (pb.costs[s] ?? 0), 0)).toBe(pb.budget);
  });

  it("each class standard array is a permutation", () => {
    const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
    for (const cls of Object.values(catalog.classes)) {
      expect(sorted(Object.values(cls.standard_array))).toEqual(
        sorted(catalog.creation.standard_array),
      );
    }
  });

  it("is deeply frozen", () => {
    expect(Object.isFrozen(catalog.weapons.greatsword?.properties)).toBe(true);
  });

  it("looks up safely", () => {
    expect(lookup(catalog.classes, "constructor")).toBeUndefined();
    expect(catalogItem(catalog, "chain-mail").name).toBe("Chain Mail");
    expect(() => catalogItem(catalog, "nope")).toThrow(ContentError);
  });
});

describe("content packs", () => {
  it("rejects an unknown reference", () => {
    const dir = mkdtempSync(join(tmpdir(), "content-"));
    cpSync(CONTENT_DIR, dir, { recursive: true });
    const path = join(dir, "backgrounds.yaml");
    const backgrounds = parse(readFileSync(path, "utf-8"));
    backgrounds[0].grants.feats = [{ feat: "no-such-feat" }];
    writeFileSync(path, stringify(backgrounds));
    expect(() => loadCatalog(dir)).toThrow(/no-such-feat/);
  });

  it("reports schema errors with their location", () => {
    const bad = { ...srdPack, weapons: [{ id: "stick", name: "Stick" }] };
    expect(() => createCatalog(bad)).toThrow(/weapons\[0\] \(stick\)/);
  });

  it("rejects duplicate ids within a pack", () => {
    const species = srdPack.species ?? [];
    expect(() => createCatalog({ ...srdPack, species: [...species, species[0]] })).toThrow(
      /duplicate id 'dragonborn'/,
    );
  });

  it("a later pack extends and overrides earlier ones", () => {
    const homebrew = {
      name: "homebrew",
      feats: [
        {
          id: "alert",
          name: "Alert (house rule)",
          source: "homebrew",
          category: "origin",
          grants: { effects: [{ target: "initiative", value: 5 }] },
        },
      ],
      gear: [{ id: "lucky-coin", name: "Lucky Coin", source: "homebrew" }],
    };
    const layered = createCatalog(srdPack, homebrew);
    expect(layered.feats.alert?.name).toBe("Alert (house rule)");
    expect(layered.feats.alert?.source).toBe("homebrew");
    expect(layered.gear["lucky-coin"]?.source).toBe("homebrew");
    expect(Object.keys(layered.feats)).toHaveLength(Object.keys(catalog.feats).length);
  });

  it("requires creation rules", () => {
    expect(() => createCatalog({ gear: [] })).toThrow(/creation/);
  });

  it("loads a partial pack from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "homebrew-"));
    writeFileSync(
      join(dir, "gear.yaml"),
      "- {id: rope-of-holding, name: Rope of Holding, source: homebrew}\n",
    );
    const pack = loadContentPack(dir, "homebrew");
    expect(pack.gear).toHaveLength(1);
    expect(createCatalog(srdPack, pack).gear["rope-of-holding"]?.name).toBe("Rope of Holding");
  });

  it("an entity without a source gets its pack's name", () => {
    const gear = [
      { id: "lucky-coin", name: "Lucky Coin" },
      { id: "bent-nail", name: "Bent Nail", source: "my-book" },
    ];
    const named = createCatalog(srdPack, { name: "my-homebrew", gear });
    expect(named.gear["lucky-coin"]?.source).toBe("my-homebrew");
    expect(named.gear["bent-nail"]?.source).toBe("my-book");
    expect(named.gear.arrow?.source).toBe("srd-5.2.1");
    expect(createCatalog(srdPack, { gear }).gear["lucky-coin"]?.source).toBe("homebrew");
  });

  it("rejects effects the sheet doesn't understand", () => {
    const feat = (effect: object) => ({
      name: "bad",
      feats: [{ id: "odd", name: "Odd", category: "origin", grants: { effects: [effect] } }],
    });
    expect(() => createCatalog(srdPack, feat({ target: "speeed", value: 5 }))).toThrow(
      /unknown effect target 'speeed'/,
    );
    expect(() => createCatalog(srdPack, feat({ target: "ac", value: 1, when: "raging" }))).toThrow(
      /unknown effect condition 'raging'/,
    );
    const ok = createCatalog(
      srdPack,
      feat({ target: "skill.stealth", value: 1, when: "unarmored" }),
    );
    expect(ok.feats.odd?.grants.effects[0]?.target).toBe("skill.stealth");
  });
});

describe("examples/homebrew-pack", () => {
  it("layers over the SRD and builds a valid character", () => {
    const layered = createCatalog(
      srdPack,
      loadContentPack(join(import.meta.dirname, "..", "examples", "homebrew-pack")),
    );
    let b = fighterBuild();
    const set = <A extends unknown[]>(
      fn: (b: CharacterBuild, c: typeof layered, ...a: A) => { build: CharacterBuild },
      ...args: A
    ) => {
      b = fn(b, layered, ...args).build;
    };
    set(svc.setBackground, "gambler");
    set(svc.setBackgroundBonus, { dex: 2, cha: 1 });
    set(svc.setChoice, "background:gambler#equipment", ["a"]);
    set(svc.setChoice, "feat:lucky-streak@background:gambler#skill", ["history"]);
    // Gambler grants Insight, so normalize removed it from Skilled: pick a replacement.
    const skilled = "feat:skilled@species:human#versatile#proficiencies";
    expect(b.choices[skilled]).toEqual(["stealth", "lute"]);
    set(svc.setChoice, skilled, ["stealth", "lute", "arcana"]);
    expect(b.choices["background:soldier#tool"]).toBeUndefined(); // dropped by normalize
    const ev = evaluate(b, layered);
    expect(ev.report.issues.filter((i) => i.severity !== "note")).toEqual([]);
    expect(ev.sheet.initiative.parts.map((p) => p.source)).toContain("Lucky Streak");
    expect(ev.sheet.equipment["lucky-coin"]).toBe(1);
    expect(layered.packs.at(-1)).toMatchObject({ id: "homebrew-pack", source: "homebrew" });
    expect(layered.spells.light?.lists).toContain("warlock"); // patches.yaml
  });
});
