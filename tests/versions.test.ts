import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyEncounterAction,
  createBuild,
  createEncounter,
  createHistory,
  createState,
  DOCUMENT_VERSION,
  type EncounterAction,
  EncounterHistorySchema,
  type EncounterSettingsInput,
  legacyEncounterSettings,
  parseBuild,
  parseEncounter,
  parseState,
  recordAction,
  replayHistory,
  scriptedRng,
} from "../src/index";
import { catalog, fighterBuild } from "./helpers";

// Saved documents carry a format version: missing means 1, older ones are migrated (and come out
// as the current version), newer than this engine is refused.

describe("document versions", () => {
  it("new documents are written with the current version", () => {
    expect(DOCUMENT_VERSION).toBe(2);
    expect(createBuild().version).toBe(2);
    expect(createState(fighterBuild(), catalog).version).toBe(2);
    expect(createEncounter().version).toBe(2);
  });

  it("a document without a version is version 1, migrated to the current one", () => {
    const python = JSON.parse(
      readFileSync(join(import.meta.dirname, "fixtures/python-builder-save.json"), "utf-8"),
    );
    expect(python.version).toBeUndefined();
    expect(parseBuild(python).version).toBe(2);
    expect(parseState({}).version).toBe(2);
    expect(parseEncounter({}).version).toBe(2);
  });

  it("a document from a newer engine is refused with a clear message", () => {
    const newer = { version: DOCUMENT_VERSION + 1 };
    for (const parse of [parseBuild, parseState, parseEncounter]) {
      expect(() => parse(newer)).toThrow(/saved by a newer srd-rules-engine/);
    }
  });
});

describe("format 2: an encounter's table settings come with each call", () => {
  it("a version 1 encounter loads; its settings can be read out for the table to keep", () => {
    const old = {
      version: 1,
      decisions: "ask",
      auto_death_saves: false,
      positions: "required",
      notice_stops: "everyone",
      halted: "poi1",
      combatants: [{ id: "goblin-warrior", name: "Goblin Warrior", decisions: "auto" }],
    };
    const e = parseEncounter(old);
    expect(e.version).toBe(2);
    for (const gone of ["decisions", "auto_death_saves", "positions", "notice_stops", "halted"]) {
      expect(e).not.toHaveProperty(gone);
    }
    expect(e.combatants[0]).not.toHaveProperty("decisions");
    expect(legacyEncounterSettings(old)).toEqual({
      decisions: "ask",
      decisions_by: { "goblin-warrior": "auto" },
      auto_death_saves: false,
      positions: "required",
    });
    expect(legacyEncounterSettings({})).toEqual({
      decisions: "auto",
      decisions_by: {},
      auto_death_saves: true,
      positions: "optional",
    });
  });

  it("a version 1 history migrates: its settings move onto the steps, and it replays the same", () => {
    // A fight with a decision, recorded in format 2: the dragon's Legendary Resistance is asked.
    const fireball: EncounterAction = {
      type: "cast",
      id: "mage",
      spell: "fireball",
      targets: ["adult-blue-dragon"],
    };
    const plan: { action: EncounterAction; rolls: number[]; settings: EncounterSettingsInput }[] = [
      { action: { type: "add_monster", monster: "mage" }, rolls: [], settings: {} },
      {
        action: { type: "add_monster", monster: "adult-blue-dragon" },
        rolls: [],
        settings: { decisions_by: { "adult-blue-dragon": "ask" } },
      },
    ];
    const asked = {
      decisions_by: { "adult-blue-dragon": "ask" as const },
      positions: "required" as const,
    };
    for (const [action, rolls] of [
      [{ type: "set_initiative", id: "mage", value: 20 }, []],
      [{ type: "set_initiative", id: "adult-blue-dragon", value: 10 }, []],
      [{ type: "start" }, []],
      [fireball, [1]],
      [{ type: "decide", use: false }, Array<number>(20).fill(2)],
    ] as [EncounterAction, number[]][]) {
      plan.push({ action, rolls, settings: asked });
    }
    let encounter = createEncounter();
    let history = createHistory(encounter);
    for (const step of plan) {
      const r = applyEncounterAction(encounter, step.action, {
        catalog,
        rng: scriptedRng(step.rolls),
        settings: step.settings,
      });
      encounter = r.encounter;
      history = recordAction(history, step.action, r, step.settings);
    }
    expect(encounter.pending).toBeNull();
    expect(encounter.combatants.find((c) => c.id === "adult-blue-dragon")?.hp).toBeLessThan(212);

    // The same history as format 1 stored it: settings in the encounter and in actions.
    const v1 = {
      version: 1,
      start: { encounter: { version: 1, decisions: "auto" }, states: {} },
      steps: [
        { action: { type: "add_monster", monster: "mage" }, rolls: [] },
        {
          action: { type: "add_monster", monster: "adult-blue-dragon", decisions: "ask" },
          rolls: [],
        },
        { action: { type: "set_positions", mode: "required" }, rolls: [] },
        { action: { type: "set_exploration", notice_stops: "everyone" }, rolls: [] },
        { action: { type: "resume" }, rolls: [] },
        // The dice each step drew, as recorded.
        ...history.steps.slice(2).map(({ action, rolls }) => ({ action, rolls })),
      ],
    };
    const migrated = EncounterHistorySchema.parse(v1);
    expect(migrated.version).toBe(2);
    expect(migrated.steps.map((s) => s.action)).toEqual(history.steps.map((s) => s.action));
    expect(migrated.steps.map((s) => s.settings)).toEqual(history.steps.map((s) => s.settings));
    // A replay with the context's settings left out uses the ones each step recorded.
    expect(replayHistory(migrated, { catalog }).encounter).toEqual(
      replayHistory(history, { catalog }).encounter,
    );
    expect(replayHistory(migrated, { catalog }).encounter).toEqual(encounter);
  });
});
