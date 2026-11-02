import { describe, expect, it } from "vitest";
import {
  countDown,
  effectEnding,
  type SweepCombatant,
  type SweepEffect,
  sweepOutcome,
} from "../src/services/lifetimes";

// When things in an encounter end, as pure functions of plain facts (`services/lifetimes.ts`).

const ends = (at: "start" | "end", of: string, count = 1, skip_current = false) => ({
  at,
  of,
  count,
  skip_current,
});

describe("countDown", () => {
  it("counts down only what ends at this point of this creature's turn", () => {
    const items = [
      { id: "a", ends: ends("start", "ilse", 2) },
      { id: "b", ends: ends("start", "ilse") },
      { id: "c", ends: ends("end", "ilse") },
      { id: "d", ends: ends("start", "goblin") },
      { id: "e", ends: null },
    ];
    const r = countDown(items, "start", "ilse");
    expect(r.expired.map((x) => x.id)).toEqual(["b"]);
    expect(r.items.map((x) => x.ends?.count)).toEqual([1, 0, 1, 1, undefined]);
    expect(items[0]?.ends?.count).toBe(2); // the input is left as it was
  });

  it('an effect made this turn skips its first count ("until the end of your next turn")', () => {
    const once = countDown([{ ends: ends("end", "ilse", 1, true) }], "end", "ilse");
    expect(once.expired).toEqual([]);
    expect(once.items[0]?.ends).toEqual(ends("end", "ilse", 1, false));
    expect(countDown(once.items, "end", "ilse").expired).toHaveLength(1);
  });
});

const creature = (id: string, extra: Partial<SweepCombatant> = {}): SweepCombatant => ({
  id,
  hidden: false,
  hidden_effect: false,
  holding: null,
  concentration: null,
  conditions: new Set(),
  out: false,
  ...extra,
});
const effect = (extra: Partial<SweepEffect>): SweepEffect => ({
  id: "effect-1",
  target: "goblin",
  source: "ilse",
  condition: "restrained",
  label: "Web",
  concentration: false,
  ends_on: [],
  ...extra,
});

describe("sweepOutcome", () => {
  it("unhides, dissipates held spells, keeps what still holds", () => {
    const outcome = sweepOutcome({
      combatants: [
        creature("pip", { hidden: true, hidden_effect: false }),
        creature("ilse", { holding: "Hold Person", concentration: null }),
        creature("wren", { holding: "Web", concentration: "Web" }),
      ],
      masteries: [
        { by: "pip", on: "ilse" },
        { by: "pip", on: "gone" },
      ],
      marks: [
        { by: "ilse", on: "pip", kind: "advantage_against", label: "Guiding Bolt" },
        { by: "wren", on: "pip", kind: "quarry", label: "Hunter's Mark" },
        { by: "wren", on: "pip", kind: "quarry", label: "Web" },
      ],
      zones: [
        { id: "z1", by: "wren", label: "Web", concentration: true },
        { id: "z2", by: "ilse", label: "Moonbeam", concentration: true },
        { id: "z3", by: "gone", label: "Moonbeam", concentration: true },
        { id: "z4", by: "gone", label: "Grease", concentration: false },
      ],
    });
    expect(outcome.combatants).toEqual([
      { id: "pip", unhide: true, dissipates: null },
      { id: "ilse", unhide: false, dissipates: "Hold Person" },
      { id: "wren", unhide: false, dissipates: null },
    ]);
    expect(outcome.masteries).toEqual([0]);
    expect(outcome.marks).toEqual([0, 2]); // Hunter's Mark needs Wren's Concentration on it
    expect(outcome.zones).toEqual([
      { id: "z2", reason: { why: "concentration_ended" } },
      { id: "z3", reason: { why: "caster_left" } },
    ]);
  });
});

describe("effectEnding", () => {
  const restrained = creature("goblin", { conditions: new Set(["restrained"]) });
  it("lasts while its target, source and Concentration do", () => {
    const web = effect({ concentration: true });
    expect(effectEnding(web, restrained, creature("ilse", { concentration: "Web" }))).toBeNull();
    expect(effectEnding(web, restrained, creature("ilse"))).toEqual({
      why: "concentration_ended",
    });
    expect(effectEnding(web, undefined, creature("ilse"))).toEqual({ why: "target_left" });
    expect(effectEnding(web, restrained, undefined)).toEqual({ why: "source_left" });
    expect(effectEnding(web, creature("goblin"), creature("ilse"))).toEqual({ why: "forget" });
  });

  it('a grapple ends when the grappler is Incapacitated (SRD "Grappling")', () => {
    const grapple = effect({ condition: "grappled", label: "Grappled" });
    const target = creature("goblin", { conditions: new Set(["grappled"]) });
    expect(effectEnding(grapple, target, creature("ilse"))).toBeNull();
    expect(
      effectEnding(grapple, target, creature("ilse", { conditions: new Set(["incapacitated"]) })),
    ).toEqual({ why: "source_incapacitated", name: "ilse" });
  });

  it("an effect that ends when its source is Incapacitated also ends when it's out of the fight", () => {
    const turned = effect({ condition: "frightened", ends_on: ["source_incapacitated"] });
    const target = creature("goblin", { conditions: new Set(["frightened"]) });
    expect(effectEnding(turned, target, creature("ilse", { out: true }))).toEqual({
      why: "source_incapacitated",
      name: "ilse",
    });
  });
});
