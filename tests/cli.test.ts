import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BuilderApp } from "../src/cli/builder";
import { Console, scriptedInput } from "../src/cli/console";
import { type CharacterBuild, parseBuild, seededRng } from "../src/index";
import { catalog, fighterBuild } from "./helpers";

async function runScript(answers: string[], build?: CharacterBuild) {
  const out: string[] = [];
  const saveDir = mkdtempSync(join(tmpdir(), "builder-"));
  const input = scriptedInput(answers, (prompt) => out.push(prompt));
  const con = new Console({ input, output: (text) => out.push(text), color: false });
  const app = new BuilderApp(con, catalog, { build, rng: seededRng(1), saveDir });
  const result = await app.run();
  return { build: result, output: out.join("\n"), saveDir };
}

it("a full session builds and saves a valid fighter", async () => {
  // biome-ignore format: one line per step
  const answers = [
    "", "1",                  // class: Fighter
    "", "3", "3", "2",        // species: Elf, Wood Elf, Wisdom
    "", "4",                  // background: Soldier
    "", "2", "suggest", "",   // abilities: point buy, class suggestion
    "1", "1", "2",            // bonus: +2 Str, +1 Con
    "", "1", "2",             // equipment: Chain Mail package, 50 GP
    "", "2", "19 16 5",       // Defense; Greatsword, Flail, Javelin
    "", "1 7", "3", "1",      // skills, Keen Senses (Survival), dice set
    "", "5 4",                // Elvish, Dwarvish
    "", "Aerin", "2",         // name, Neutral Good
    "", "y",                  // review, save
    "quit",
  ];
  const { build, output, saveDir } = await runScript(answers);
  expect(output).toContain("Your character is complete and valid");
  expect(output).toContain("AC 16→17"); // Defense preview
  expect(output).toContain("already proficient from Soldier"); // Athletics greyed out
  const saved = JSON.parse(readFileSync(join(saveDir, "aerin.json"), "utf-8"));
  expect(parseBuild(saved)).toEqual(build);
  expect(build.choices["class:fighter#weapon_mastery"]).toEqual(["greatsword", "flail", "javelin"]);
});

it("invalid input is explained and asked again", async () => {
  // biome-ignore format: one line per step
  const answers = [
    "1", "1",                         // class
    "4", "2",                         // abilities: point buy
    "str 16",                         // out of range
    "str 15", "dex 15", "con 15",     // 27 points spent
    "+wis",                           // can't afford
    "",                               // finish (no background yet, bonus skipped)
    "quit", "n",
  ];
  const { output } = await runScript(answers);
  expect(output).toContain("Point buy scores range from 8 to 15");
  expect(output).toContain("you have 0");
  expect(output).toContain("Choose a background to apply");
});

it("back returns to the menu, and an unchanged build quits without asking to save", async () => {
  const { output } = await runScript(["2", "back", "quit"], fighterBuild());
  expect(output).toContain("Farewell");
  expect(output).not.toContain("Save your character before quitting");
});

it("running out of input quits cleanly", async () => {
  const { output } = await runScript([]);
  expect(output).toContain("Farewell");
});

it("the sheet renders every section", async () => {
  const { output } = await runScript(["sheet", "quit"], fighterBuild());
  for (const heading of [
    "Combat",
    "Attacks",
    "Skills",
    "Feats",
    "Traits & Features",
    "Equipment",
  ]) {
    expect(output).toContain(heading);
  }
  expect(output).toContain("Armor Class  17   = 16 Chain Mail + 1 Defense");
});
