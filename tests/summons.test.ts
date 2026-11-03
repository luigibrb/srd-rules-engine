import { describe, expect, it } from "vitest";
import {
  applyEncounterAction,
  type Catalog,
  type CharacterBuild,
  type CharacterState,
  createCatalog,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  type EncounterResult,
  encounterCombatant,
  resolve,
  type SpellCastResult,
  scriptedRng,
} from "../src/index";
import * as svc from "../src/services/builder";
import { monsterDef } from "../src/services/encounter";
import { srdPack } from "../src/srd";
import { autocomplete, catalog, classBuild, fighterBuild, levelUpIn } from "./helpers";

// Creatures a spell brings (SRD 5.2.1 "Spells": Find Familiar, Find Steed, Giant Insect, Summon
// Dragon, Animate Objects, Animate Dead, Create Undead): their stat blocks scale with the spell
// slot and the caster, their turns follow the caster's (or their own Initiative), and they
// disappear when the rules say so.

/** A caster of `classId` at `level` with `spells` in its spellbook (a wizard) and prepared. */
function caster(classId: string, level: number, name: string, spells: string[]): CharacterBuild {
  let b = levelUpIn(autocomplete(classBuild(classId, { name })), classId, level - 1);
  for (const spell of spells) {
    for (const kind of ["spellbook", "prepared"]) {
      const res = resolve(b, catalog);
      const choice = res.choices.find(
        (c) =>
          c.definition.kind === "spell" &&
          c.key.endsWith(`#${kind}`) &&
          res.options(c).some((o) => o.id === spell && !o.unavailable),
      );
      if (!choice) continue;
      const others = res.selected(choice).filter((x) => x !== spell);
      const keep = Math.max(0, res.required(choice) - 1);
      b = svc.setChoice(b, catalog, choice.key, [spell, ...others.slice(0, keep)]).build;
      b = autocomplete(b);
    }
  }
  return b;
}

/**
 * Characters (Initiative 20, 19…) and monsters after them, the fight started (or not, to cast a
 * spell that takes a minute or more first).
 */
function session(
  builds: Record<string, CharacterBuild>,
  monsters: string[] = [],
  { start = true, cat = catalog }: { start?: boolean; cat?: Catalog } = {},
) {
  const states: Record<string, CharacterState> = Object.fromEntries(
    Object.entries(builds).map(([k, b]) => [k, createState(b, cat)]),
  );
  let encounter: Encounter = createEncounter();
  const notes: string[] = [];
  let last: EncounterResult | null = null;
  const ctx = () => ({
    catalog: cat,
    characters: Object.fromEntries(
      Object.entries(builds).map(([k, build]) => [
        k,
        { build, state: states[k] as CharacterState },
      ]),
    ),
  });
  const act = (rolls: number[], ...actions: EncounterAction[]) => {
    for (const action of actions) {
      last = applyEncounterAction(encounter, action, { ...ctx(), rng: scriptedRng(rolls) });
      encounter = last.encounter;
      Object.assign(states, last.states);
      notes.push(...last.notes);
    }
  };
  const keys = Object.keys(builds);
  act(
    [],
    ...keys.map((character) => ({ type: "add_character", character }) as const),
    ...monsters.map((monster) => ({ type: "add_monster", monster, side: "enemies" }) as const),
    ...keys.map((id, i) => ({ type: "set_initiative", id, value: 20 - i }) as const),
    ...monsters.map((id, i) => ({ type: "set_initiative", id, value: 10 - i }) as const),
  );
  if (start) act([], { type: "start" });
  return {
    act,
    notes,
    states,
    get: (id: string) => encounter.combatants.find((c) => c.id === id),
    view: (id: string) => encounterCombatant(encounter, id, ctx()),
    /** Its stat block (speeds, creature type), as the encounter makes it. */
    def: (id: string) => monsterDef(ctx(), encounter.combatants.find((c) => c.id === id) as never),
    encounter: () => encounter,
    cast: () => (last?.result ?? null) as SpellCastResult | null,
    ctx,
  };
}

const cast = (
  id: string,
  spell: string,
  extra: Partial<Extract<EncounterAction, { type: "cast" }>> = {},
) => ({ type: "cast", id, spell, ...extra }) as EncounterAction;

