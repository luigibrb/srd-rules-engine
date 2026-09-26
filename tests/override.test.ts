import { describe, expect, it } from "vitest";
import {
  BuildError,
  type CharacterBuild,
  computeSheet,
  createCatalog,
  evaluate,
  reportErrors,
  resolve,
  seededRng,
  srdPack,
} from "../src/index";
import * as svc from "../src/services/builder";
import { apply, autocomplete, catalog, classBuild, fighterBuild, levelUpIn } from "./helpers";

const set = (b: CharacterBuild, key: string, values: string[]) =>
  apply(b, svc.setChoice, key, values);

// The SRD has one subclass per class: add a second Fighter subclass to test changing it.
const withKnight = createCatalog(srdPack, {
  name: "test",
  subclasses: [
    {
      id: "test-knight",
      name: "Test Knight",
      class: "fighter",
      source: "test",
      features: {
        "3": { traits: [{ name: "Oath", text: "A knightly oath." }] },
        "7": { choices: [{ id: "skill", label: "Knight skill", kind: "skill" }] },
      },
    },
  ],
});

describe("changing the subclass at level 3 on a level 7 Fighter", () => {
  let b = levelUpIn(fighterBuild(), "fighter", 2, null, withKnight);
  b = apply(
    b,
    (x, _c, ...a: [string, string[]]) => svc.setChoice(x, withKnight, ...a),
    "class:fighter:3#subclass",
    ["champion"],
  );
  b = levelUpIn(b, "fighter", 4, null, withKnight); // level 7, with Champion's Additional Fighting Style
  const key = "class:fighter:3#subclass";
  const change = (x: CharacterBuild) => svc.setChoice(x, withKnight, key, ["test-knight"]);

  it("previews exactly what changes", () => {
    expect(b.choices["subclass:champion:7#style"]).toHaveLength(1);
    const preview = svc.previewChange(b, withKnight, change, key);
    expect(preview.removed.map((r) => [r.level, r.key])).toEqual([
      [7, "subclass:champion:7#style"],
    ]);
    expect(preview.pending).toEqual([{ level: 7, message: "Knight skill: choose 1 more" }]);
    expect(preview.build.choices[key]).toEqual(["test-knight"]);
  });

  it("keeps every choice the change doesn't affect", () => {
    const { build } = change(b);
    for (const kept of ["class:fighter:4#feat", "class:fighter:6#feat", "class:fighter#skills"]) {
      expect(build.choices[kept], kept).toEqual(b.choices[kept]);
    }
    expect(computeSheet(build, withKnight).critical_hit_on).toBe(20); // no more Improved Critical
    expect(reportErrors(evaluate(build, withKnight).report)).toEqual([]);
  });
});

describe("choices are judged as of their own level", () => {
  // Level 4: the ASI slot takes Skilled, which picks History among others.
  let b = levelUpIn(fighterBuild(), "fighter", 2);
  b = svc.levelUp(b, catalog, "fighter").build;
  b = set(b, "class:fighter:4#feat", ["skilled"]);
  const skilled = "feat:skilled@class:fighter:4#feat#proficiencies";
  b = set(b, skilled, ["history", "arcana", "medicine"]);
  b = autocomplete(b);

  it("an earlier edit wins over a later pick of the same skill", () => {
    // Level 1 couldn't know about level 4, so History is a legal level 1 pick…
    const { build, notes } = svc.setChoice(b, catalog, "class:fighter#skills", [
      "acrobatics",
      "history",
    ]);
    expect(build.choices["class:fighter#skills"]).toEqual(["acrobatics", "history"]);
    // …and the later, now duplicate, pick gives way and is asked again.
    expect(build.choices[skilled]).toEqual(["arcana", "medicine"]);
    expect(notes).toEqual([
      "Skilled proficiencies: removed History (already proficient from Fighter).",
    ]);
    const pending = evaluate(build, catalog).report.issues.filter((i) => i.choice_key === skilled);
    expect(pending.map((i) => [i.level, i.message])).toEqual([
      [4, "Skilled proficiencies: choose 1 more"],
    ]);
  });

  it("a later choice still can't duplicate an earlier one", () => {
    expect(() => svc.setChoice(b, catalog, skilled, ["survival", "arcana", "medicine"])).toThrow(
      /already proficient/,
    );
  });
});

