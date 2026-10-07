import { describe, expect, it } from "vitest";
import {
  applyEncounterAction,
  type CharacterBuild,
  type CharacterState,
  combatantPassivePerception,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  previewMove,
  scriptedRng,
} from "../src/index";
import { catalog, fighterBuild } from "./helpers";

// Outside a fight: SRD 5.2.1 "Exploration" (Travel Pace: Fast gives Disadvantage on Wisdom
// (Perception) checks, Slow Advantage), Rules Glossary "Passive Perception" (±5 for Advantage or
// Disadvantage), "Search" and "Finding Hidden Objects".

const builds: Record<string, CharacterBuild> = {
  brakka: fighterBuild(),
  aerin: fighterBuild({ name: "Aerin" }),
};

/** Two characters on the grid, no fight started. */
function exploring(...setup: EncounterAction[]) {
  const states: Record<string, CharacterState> = Object.fromEntries(
    Object.entries(builds).map(([k, b]) => [k, createState(b, catalog)]),
  );
  const characters = () =>
    Object.fromEntries(
      Object.entries(builds).map(([k, build]) => [
        k,
        { build, state: states[k] as CharacterState },
      ]),
    );
  let encounter: Encounter = createEncounter();
  const notes: string[] = [];
  const act = (rolls: number[], ...actions: EncounterAction[]) => {
    for (const action of actions) {
      const r = applyEncounterAction(encounter, action, {
        catalog,
        characters: characters(),
        rng: scriptedRng(rolls),
      });
      encounter = r.encounter;
      notes.push(...r.notes);
    }
  };
  act(
    [],
    { type: "add_character", character: "brakka" },
    { type: "add_character", character: "aerin" },
    { type: "place", id: "brakka", x: 0, y: 0 },
    { type: "place", id: "aerin", x: 0, y: 4 },
    ...setup,
  );
  return {
    act,
    notes,
    get e() {
      return encounter;
    },
    ctx: () => ({ catalog, characters: characters() }),
    at: (id: string) => encounter.combatants.find((c) => c.id === id)?.position,
  };
}

describe("exploring: moves without a limit", () => {
  it("a character moves farther than its Speed, and the engine says how many turns it takes", () => {
    const s = exploring();
    const preview = previewMove(s.e, { id: "brakka", to: { x: 15, y: 0 } }, s.ctx());
    expect(preview).toMatchObject({ ok: true, cost: 75, turns: 3, opportunity_attacks: [] });
    s.act([], { type: "move", id: "brakka", to: { x: 15, y: 0 } });
    expect(s.at("brakka")).toEqual({ x: 15, y: 0 });
    expect(s.notes.at(-1)).toBe(
      "Brakka moves 75 feet: 3 turns at a Speed of 30 feet (about 18 seconds).",
    );
    // Again: nothing was spent.
    s.act([], { type: "move", id: "brakka", to: { x: 30, y: 0 } });
    expect(s.at("brakka")).toEqual({ x: 30, y: 0 });
  });

  it("in a fight, the preview gives no turns", () => {
    const s = exploring(
      { type: "set_initiative", id: "brakka", value: 10 },
      { type: "set_initiative", id: "aerin", value: 5 },
      { type: "start" },
    );
    const preview = previewMove(s.e, { id: "brakka", to: { x: 15, y: 0 } }, s.ctx());
    expect(preview).toMatchObject({ ok: false, turns: null });
  });
});