describe("Giant Insect", () => {
  const wren = () => caster("druid", 7, "Wren", ["giant-insect"]);

  it("a spider at level 4: AC 15, 30 HP, the caster's spell attack, its turn right after Wren's", () => {
    const s = session({ wren: wren() }, ["goblin-warrior"]);
    s.act([], cast("wren", "giant-insect", { summon: { forms: ["spider"] } }));
    const insect = s.get("giant-insect");
    expect(insect).toMatchObject({ hp: 30, side: "party", initiative: 20 });
    expect(insect?.summon).toMatchObject({ by: "wren", form: "spider", concentration: true });
    expect(s.notes).toContain("Giant Insect appears (Wren's Giant Insect).");
    const view = s.view("giant-insect");
    expect(view.armor_class).toBe(15);
    // The caster's spell attack (the spell makes none of its own).
    const attack = s.view("wren").spellcasting[0]?.attack_bonus;
    expect(view.attacks.map((a) => [a.name, a.attack_bonus])).toEqual([
      ["Poison Jab", attack],
      ["Web Bolt", attack],
    ]);
    expect(s.encounter().order).toEqual(["wren", "giant-insect", "goblin-warrior"]);
    s.act([], { type: "next_turn" });
    expect(s.notes.at(-1)).toBe("Round 1: Giant Insect's turn.");
  });

  it("a level 6 slot: AC 17, 50 HP, three attacks; a wasp flies, only a spider has Web Bolt", () => {
    const s = session({ wren: caster("druid", 11, "Wren", ["giant-insect"]) });
    s.act([], cast("wren", "giant-insect", { slot_level: 6, summon: { forms: ["wasp"] } }));
    const view = s.view("giant-insect");
    expect(view.armor_class).toBe(17);
    expect(s.get("giant-insect")?.hp).toBe(50);
    expect(view.attacks_per_action).toBe(3);
    expect(view.attacks.map((a) => a.name)).toEqual(["Poison Jab"]);
    expect(s.def("giant-insect").speed).toEqual({ walk: 40, climb: 40, fly: 40 });
  });

  it("disappears when Wren's Concentration ends, or at 0 Hit Points", () => {
    const s = session({ wren: wren() });
    s.act([], cast("wren", "giant-insect", { summon: { forms: ["centipede"] } }));
    s.act([], {
      type: "effects",
      id: "wren",
      actions: [{ type: "set_concentration", spell: null }],
    });
    expect(s.get("giant-insect")).toBeUndefined();
    expect(s.notes).toContain("Giant Insect disappears: Concentration ended.");
    expect(s.encounter().order).toEqual(["wren"]);

    const t = session({ wren: wren() });
    t.act([], cast("wren", "giant-insect", { summon: { forms: ["centipede"] } }));
    t.act([], { type: "effects", id: "giant-insect", actions: [{ type: "damage", amount: 30 }] });
    expect(t.get("giant-insect")).toBeUndefined();
    expect(t.notes).toContain("Giant Insect disappears: it dropped to 0 Hit Points.");
  });

  it("refuses a form the spell doesn't make", () => {
    const s = session({ wren: wren() });
    expect(() =>
      s.act([], cast("wren", "giant-insect", { summon: { forms: ["beetle"] } })),
    ).toThrow("Giant Insect doesn't make 'beetle' (its forms: centipede, spider, wasp)");
  });
});

describe("Summon Dragon", () => {
  const ilse = () => caster("wizard", 9, "Ilse", ["summon-dragon"]);

  it("the Breath Weapon deals the damage type chosen when casting, at the caster's DC", () => {
    const s = session({ ilse: ilse() });
    expect(() => s.act([], cast("ilse", "summon-dragon"))).toThrow(/choose resistance/);
    s.act([], cast("ilse", "summon-dragon", { summon: { choices: { resistance: "cold" } } }));
    const view = s.view("draconic-spirit");
    expect(view.armor_class).toBe(19);
    expect(s.get("draconic-spirit")?.hp).toBe(50);
    expect(view.attacks_per_action).toBe(2);
    const breath = view.save_actions.find((a) => a.name === "Breath Weapon");
    expect(breath).toMatchObject({ dc: s.view("ilse").spellcasting[0]?.save_dc });
    expect(breath?.damage_parts.map((d) => d.type)).toEqual(["cold"]);
  });
});

describe("Find Familiar", () => {
  const ilse = () => caster("wizard", 1, "Ilse", ["find-familiar"]);

  it("an owl that's a Fey; it rolls its own Initiative and can't attack; a new one replaces it", () => {
    // A casting time of 1 hour: cast before the fight.
    const s = session({ ilse: ilse() }, ["goblin-warrior"], { start: false });
    expect(() => s.act([], cast("ilse", "find-familiar", { summon: { forms: ["owl"] } }))).toThrow(
      "Find Familiar: choose its creature type (celestial, fey, fiend)",
    );
    s.act([], cast("ilse", "find-familiar", { summon: { forms: ["owl"], creature_type: "fey" } }));
    expect(s.def("owl").creature_type).toBe("Fey");
    expect(s.get("owl")).toMatchObject({ initiative: null, monster: "owl" });
    expect(() => s.act([], { type: "start" })).toThrow("Roll Initiative first: Owl");
    s.act([10], { type: "roll_initiative" }, { type: "start" });
    expect(s.encounter().order).toContain("owl");
    expect(() =>
      s.act([], { type: "attack", id: "owl", target: "goblin-warrior", attack: "Talons" }),
    ).toThrow("Owl can't attack");
    s.act([], { type: "end" });
    s.act(
      [],
      cast("ilse", "find-familiar", { summon: { forms: ["cat"], creature_type: "celestial" } }),
    );
    expect(s.get("owl")).toBeUndefined();
    expect(s.notes).toContain("Owl disappears: a new one replaces it.");
    expect(s.def("cat").creature_type).toBe("Celestial");
  });
});

