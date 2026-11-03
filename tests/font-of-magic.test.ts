import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyEncounterAction,
  type CharacterState,
  combatantOptions,
  computePlaySheet,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  PlayError,
} from "../src/index";
import { autocomplete, catalog, classBuild, levelUpIn } from "./helpers";

// SRD 5.2.1 Sorcerer "Font of Magic": "Converting Spell Slots to Sorcery Points. You can expend a
// spell slot to gain a number of Sorcery Points equal to the slot's level (no action required)";
// "Creating Spell Slots. As a Bonus Action, you can transform unexpended Sorcery Points into one
// spell slot … Any spell slot you create with this feature vanishes when you finish a Long Rest."

/** Sabel, a level 5 sorcerer: 5 Sorcery Points; slots 4, 3, 2. */
const sabel = () =>
  levelUpIn(autocomplete(classBuild("sorcerer", { name: "Sabel" })), "sorcerer", 4);
const CONVERT = "sorcerer:convert-spell-slot";
const CREATE = "sorcerer:create-spell-slot";

const points = (b: ReturnType<typeof sabel>, s: CharacterState) =>
  computePlaySheet(b, s, catalog).play.uses.find((u) => u.key === "sorcerer:sorcery-points");
const slots = (b: ReturnType<typeof sabel>, s: CharacterState) =>
  computePlaySheet(b, s, catalog).play.spell_slots.map((x) => [x.total, x.spent]);

describe("Font of Magic", () => {
  it("creates a spell slot for its cost in Sorcery Points; it vanishes on a Long Rest", () => {
    const b = sabel();
    let s = createState(b, catalog);
    const created = applyAction(b, s, catalog, { type: "use_feature", key: CREATE, level: 2 });
    s = created.state;
    expect(created.notes).toContain(
      "Font of Magic: Create Spell Slot: 3 Sorcery Points become a level 2 spell slot.",
    );
    expect(points(b, s)?.spent).toBe(3);
    expect(slots(b, s)).toEqual([
      [4, 0],
      [4, 0],
      [2, 0],
    ]);
    // A level 4 slot needs Sorcerer level 7; level 6 is beyond the table.
    expect(() =>
      applyAction(b, s, catalog, { type: "use_feature", key: CREATE, level: 4 }),
    ).toThrow("Font of Magic: Create Spell Slot can't create a level 4 spell slot yet");
    expect(() =>
      applyAction(b, s, catalog, { type: "use_feature", key: CREATE, level: 6 }),
    ).toThrow("Font of Magic: Create Spell Slot makes spell slots up to level 5");
    // 2 points left: not enough for another level 2 slot.
    expect(() =>
      applyAction(b, s, catalog, { type: "use_feature", key: CREATE, level: 2 }),
    ).toThrow(PlayError);
    s = applyAction(b, s, catalog, { type: "long_rest" }).state;
    expect(slots(b, s)).toEqual([
      [4, 0],
      [3, 0],
      [2, 0],
    ]);
    expect(s.spell_slots_created).toEqual([]);
  });

  it("converts a spell slot into Sorcery Points, never above the maximum", () => {
    const b = sabel();
    let s = createState(b, catalog);
    s = applyAction(b, s, catalog, { type: "use_feature", key: CREATE, level: 3 }).state; // 5 points
    const r = applyAction(b, s, catalog, { type: "use_feature", key: CONVERT, level: 2 });
    expect(points(b, r.state)?.spent).toBe(3);
    expect(slots(b, r.state)[1]).toEqual([3, 1]);
    // Full: a level 3 slot over 3 spent points gains 3; a level 1 slot on a full pool gains nothing.
    const full = applyAction(b, createState(b, catalog), catalog, {
      type: "use_feature",
      key: CONVERT,
      level: 1,
    });
    expect(full.notes).toContain(
      "Font of Magic: Convert Spell Slot: a level 1 spell slot becomes 0 Sorcery Points (1 over the maximum lost).",
    );
  });

  it("in a fight: creating a slot takes the Bonus Action; converting takes no action, on any turn", () => {
    const b = sabel();
    let state = createState(b, catalog);
    let e: Encounter = createEncounter();
    const act = (...actions: EncounterAction[]) => {
      for (const action of actions) {
        const r = applyEncounterAction(e, action, {
          catalog,
          characters: { sabel: { build: b, state } },
        });
        e = r.encounter;
        state = r.states.sabel ?? state;
      }
    };
    act(
      { type: "add_character", character: "sabel" },
      { type: "add_monster", monster: "goblin-warrior", side: "enemies" },
      { type: "set_initiative", id: "sabel", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 10 },
      { type: "start" },
    );
    const options = combatantOptions(e, "sabel", {
      catalog,
      characters: { sabel: { build: b, state } },
    });
    expect(
      options.features
        .filter((f) => f.label.startsWith("Font of Magic: Create"))
        .map((f) => [f.label, f.available]),
    ).toEqual([
      ["Font of Magic: Create Spell Slot (level 1)", true],
      ["Font of Magic: Create Spell Slot (level 2)", true],
      ["Font of Magic: Create Spell Slot (level 3)", true],
      ["Font of Magic: Create Spell Slot (level 4)", false],
      ["Font of Magic: Create Spell Slot (level 5)", false],
    ]);
    act({ type: "feature", id: "sabel", feature: CREATE, level: 1 });
    expect(e.combatants.find((c) => c.id === "sabel")?.used.bonus_action).toBe(true);
    act({ type: "next_turn" }, { type: "feature", id: "sabel", feature: CONVERT, level: 1 });
    expect(points(b, state)?.spent).toBe(1);
  });
});
