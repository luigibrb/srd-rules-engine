import { describe, expect, it } from "vitest";
import {
  applyEncounterAction,
  type CharacterState,
  combatantFromMonster,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  lookup,
  type MonsterDef,
  monsterSpells,
  scriptedRng,
} from "../src/index";
import { catalog, fighterBuild } from "./helpers";

// SRD 5.2.1 "Monsters" > "Spellcasting": "a spell of level 1 or higher is always cast at its
// lowest possible level and can't be cast at a higher level."

const monster = (id: string) => lookup(catalog.monsters, id) as MonsterDef;
const action = (id: string, name: string) =>
  [
    ...monster(id).actions,
    ...monster(id).bonus_actions,
    ...monster(id).reactions,
    ...monster(id).legendary_actions,
  ].find((a) => a.name === name);

describe("spellcasting data", () => {
  it("the Mage's Spellcasting lists, with ability, DC, levels and daily uses", () => {
    expect(action("mage", "Spellcasting")?.casts).toEqual({
      ability: "int",
      save_dc: 14,
      attack_bonus: null,
      spells: [
        { spell: "detect-magic", level: null, per_day: null, note: "" },
        { spell: "light", level: null, per_day: null, note: "" },
        { spell: "mage-armor", level: null, per_day: null, note: "included in AC" },
        { spell: "mage-hand", level: null, per_day: null, note: "" },
        { spell: "prestidigitation", level: null, per_day: null, note: "" },
        { spell: "fireball", level: 4, per_day: 2, note: "" },
        { spell: "invisibility", level: null, per_day: 2, note: "" },
        { spell: "cone-of-cold", level: null, per_day: 1, note: "" },
        { spell: "fly", level: null, per_day: 1, note: "" },
      ],
    });
  });

  it("other actions that cast: shared daily uses, Spellcasting's ability, legendary ones", () => {
    const aid = action("priest", "Divine Aid (3/Day)");
    expect(aid?.per_day).toBe(3);
    expect(aid?.casts).toMatchObject({ ability: "wis", save_dc: 13 });
    expect(aid?.casts?.spells.map((s) => s.spell)).toEqual([
      "bless",
      "dispel-magic",
      "healing-word",
      "lesser-restoration",
    ]);
    expect(action("imp", "Invisibility")?.casts?.spells).toEqual([
      { spell: "invisibility", level: null, per_day: null, note: "self only" },
    ]);
    expect(action("adult-red-dragon", "Commanding Presence")?.casts).toMatchObject({
      save_dc: 20,
      attack_bonus: 12,
      spells: [{ spell: "command", level: 2 }],
    });
    // "Long-strider" in the Druid's list is the SRD's Longstrider.
    expect(monsterSpells(monster("druid")).map((s) => s.spell)).toContain("longstrider");
  });

  it("what can't be read safely stays text", () => {
    // "casts Fireball (level 5 version) twice… It can replace one Fireball with Hold Monster"
    expect(action("pit-fiend", "Hellfire Spellcasting")?.casts).toBeNull();
    expect(action("unicorn", "Unicorn's Blessing (3/Day)")?.casts).toBeNull();
  });
});

describe("monster combatants", () => {
  it("one spellcasting line per casting action; a missing attack bonus is the DC − 8", () => {
    const mage = combatantFromMonster(monster("mage"));
    expect(mage.spellcasting.map((s) => [s.source, s.save_dc, s.attack_bonus])).toEqual([
      ["Spellcasting", 14, 6],
      ["Misty Step (3/Day)", 14, 6],
      ["Protective Magic (3/Day)", 14, 6],
    ]);
    // Brass dragon: "spell save DC 16" only, yet it casts Scorching Ray.
    const brass = combatantFromMonster(monster("adult-brass-dragon"));
    expect(brass.spellcasting[0]).toMatchObject({ save_dc: 16, attack_bonus: 8 });
    // The imp gives neither: 8 + Charisma modifier + PB.
    const imp = combatantFromMonster(monster("imp"));
    const cha = imp.modifiers.cha;
    expect(imp.spellcasting[0]?.save_dc).toBe(8 + cha + monster("imp").proficiency_bonus);
  });
});

