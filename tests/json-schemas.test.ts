import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyEncounterAction,
  type CharacterState,
  combatantOptions,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  scriptedRng,
  TABLE_NAMES,
} from "../src/index";
import { autocomplete, catalog, classBuild, fighterBuild, levelUpIn } from "./helpers";

// The generated JSON Schemas (`schemas/`) accept the documents the engine writes and refuse
// broken ones, checked with a validator that knows nothing about Zod.

const dir = join(import.meta.dirname, "..", "schemas");
const ajv = new Ajv2020({ allErrors: true, strict: false });
const load = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf-8"));
const validator = (name: string) => ajv.compile(load(name));
/** The document as it would be saved: plain JSON. */
const json = (x: unknown) => JSON.parse(JSON.stringify(x));
const errors = (name: string, doc: unknown) => {
  const validate = validator(name);
  return validate(json(doc)) ? [] : (validate.errors ?? []);
};

describe("JSON Schemas", () => {
  it("every schema compiles", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".schema.json"));
    expect(files).toEqual(
      expect.arrayContaining([
        "state.schema.json",
        "encounter.schema.json",
        "play-action.schema.json",
        "encounter-action.schema.json",
      ]),
    );
    for (const f of files) expect(() => validator(f), f).not.toThrow();
  });

  it("the bundled SRD matches its content schemas", () => {
    const srd = JSON.parse(
      readFileSync(join(import.meta.dirname, "../src/content/data/srd-5.2.1.json"), "utf-8"),
    );
    for (const table of TABLE_NAMES) {
      const validate = validator(`${table}.schema.json`);
      const entities = Object.values(srd[table] ?? {});
      expect(entities.length, table).toBeGreaterThan(0);
      expect(validate(entities), `${table}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });

  it("builds match build.schema.json", () => {
    const python = JSON.parse(
      readFileSync(join(import.meta.dirname, "fixtures/python-builder-save.json"), "utf-8"),
    );
    for (const build of [
      fighterBuild(),
      levelUpIn(autocomplete(classBuild("wizard")), "wizard", 4),
      python,
    ]) {
      expect(errors("build.schema.json", build)).toEqual([]);
    }
  });

  it("play states match state.schema.json, before and after play", () => {
    const build = levelUpIn(autocomplete(classBuild("wizard")), "wizard", 4);
    let state: CharacterState = createState(build, catalog);
    expect(errors("state.schema.json", state)).toEqual([]);
    for (const action of [
      { type: "damage", amount: 7 },
      { type: "add_condition", condition: "poisoned" },
      { type: "spend_slot", level: 2 },
      { type: "set_concentration", spell: "Web" },
      { type: "set_temp_hp", amount: 5 },
    ] as const) {
      expect(errors("play-action.schema.json", action), action.type).toEqual([]);
      state = applyAction(build, state, catalog, action).state;
    }
    expect(errors("state.schema.json", state)).toEqual([]);
    expect(errors("state.schema.json", { ...json(state), hp: "full" })).not.toEqual([]);
  });

  it("encounters match encounter.schema.json: zones, effects, marks and a pending decision", () => {
    let e: Encounter = createEncounter();
    const act = (rolls: number[], ...actions: EncounterAction[]) => {
      for (const action of actions) {
        expect(errors("encounter-action.schema.json", action), action.type).toEqual([]);
        e = applyEncounterAction(e, action, { catalog, rng: scriptedRng(rolls) }).encounter;
      }
    };
    act(
      [],
      { type: "add_monster", monster: "druid", side: "party" },
      { type: "add_monster", monster: "ogre", side: "enemies" },
      { type: "add_monster", monster: "adult-blue-dragon", side: "enemies", decisions: "ask" },
      { type: "set_initiative", id: "druid", value: 20 },
      { type: "set_initiative", id: "ogre", value: 10 },
      { type: "set_initiative", id: "adult-blue-dragon", value: 5 },
      { type: "start" },
      { type: "place", id: "druid", x: 0, y: 0 },
      { type: "place", id: "ogre", x: 5, y: 0 },
      { type: "place", id: "adult-blue-dragon", x: 10, y: 0 },
    );
    act([2, 5, 5], {
      type: "cast",
      id: "druid",
      spell: "moonbeam",
      area: { point: { x: 6, y: 0 } },
    });
    act([1], { type: "move_zone", zone: "zone-1", point: { x: 11, y: 0 } });
    expect(e.zones).toHaveLength(1);
    expect(e.pending).not.toBeNull(); // the dragon's Legendary Resistance
    expect(errors("encounter.schema.json", e)).toEqual([]);
    expect(errors("encounter.schema.json", { ...json(e), round: -1 })).not.toEqual([]);
    expect(errors("encounter-action.schema.json", { type: "teleport", id: "ogre" })).not.toEqual(
      [],
    );
  });
});

describe("options.schema.json", () => {
  it("accepts what combatantOptions returns", () => {
    const build = fighterBuild();
    const characters = { brakka: { build, state: createState(build, catalog) } };
    let encounter: Encounter = createEncounter();
    for (const action of [
      { type: "add_character", character: "brakka" },
      { type: "add_monster", monster: "adult-red-dragon", side: "enemies" },
      { type: "set_initiative", id: "brakka", value: 20 },
      { type: "set_initiative", id: "adult-red-dragon", value: 10 },
      { type: "start" },
    ] as EncounterAction[]) {
      encounter = applyEncounterAction(encounter, action, { catalog, characters }).encounter;
    }
    for (const id of ["brakka", "adult-red-dragon"]) {
      const options = combatantOptions(encounter, id, { catalog, characters });
      expect(errors("options.schema.json", options)).toEqual([]);
    }
    expect(errors("options.schema.json", { id: "x" }).length).toBeGreaterThan(0);
  });
});
