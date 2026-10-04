import { expect, it } from "vitest";
import { runDemo } from "../examples/battle-demo";

// examples/battle-demo.ts (`npm run demo`): a seeded battle that shows the engine's main
// features. The checks below name what the demo is meant to show; the snapshot keeps the whole
// story, so a change in the engine that alters it is seen and reviewed.

it("the demo battle shows the engine's main features, the same way on every run", () => {
  const lines = runDemo();
  const text = lines.join("\n");
  // Building: a refused choice with its reason, numbers that explain themselves.
  expect(text).toContain('Fighter skill "Athletics": already proficient from Soldier');
  expect(text).toContain("AC 17 = 16 Chain Mail + 1 Defense");
  // The battle: reach checked on the grid, Opportunity Attacks, areas choosing their targets,
  // a decision asked after the roll, a class feature, Weapon Mastery, the outcome.
  expect(text).toContain("out of Greatsword's reach (5 ft)");
  expect(text).toContain("can make an Opportunity Attack");
  expect(text).toMatch(/Fireball's Sphere covers .*Goblin Warrior 2, Goblin Warrior 3/);
  expect(text).toContain("Fire Breath's Cone covers Brakka");
  expect(text).toContain("Add the Bardic Inspiration die (d8)? → yes");
  expect(text).toContain("Brakka uses Action Surge.");
  expect(text).toContain("Graze: Red Dragon Wyrmling takes 3 slashing damage.");
  expect(text).toContain("The wyrmling falls. The party wins.");
  expect(text).toMatchSnapshot();
  expect(runDemo()).toEqual(lines);
});
