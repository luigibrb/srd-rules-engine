import { describe, expect, it } from "vitest";
import {
  applyEncounterAction,
  type CharacterBuild,
  type CharacterState,
  computePlaySheet,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  type SpellCastResult,
  scriptedRng,
} from "../src/index";
import * as svc from "../src/services/builder";
import { autocomplete, catalog, classBuild, levelUpIn } from "./helpers";

// SRD 5.2.1 Sorcerer "Metamagic Options", and "One Spell with a Spell Slot per Turn".

/** Sabel, a level 5 sorcerer (Charisma +2, 5 Sorcery Points) with two Metamagic options. */
function sabel(options: [string, string]): CharacterBuild {
  let b = levelUpIn(autocomplete(classBuild("sorcerer", { name: "Sabel" })), "sorcerer", 4);
  const set = (key: string, values: string[]) => {
    b = svc.setChoice(b, catalog, key, values).build;
  };
  set(
    "class:sorcerer:2#metamagic",
    options.map((o) => `${o}-spell`),
  );
  set("class:sorcerer#prepared", ["burning-hands", "shield"]);
  set("class:sorcerer:2#prepared", ["magic-missile", "chromatic-orb"]);
  set("class:sorcerer:3#prepared", ["hold-person", "blur"]);
  return autocomplete(b);
}

function session(build: CharacterBuild, goblins = 2) {
  let state: CharacterState = createState(build, catalog);
  let e: Encounter = createEncounter();
  let last: ReturnType<typeof applyEncounterAction> | null = null;
  const notes: string[] = [];
  const act = (rolls: number[], ...actions: EncounterAction[]) => {
    for (const action of actions) {
      last = applyEncounterAction(e, action, {
        catalog,
        characters: { sabel: { build, state } },
        rng: scriptedRng(rolls),
      });
      e = last.encounter;
      state = last.states.sabel ?? state;
      notes.push(...last.notes);
    }
  };
  const ids = Array.from({ length: goblins }, (_, i) =>
    i === 0 ? "goblin-warrior" : `goblin-warrior-${i + 1}`,
  );
  act(
    [],
    { type: "add_character", character: "sabel" },
    ...ids.map(
      () => ({ type: "add_monster", monster: "goblin-warrior", side: "enemies" }) as const,
    ),
    { type: "set_initiative", id: "sabel", value: 20 },
    ...ids.map((id, i) => ({ type: "set_initiative", id, value: 10 - i }) as const),
    { type: "start" },
  );
  const points = () =>
    computePlaySheet(build, state, catalog).play.uses.find((u) => u.key.endsWith(":sorcery-points"))
      ?.spent;
  return {
    act,
    notes,
    points,
    get: (id: string) => e.combatants.find((c) => c.id === id),
    result: () => last?.result as SpellCastResult,
    encounter: () => e,
  };
}

const cast = (spell: string, extra: Partial<Extract<EncounterAction, { type: "cast" }>> = {}) =>
  ({ type: "cast", id: "sabel", spell, ...extra }) as EncounterAction;

describe("One Spell with a Spell Slot per Turn", () => {
  it("a second slot on the same turn is refused, a cantrip isn't; a new turn allows it", () => {
    const s = session(sabel(["careful", "distant"]));
    s.act([1, 1, 1], cast("magic-missile", { targets: ["goblin-warrior"] }));
    expect(() => s.act([], cast("shield"))).toThrow(
      "Sabel has already used a spell slot to cast a spell this turn",
    );
    s.act([], { type: "next_turn" }); // the goblin's turn: Shield as a reaction is fine
    s.act([], cast("shield"));
    expect(s.get("sabel")?.used.reaction).toBe(true);
  });
});