describe("points of interest", () => {
  const passive = () => {
    const s = exploring();
    return combatantPassivePerception(s.e, s.ctx(), "brakka");
  };

  it("start hidden; the log doesn't give the title away", () => {
    const s = exploring({ type: "add_point", at: { x: 40, y: 40 }, title: "Loose flagstone" });
    expect(s.e.points[0]).toMatchObject({
      id: "poi1",
      revealed: false,
      kind: "detail",
      within: 30,
    });
    expect(s.notes.join(" ")).not.toMatch(/flagstone/);
  });

  it("a character notices one in range and in sight with Passive Perception ≥ DC, and stops there", () => {
    const dc = passive();
    const s = exploring({
      type: "add_point",
      at: { x: 14, y: 0 },
      title: "Tripwire",
      kind: "trap",
      dc,
      within: 15,
    });
    s.act([], { type: "move", id: "brakka", to: { x: 20, y: 0 } });
    // 15 feet from the tripwire: at 11,0.
    expect(s.at("brakka")).toEqual({ x: 11, y: 0 });
    expect(s.e.points[0]?.noticed_by).toEqual(["brakka"]);
    expect(s.notes).toContain("Brakka notices something.");
    expect(s.notes).toContain("Brakka stops at 11,0.");
    // Already noticed: it goes on.
    s.act([], { type: "move", id: "brakka", to: { x: 20, y: 0 } });
    expect(s.at("brakka")).toEqual({ x: 20, y: 0 });
  });

  it("isn't noticed past a wall, nor with a DC above Passive Perception", () => {
    const dc = passive();
    const s = exploring(
      { type: "add_wall", from: { x: 3, y: -5 }, to: { x: 3, y: 5 } },
      { type: "add_point", at: { x: 4, y: 0 }, title: "Behind the wall", dc },
      { type: "add_point", at: { x: 0, y: 2 }, title: "Too hard", dc: dc + 1 },
    );
    expect(s.e.points.map((p) => p.noticed_by)).toEqual([[], []]);
  });

  it("the travel pace changes Passive Perception: Fast −5, Slow +5", () => {
    const base = passive();
    const s = exploring({ type: "set_exploration", pace: "fast" });
    expect(combatantPassivePerception(s.e, s.ctx(), "brakka")).toBe(base - 5);
    s.act([], { type: "set_exploration", pace: "slow" });
    expect(combatantPassivePerception(s.e, s.ctx(), "brakka")).toBe(base + 5);
    // Slow: a point at DC +5 nearby is noticed as soon as it's there.
    s.act([], { type: "add_point", at: { x: 1, y: 0 }, title: "Glint", dc: base + 5, within: 5 });
    expect(s.e.points[0]?.noticed_by).toEqual(["brakka"]);
  });

  it("with notice_stops: everyone, every move waits until the GM reveals it or resumes", () => {
    const s = exploring(
      { type: "set_exploration", notice_stops: "everyone" },
      { type: "add_point", at: { x: 14, y: 0 }, title: "Tripwire", dc: passive(), within: 15 },
    );
    s.act([], { type: "move", id: "brakka", to: { x: 20, y: 0 } });
    expect(s.e.halted).toBe("poi1");
    expect(() => s.act([], { type: "move", id: "aerin", to: { x: 5, y: 4 } })).toThrow(
      "Everyone waits: Brakka noticed something",
    );
    s.act([], { type: "update_point", id: "poi1", revealed: true });
    expect(s.e.halted).toBeNull();
    expect(s.notes).toContain("Tripwire is revealed.");
    s.act([], { type: "move", id: "aerin", to: { x: 5, y: 4 } });
    expect(s.at("aerin")).toEqual({ x: 5, y: 4 });
    expect(() => s.act([], { type: "resume" })).toThrow("Nobody is waiting");
  });

  it("Search: a Perception check (no action outside a fight) finds hidden points in range", () => {
    const s = exploring({
      type: "add_point",
      at: { x: 3, y: 0 },
      title: "Secret door",
      kind: "door",
      dc: 99,
      within: 15,
    });
    s.act([5], { type: "search", id: "brakka", dc: 15 });
    expect(s.e.points[0]?.noticed_by).toEqual([]);
    // Above Passive Perception, so only the check can find it.
    s.act([], { type: "update_point", id: "poi1", dc: passive() + 1 });
    s.act([20], { type: "search", id: "brakka" });
    expect(s.e.points[0]?.noticed_by).toEqual(["brakka"]);
    expect(s.notes).toContain("Brakka finds something.");
    expect(s.notes.join(" ")).not.toMatch(/Secret door/);
  });

  it("hiding a revealed point again forgets who noticed it; removing it ends a halt", () => {
    const s = exploring(
      { type: "set_exploration", notice_stops: "everyone" },
      { type: "add_point", at: { x: 1, y: 0 }, title: "Glint", dc: 0, within: 5, revealed: true },
    );
    s.act([], { type: "update_point", id: "poi1", revealed: false });
    // Hidden again with a DC of 0: Brakka, next to it, notices it at once, and everyone waits.
    expect(s.e.points[0]?.noticed_by).toEqual(["brakka"]);
    expect(s.e.halted).toBe("poi1");
    s.act([], { type: "remove_point", id: "poi1" });
    expect(s.e.halted).toBeNull();
    expect(s.e.points).toEqual([]);
  });
});