describe("Find Steed", () => {
  it("a Fiend steed glares at the caster's DC; it disappears if its rider dies", () => {
    const s = session({ vex: caster("paladin", 5, "Vex", ["find-steed"]) });
    s.act([], cast("vex", "find-steed", { summon: { choices: { creature_type: "Fiend" } } }));
    const view = s.view("otherworldly-steed");
    expect(view.armor_class).toBe(12);
    expect(s.get("otherworldly-steed")?.hp).toBe(25);
    expect(view.attacks[0]?.damage_parts).toEqual([{ dice: "1d8", bonus: 2, type: "necrotic" }]);
    expect(view.save_actions.map((a) => [a.name, a.dc])).toEqual([
      ["Fell Glare", s.view("vex").spellcasting[0]?.save_dc],
    ]);
    s.act([], { type: "effects", id: "vex", actions: [{ type: "damage", amount: 200 }] });
    expect(s.get("otherworldly-steed")).toBeUndefined();
    expect(s.notes).toContain("Otherworldly Steed disappears: its caster died.");
  });
});

describe("Animate Objects", () => {
  it("objects up to the spellcasting modifier, Large counting two and Huge three", () => {
    const b = caster("bard", 9, "Lute", ["animate-objects"]);
    const s = session({ lute: b });
    const mod = s.view("lute").spellcasting[0]?.modifier as number;
    expect(mod).toBeGreaterThanOrEqual(2);
    // A Large one (2) and Small ones up to the modifier; one more is too many.
    const small = Array<string>(mod - 2).fill("small");
    expect(() =>
      s.act(
        [],
        cast("lute", "animate-objects", { summon: { forms: ["large", "small", ...small] } }),
      ),
    ).toThrow(`Animate Objects makes up to ${mod} creatures at this level`);
    s.act([], cast("lute", "animate-objects", { summon: { forms: ["large", ...small] } }));
    const objects = s.encounter().combatants.filter((c) => c.summon?.source === "animate-objects");
    expect(objects.map((c) => c.hp)).toEqual([20, ...small.map(() => 10)]);
    expect(s.view("animated-object").attacks[0]?.damage_parts).toEqual([
      { dice: "2d6", bonus: 3 + mod, type: "force" },
    ]);
    expect(s.encounter().order).toEqual(["lute", ...objects.map((c) => c.id)]);
  });
});

describe("Animate Dead and Create Undead", () => {
  it("one Skeleton or Zombie, two more per slot level above 3; they roll their own Initiative", () => {
    // A casting time of 1 minute: before the fight.
    const s = session({ mira: caster("cleric", 7, "Mira", ["animate-dead"]) }, [], {
      start: false,
    });
    expect(() =>
      s.act([], cast("mira", "animate-dead", { summon: { forms: ["skeleton", "zombie"] } })),
    ).toThrow("Animate Dead makes 1 creature at this level");
    s.act(
      [],
      cast("mira", "animate-dead", {
        slot_level: 4,
        summon: { forms: ["skeleton", "zombie", "zombie"] },
      }),
    );
    expect(s.encounter().combatants.map((c) => c.id)).toEqual([
      "mira",
      "skeleton",
      "zombie",
      "zombie-2",
    ]);
    expect(s.get("zombie")).toMatchObject({ initiative: null, side: "party" });
  });

  it("three Ghouls at level 6; Ghasts need a level 8 slot; one form per casting", () => {
    const s = session({ mira: caster("cleric", 11, "Mira", ["create-undead"]) }, [], {
      start: false,
    });
    expect(() =>
      s.act([], cast("mira", "create-undead", { summon: { forms: ["ghast"] } })),
    ).toThrow("Ghast needs a level 8+ spell slot");
    expect(() =>
      s.act(
        [],
        cast("mira", "create-undead", { summon: { forms: ["ghoul", "ghoul", "ghoul", "ghoul"] } }),
      ),
    ).toThrow("Create Undead makes up to 3 creatures at this level");
    s.act([], cast("mira", "create-undead", { summon: { forms: ["ghoul", "ghoul", "ghoul"] } }));
    expect(s.encounter().combatants.filter((c) => c.monster === "ghoul")).toHaveLength(3);
  });
});