describe("Metamagic", () => {
  it("Careful Spell: a chosen creature succeeds automatically and takes no damage", () => {
    const s = session(sabel(["careful", "distant"]));
    const targets = ["goblin-warrior", "goblin-warrior-2"];
    // Burning Hands: one Dexterity save (the other goblin's: 2), then 3d6 (4, 4, 4).
    s.act(
      [2, 4, 4, 4],
      cast("burning-hands", {
        targets,
        metamagic: { option: "careful", targets: ["goblin-warrior"] },
      }),
    );
    const r = s.result();
    expect(r.targets[0]?.save).toMatchObject({ success: true, automatic_success: "Careful Spell" });
    expect(r.targets[0]?.instances).toEqual([]);
    expect(r.targets[1]?.save?.success).toBe(false);
    expect(s.notes).toContain("Sabel uses Careful Spell (1 Sorcery Point).");
    expect(s.points()).toBe(1);
  });

  it("refused without the option, beyond Charisma's count, or on a spell without a save", () => {
    const s = session(sabel(["careful", "distant"]));
    expect(() =>
      s.act(
        [],
        cast("hold-person", { targets: ["goblin-warrior"], metamagic: { option: "twinned" } }),
      ),
    ).toThrow("Sabel doesn't have Twinned Spell");
    expect(() =>
      s.act(
        [],
        cast("magic-missile", {
          targets: ["goblin-warrior"],
          metamagic: { option: "careful", targets: ["goblin-warrior"] },
        }),
      ),
    ).toThrow("Careful Spell can't change Magic Missile: it forces no saving throw");
    expect(() =>
      s.act(
        [],
        cast("burning-hands", {
          targets: ["goblin-warrior"],
          metamagic: { option: "careful", targets: [] },
        }),
      ),
    ).toThrow("Careful Spell: choose up to 2 creatures (`targets`)");
  });

  it("Twinned Spell: Hold Person at level 2 holds two creatures", () => {
    const s = session(sabel(["twinned", "heightened"]));
    const targets = ["goblin-warrior", "goblin-warrior-2"];
    expect(() => s.act([1, 1], cast("hold-person", { targets }))).toThrow(/Hold Person/);
    s.act([1, 1], cast("hold-person", { targets, metamagic: { option: "twinned" } }));
    expect(s.get("goblin-warrior")?.conditions).toContain("paralyzed");
    expect(s.get("goblin-warrior-2")?.conditions).toContain("paralyzed");
  });

  it("Heightened Spell: one target saves with Disadvantage", () => {
    const s = session(sabel(["twinned", "heightened"]));
    s.act(
      [18, 3],
      cast("hold-person", {
        targets: ["goblin-warrior"],
        metamagic: { option: "heightened", targets: ["goblin-warrior"] },
      }),
    );
    expect(s.result().targets[0]?.save).toMatchObject({
      success: false,
      roll: { mode: "disadvantage" },
    });
    expect(s.points()).toBe(2);
  });

  it("Quickened Spell: a Bonus Action, then no other level 1+ spell this turn", () => {
    const s = session(sabel(["quickened", "transmuted"]));
    s.act(
      [1, 1, 1],
      cast("magic-missile", { targets: ["goblin-warrior"], metamagic: { option: "quickened" } }),
    );
    expect(s.get("sabel")?.used).toMatchObject({ action: false, bonus_action: true });
    expect(() => s.act([], cast("burning-hands", { targets: ["goblin-warrior"] }))).toThrow(
      "Sabel has already used Quickened Spell this turn: no other level 1+ spell",
    );
    s.act([15, 3, 3], cast("fire-bolt", { targets: ["goblin-warrior"] })); // a cantrip is fine
  });

  it("Transmuted Spell: Fire Bolt's damage becomes Cold", () => {
    const s = session(sabel(["quickened", "transmuted"]));
    s.act(
      [18, 5, 5],
      cast("fire-bolt", {
        targets: ["goblin-warrior"],
        metamagic: { option: "transmuted", damage_type: "cold" },
      }),
    );
    expect(s.result().targets[0]?.instances.map((i) => i.type)).toEqual(["cold"]);
    expect(() =>
      s.act(
        [],
        cast("magic-missile", {
          targets: ["goblin-warrior"],
          metamagic: { option: "transmuted", damage_type: "fire" },
        }),
      ),
    ).toThrow(
      "Transmuted Spell can't change Magic Missile: it deals none of the listed damage types",
    );
  });

  it("Distant Spell: Fire Bolt reaches 240 feet", () => {
    const s = session(sabel(["careful", "distant"]), 1);
    s.act(
      [],
      { type: "place", id: "sabel", x: 0, y: 0 },
      { type: "place", id: "goblin-warrior", x: 30, y: 0 },
    );
    expect(() => s.act([15, 3, 3], cast("fire-bolt", { targets: ["goblin-warrior"] }))).toThrow(
      /150 feet away/,
    );
    s.act(
      [15, 3, 3],
      cast("fire-bolt", { targets: ["goblin-warrior"], metamagic: { option: "distant" } }),
    );
    expect(s.result().targets[0]?.attack?.hit).toBe(true);
  });

  it("Extended Spell: Advantage on the saves to keep its Concentration", () => {
    const s = session(sabel(["extended", "subtle"]), 1);
    s.act(
      [1],
      cast("hold-person", { targets: ["goblin-warrior"], metamagic: { option: "extended" } }),
    );
    expect(s.get("sabel")?.extended_spell).toBe("Hold Person");
    // 6 damage: a DC 10 Constitution save, with Advantage (3 and 15).
    s.act([3, 15], {
      type: "effects",
      id: "sabel",
      actions: [{ type: "damage", amount: 6, damage_type: "fire" }],
    });
    expect(s.notes.some((n) => n.startsWith("Sabel keeps Concentration on Hold Person"))).toBe(
      true,
    );
  });

  it("Subtle Spell: no Verbal component, so a hidden caster stays hidden", () => {
    const s = session(sabel(["extended", "subtle"]), 1);
    s.act([20], { type: "hide", id: "sabel" });
    s.act([], { type: "next_turn" }, { type: "next_turn" });
    s.act(
      [1],
      cast("hold-person", { targets: ["goblin-warrior"], metamagic: { option: "subtle" } }),
    );
    expect(s.get("sabel")?.hidden).not.toBeNull();
  });
});