describe("in an encounter", () => {
  /** Brakka (Initiative 20) and monsters (10, 9…), starting on the first monster's turn. */
  function fight(...monsters: string[]) {
    const build = fighterBuild();
    let state: CharacterState = createState(build, catalog);
    let encounter: Encounter = createEncounter();
    const notes: string[] = [];
    const act = (rolls: number[], ...actions: EncounterAction[]) => {
      const rng = scriptedRng(rolls);
      for (const a of actions) {
        const characters = { brakka: { build, state } };
        const r = applyEncounterAction(encounter, a, { catalog, characters, rng });
        encounter = r.encounter;
        state = r.states.brakka ?? state;
        notes.push(...r.notes);
      }
    };
    act(
      [],
      { type: "add_character", character: "brakka" },
      ...monsters.map((m) => ({ type: "add_monster", monster: m }) as const),
      { type: "set_initiative", id: "brakka", value: 20 },
      ...monsters.map((m, i) => ({ type: "set_initiative", id: m, value: 10 - i }) as const),
      { type: "start" },
      { type: "next_turn" },
    );
    const get = (id: string) => encounter.combatants.find((c) => c.id === id);
    return { act, notes, get, state: () => state, encounter: () => encounter };
  }
  const dice = Array<number>(20).fill(1);
  const round = (...monsters: string[]) =>
    [...monsters, "brakka"].map(() => ({ type: "next_turn" }) as const);

  it("a spell at its fixed level, 2/Day", () => {
    const s = fight("mage");
    const fireball = {
      type: "cast",
      id: "mage",
      spell: "fireball",
      targets: ["brakka"],
    } satisfies EncounterAction;
    expect(() => s.act([], { ...fireball, slot_level: 5 })).toThrow(
      "Mage casts Fireball at level 4 only",
    );
    s.act(dice, fireball);
    expect(s.notes).toContain("Mage casts Fireball at level 4.");
    expect(s.get("mage")?.daily_used).toEqual({ "Spellcasting#fireball": 1 });
    s.act(dice, ...round("mage"), fireball, ...round("mage"));
    expect(() => s.act(dice, fireball)).toThrow("Mage has used Fireball 2 times today");
  });

  it("the action's section decides the economy; `via` picks the action", () => {
    const s = fight("mage");
    s.act([], { type: "cast", id: "mage", spell: "misty-step" });
    expect(s.get("mage")).toMatchObject({
      used: { action: false, bonus_action: true },
      daily_used: { "Misty Step (3/Day)": 1 },
    });
    expect(() =>
      s.act([], {
        type: "cast",
        id: "mage",
        spell: "fireball",
        via: "Misty Step (3/Day)",
        targets: [],
      }),
    ).toThrow("Mage can't cast Fireball with Misty Step (3/Day)");
    // Protective Magic is a reaction, on someone else's turn.
    s.act([], { type: "next_turn" }, { type: "cast", id: "mage", spell: "shield" });
    expect(s.get("mage")?.used.reaction).toBe(true);
  });

  it("an X/Day saving throw effect is counted too", () => {
    const s = fight("quasit");
    const scare = {
      type: "save_action",
      id: "quasit",
      ability: "Scare (1/Day)",
      targets: ["brakka"],
    } satisfies EncounterAction;
    s.act([20], scare);
    expect(s.get("quasit")?.daily_used).toEqual({ "Scare (1/Day)": 1 });
    s.act([], ...round("quasit"));
    expect(() => s.act([20], scare)).toThrow("Quasit has used Scare (1/Day) 1 time today");
  });

  it("Recharge, long casting times, and Concentration spells' conditions", () => {
    const s = fight("drider", "lich", "cultist-fanatic");
    s.act([], { type: "cast", id: "drider", spell: "darkness" });
    expect(s.get("drider")?.expended).toEqual(["Magic of the Spider Queen"]);
    s.act([], { type: "next_turn" }); // the lich
    expect(() => s.act([], { type: "cast", id: "lich", spell: "animate-dead" })).toThrow(
      "Animate Dead takes 1 minute: a monster casts it with the Magic action on each of its turns",
    );
    s.act([], { type: "next_turn" }); // the cultist: Hold Person (1/Day), Brakka fails
    s.act([1], { type: "cast", id: "cultist-fanatic", spell: "hold-person", targets: ["brakka"] });
    expect(s.state().conditions).toContain("paralyzed");
    expect(s.get("cultist-fanatic")?.concentration).toBe("Hold Person");
    expect(s.encounter().effects).toMatchObject([
      { target: "brakka", condition: "paralyzed", source: "cultist-fanatic", concentration: true },
    ]);
  });
});
