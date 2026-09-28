import { describe, expect, it } from "vitest";
import { computeSheet, createBuild, explainStat } from "../src/index";
import * as svc from "../src/services/builder";
import { apply, catalog, fighterBuild } from "./helpers";

const attacks = (build = fighterBuild()) =>
  new Map(computeSheet(build, catalog).attacks.map((a) => [a.name, a]));

describe("fighter sheet", () => {
  it("computes the headline numbers", () => {
    const sheet = computeSheet(fighterBuild(), catalog);
    expect(sheet.scores.str).toBe(17);
    expect(sheet.scores.con).toBe(14);
    expect(sheet.max_hp?.total).toBe(12); // 10 + Con 2
    expect(sheet.armor_class.total).toBe(17); // Chain Mail 16 + Defense 1
    expect(sheet.armor_class.parts.map((p) => p.source)).toEqual(["Chain Mail", "Defense"]);
    expect(explainStat(sheet.armor_class)).toBe("16 Chain Mail + 1 Defense");
    expect(sheet.initiative.total).toBe(2);
    expect(sheet.speed.total).toBe(30);
    expect(sheet.saving_throws.str).toEqual({ modifier: 5, proficient: true });
    expect(sheet.saving_throws.dex).toEqual({ modifier: 2, proficient: false });
    expect(sheet.passive_perception).toBe(12); // 10 + Wis 0 + prof 2 (Skillful)
    const athletics = sheet.skills.find((s) => s.skill === "athletics");
    expect([athletics?.modifier, athletics?.proficient_from]).toEqual([5, "Soldier"]);
    expect(sheet.gp).toBe(4 + 50);
    expect(Object.keys(sheet.tools).sort()).toEqual(["dice-set", "lute"]);
  });

  it("is plain JSON", () => {
    const sheet = computeSheet(fighterBuild(), catalog);
    expect(JSON.parse(JSON.stringify(sheet))).toEqual(sheet);
  });

  it("lists attacks with mastery", () => {
    const a = attacks();
    expect(a.get("Greatsword")?.attack_bonus).toBe(5);
    expect(a.get("Greatsword")?.damage).toBe("2d6+3");
    expect(a.get("Greatsword")?.mastery).toBe("Graze");
    expect(a.get("Javelin")?.mastery).toBe("Slow");
    expect(a.get("Unarmed Strike")?.damage).toBe("4");
  });
});

describe("species and gear", () => {
  it("Dwarven Toughness adds HP", () => {
    const sheet = computeSheet(apply(fighterBuild(), svc.setSpecies, "dwarf"), catalog);
    expect(sheet.max_hp?.total).toBe(13);
    expect(sheet.darkvision).toBe(120);
    expect(sheet.resistances).toContain("poison");
  });

  it("Wood Elf speed and Drow darkvision", () => {
    const elf = apply(fighterBuild(), svc.setSpecies, "elf");
    const wood = apply(elf, svc.setChoice, "species:elf#lineage", ["wood-elf"]);
    const drow = apply(elf, svc.setChoice, "species:elf#lineage", ["drow"]);
    expect(computeSheet(wood, catalog).speed.total).toBe(35);
    expect(computeSheet(drow, catalog).darkvision).toBe(120);
    expect(computeSheet(drow, catalog).speed.total).toBe(30);
  });

  it("Chain Mail without the Strength slows you", () => {
    let build = fighterBuild();
    build = apply(build, svc.setBaseScores, {
      str: 8,
      dex: 14,
      con: 13,
      int: 15,
      wis: 10,
      cha: 12,
    });
    build = apply(build, svc.setBackgroundBonus, { dex: 2, con: 1 });
    const sheet = computeSheet(build, catalog);
    expect(sheet.speed.total).toBe(20);
    expect(sheet.warnings.some((w) => w.includes("needs Strength 13"))).toBe(true);
    const greatsword = sheet.attacks.find((a) => a.name === "Greatsword");
    expect(greatsword?.notes.some((n) => n.includes("Disadvantage"))).toBe(true);
  });

  it("studded leather archer", () => {
    let build = fighterBuild();
    build = apply(build, svc.setChoice, "class:fighter#equipment", ["b"]);
    build = apply(build, svc.setChoice, "class:fighter#fighting_style", ["archery"]);
    build = apply(build, svc.setBaseScores, {
      str: 13,
      dex: 15,
      con: 14,
      int: 8,
      wis: 12,
      cha: 10,
    });
    build = apply(build, svc.setBackgroundBonus, { dex: 2, con: 1 });
    const sheet = computeSheet(build, catalog);
    expect(sheet.armor_worn).toBe("Studded Leather Armor");
    expect(sheet.armor_class.total).toBe(12 + 3);
    const a = new Map(sheet.attacks.map((x) => [x.name, x]));
    expect(a.get("Longbow")?.attack_bonus).toBe(3 + 2 + 2); // Dex + prof + Archery
    expect(a.get("Scimitar")?.attack_bonus).toBe(5); // finesse uses Dex, no Archery
  });

  it("Alert adds proficiency to initiative", () => {
    const sheet = computeSheet(apply(fighterBuild(), svc.setBackground, "criminal"), catalog);
    expect(sheet.initiative.total).toBe(2 + 2);
    expect(sheet.initiative.parts.map((p) => p.source)).toEqual(["Dex", "Alert"]);
  });
});

it("a partial build still computes", () => {
  const sheet = computeSheet(createBuild(), catalog);
  expect(sheet.scores_complete).toBe(false);
  expect(sheet.max_hp).toBeNull();
  expect(sheet.armor_class.total).toBe(10);
});