describe("the guard refuses changes that make a later level illegal", () => {
  // Fighter with Int 13, then a Wizard level.
  let b = classBuild("fighter");
  b = apply(b, svc.setBaseScores, { str: 15, dex: 14, con: 12, int: 13, wis: 10, cha: 8 });
  b = apply(b, svc.setBackgroundBonus, { str: 2, con: 1 });
  b = levelUpIn(autocomplete(b), "wizard");

  it("lowering Intelligence under the Wizard level", () => {
    let error: unknown;
    try {
      svc.setBaseScores(b, catalog, { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BuildError);
    expect((error as BuildError).messages).toEqual([
      "Level 2: Can't multiclass into Wizard: Wizard needs Intelligence 13+",
    ]);
    expect(b.base_scores.int).toBe(13); // unchanged
  });

  it("a harmless score change is fine", () => {
    const { build } = svc.setBaseScores(b, catalog, {
      str: 14,
      dex: 15,
      con: 12,
      int: 13,
      wis: 10,
      cha: 8,
    });
    expect(build.base_scores.dex).toBe(15);
  });

  it("a feat that loses its prerequisite is removed, not refused", () => {
    // Str 12 + 1 from the level 4 ASI = 13: enough for Grappler at level 8.
    let g = classBuild("fighter");
    g = apply(g, svc.setBaseScores, { str: 12, dex: 10, con: 15, int: 14, wis: 13, cha: 8 });
    g = apply(g, svc.setBackgroundBonus, { con: 2, dex: 1 });
    g = levelUpIn(autocomplete(g), "fighter", 2);
    g = svc.levelUp(g, catalog, "fighter").build;
    g = set(g, "class:fighter:4#feat", ["ability-score-improvement"]);
    const asi = "feat:ability-score-improvement@class:fighter:4#feat#increase";
    g = set(g, asi, ["str", "con"]);
    g = levelUpIn(autocomplete(g), "fighter", 3);
    g = svc.levelUp(g, catalog, "fighter").build;
    g = autocomplete(set(g, "class:fighter:8#feat", ["grappler"]));
    const preview = svc.previewChange(
      g,
      catalog,
      (x) => svc.setChoice(x, catalog, asi, ["con", "con"]),
      asi,
    );
    expect(preview.removed.map((r) => r.values)).toContainEqual(["Grappler"]);
    expect(preview.pending.some((p) => p.level === 8)).toBe(true);
  });
});

describe("changing the class of a past level", () => {
  const b = levelUpIn(levelUpIn(autocomplete(classBuild("fighter")), "fighter", 2), "fighter", 2);

  it("later class levels move with it, and keep their choices", () => {
    const subclass = b.choices["class:fighter:3#subclass"];
    const { build } = svc.setLevelClass(b, catalog, 3, "rogue");
    expect(build.levels.map((l) => l.class_id)).toEqual(["fighter", "rogue", "fighter", "fighter"]);
    const res = resolve(build, catalog);
    expect(res.choice("class:fighter:3#subclass")?.level).toBe(4);
    expect(build.choices["class:fighter:3#subclass"]).toEqual(subclass);
    expect(computeSheet(build, catalog).classes.map((c) => [c.class_id, c.level])).toEqual([
      ["fighter", 4],
      ["rogue", 1],
    ]);
  });

  it("is refused when the new class's prerequisite isn't met", () => {
    expect(() => svc.setLevelClass(b, catalog, 3, "wizard")).toThrow(
      /Wizard needs Intelligence 13\+/,
    );
  });
});

describe("random edits never leave the character illegal (seeded)", () => {
  it("each edit is either applied (and repairable) or refused", () => {
    const rng = seededRng(7);
    const classIds = Object.keys(catalog.classes);
    let applied = 0;
    let refused = 0;
    for (let run = 0; run < 6; run++) {
      let b = classBuild(classIds[rng.int(0, classIds.length - 1)] as string);
      b = apply(b, svc.setAbilityMethod, "point_buy");
      b = apply(b, svc.setBaseScores, { str: 13, dex: 13, con: 10, int: 13, wis: 12, cha: 13 });
      b = apply(b, svc.setBackgroundBonus, { str: 1, dex: 1, con: 1 });
      b = autocomplete(b);
      for (let level = 2; level <= 12; level++) {
        const options = svc.levelUpOptions(b, catalog).filter((o) => !o.unavailable);
        b = autocomplete(
          svc.levelUp(b, catalog, options[rng.int(0, options.length - 1)]?.class_id as string)
            .build,
        );
      }
      for (let edit = 0; edit < 8; edit++) {
        const res = resolve(b, catalog);
        const candidates = res.choices.filter((c) => c.fixed === null && !c.replaces);
        const target = candidates[rng.int(0, candidates.length - 1)];
        if (!target) continue;
        const free = res
          .options(target)
          .filter((o) => !o.unavailable)
          .map((o) => o.id);
        const n = res.countOf(target);
        const values = free.sort(() => rng.int(0, 2) - 1).slice(0, n);
        try {
          const { build } = svc.setChoice(b, catalog, target.key, values);
          expect(reportErrors(evaluate(build, catalog).report)).toEqual([]);
          b = autocomplete(build);
          applied++;
        } catch (error) {
          if (!(error instanceof BuildError)) throw error;
          refused++;
        }
        expect(evaluate(b, catalog).report.issues.filter((i) => i.severity !== "note")).toEqual([]);
      }
    }
    expect(applied).toBeGreaterThan(0);
    expect(applied + refused).toBeGreaterThan(20);
  });
});