describe("summons in the documents", () => {
  it("an encounter with a summoned creature round-trips through JSON", () => {
    const s = session({ wren: caster("druid", 7, "Wren", ["giant-insect"]) });
    s.act([], cast("wren", "giant-insect", { summon: { forms: ["spider"] } }));
    const saved = JSON.parse(JSON.stringify(s.encounter()));
    expect(encounterCombatant(saved, "giant-insect", s.ctx()).armor_class).toBe(15);
  });

  it("a spell that summons nothing refuses `summon`", () => {
    const s = session({ wren: caster("druid", 7, "Wren", ["giant-insect"]) });
    expect(() =>
      s.act(
        [],
        cast("wren", "giant-insect", { summon: { forms: ["spider"] } }),
        cast("wren", "moonbeam", { summon: {} }),
      ),
    ).toThrow();
  });
});

describe("summons from features", () => {
  it("Wild Companion: Find Familiar with a use of Wild Shape, no spell slot; the familiar is Fey", () => {
    const wren = levelUpIn(autocomplete(classBuild("druid", { name: "Wren" })), "druid", 1);
    const s = session({ wren });
    const slots = s.states.wren?.spell_slots_spent;
    s.act([], {
      type: "feature",
      id: "wren",
      feature: "Wild Companion",
      summon: { forms: ["owl"] },
    });
    expect(s.def("owl").creature_type).toBe("Fey");
    expect(s.get("owl")?.summon).toMatchObject({ by: "wren", source: "find-familiar" });
    expect(s.states.wren?.spell_slots_spent).toEqual(slots);
    expect(s.states.wren?.uses_spent["druid:wild-shape"]).toBe(1);
    expect(s.notes).toContain("Owl appears (Wren's Find Familiar).");
  });

  // An invented companion feat: its stat block scales with the character's level.
  const homebrew = createCatalog(srdPack, {
    name: "homebrew",
    summons: [
      {
        id: "clockwork-hound",
        name: "Clockwork Hound",
        stat_block: {
          size: "Medium",
          creature_type: "Construct",
          alignment: "Unaligned",
          armor_class: "=13 + floor(class_level / 4)",
          initiative: 2,
          hit_points: "=5 * class_level",
          speed: { walk: 40 },
          abilities: { str: 14, dex: 14, con: 12, int: 4, wis: 12, cha: 4 },
          saving_throws: { str: 2, dex: 2, con: 1, int: -3, wis: 1, cha: -3 },
          passive_perception: 11,
          cr: "None",
          xp: 0,
          proficiency_bonus: "=pb",
          actions: [
            {
              name: "Bite",
              text: "_Melee Attack Roll:_ +{2 + pb}, reach 5 ft. _Hit:_ 1d8 + 2 Piercing damage.",
              attack: {
                kind: "melee",
                bonus: "=2 + pb",
                reach: 5,
                damage: [{ average: 6, dice: "1d8", bonus: 2, type: "piercing" }],
              },
            },
          ],
        },
      },
    ],
    feats: [
      {
        id: "hound-keeper",
        name: "Hound Keeper",
        category: "general",
        grants: {
          actions: [
            {
              id: "call-hound",
              name: "Call Hound",
              economy: "action",
              summon: {
                forms: [{ id: "hound", name: "Clockwork Hound", summon: "clockwork-hound" }],
                ends: ["zero_hp", "caster_dies"],
                unique: true,
              },
            },
          ],
        },
      },
    ],
  });

  it("a feature's own creature scales with the level; a new one replaces it", () => {
    let b = levelUpIn(fighterBuild(), "fighter", 7, null, homebrew);
    b = svc.setChoice(b, homebrew, "class:fighter:4#feat", ["hound-keeper"]).build;
    b = autocomplete(b, homebrew);
    const s = session({ brakka: b }, [], { cat: homebrew });
    s.act([], { type: "feature", id: "brakka", feature: "Call Hound" });
    expect(s.get("clockwork-hound")).toMatchObject({ hp: 40, initiative: 20 });
    expect(s.view("clockwork-hound").armor_class).toBe(15);
    expect(s.view("clockwork-hound").attacks[0]?.attack_bonus).toBe(5); // 2 + PB 3
    s.act([], { type: "next_turn" }, { type: "next_turn" });
    s.act([], { type: "feature", id: "brakka", feature: "Call Hound" });
    expect(s.notes).toContain("Clockwork Hound disappears: a new one replaces it.");
    expect(s.encounter().combatants.filter((c) => c.monster === "clockwork-hound")).toHaveLength(1);
  });

  it("a feature that summons nothing refuses `summon`", () => {
    const s = session({ brakka: fighterBuild() });
    expect(() =>
      s.act([], {
        type: "feature",
        id: "brakka",
        feature: "Second Wind",
        summon: { forms: ["x"] },
      }),
    ).toThrow("Second Wind: it summons nothing");
  });
});
