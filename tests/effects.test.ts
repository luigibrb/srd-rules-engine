import { describe, expect, it } from "vitest";
import {
  type AttackLine,
  applyAction,
  type CharacterBuild,
  type CharacterState,
  castSpell,
  combatantFromCharacter,
  computePlaySheet,
  createState,
  lookup,
  makeAttack,
  type PlayAction,
  PlayError,
  rollSavingThrow,
  type SpellDef,
  scriptedRng,
} from "../src/index";
import { autocomplete, catalog, classBuild, levelUpIn } from "./helpers";

const play = (build: CharacterBuild, state: CharacterState, ...actions: PlayAction[]) => {
  let s = state;
  const notes: string[] = [];
  for (const action of actions) {
    const r = applyAction(build, s, catalog, action);
    s = r.state;
    notes.push(...r.notes);
  }
  return { state: s, notes, sheet: computePlaySheet(build, s, catalog) };
};
const attack = (lines: readonly AttackLine[], name: string) =>
  lines.find((a) => a.name === name) as AttackLine;

describe("Rage (a toggle)", () => {
  const barbarian = autocomplete(classBuild("barbarian", { name: "Ulla" }));
  const rage = { type: "activate", key: "barbarian:rage" } as const;
  const fresh = () => createState(barbarian, catalog);

  it("spends a use and gives Resistance, Rage Damage and Strength Advantage", () => {
    const before = play(barbarian, fresh()).sheet;
    expect(before.toggles).toEqual([
      expect.objectContaining({ key: "barbarian:rage", active: false, uses: "barbarian:rage" }),
    ]);
    const { sheet } = play(barbarian, fresh(), rage);
    expect(sheet.play.uses.find((u) => u.key === "barbarian:rage")?.spent).toBe(1);
    expect(sheet.resistances).toEqual(
      expect.arrayContaining(["bludgeoning", "piercing", "slashing"]),
    );
    expect(sheet.advantages.map((a) => a.target)).toEqual(["check.str", "save.str"]);
    const axe = attack(sheet.attacks, "Greataxe");
    const plainAxe = attack(before.attacks, "Greataxe");
    expect(axe.damage_parts).toEqual([
      ...plainAxe.damage_parts,
      { dice: null, bonus: 2, type: "slashing" },
    ]);
    expect(axe.notes).toContain("Rage Damage +2");
    // An Unarmed Strike uses Strength too.
    expect(attack(sheet.attacks, "Unarmed Strike").damage_parts).toHaveLength(2);
  });

  it("Rage Damage follows the Rage Damage column (+3 at Barbarian 9)", () => {
    const ninth = levelUpIn(barbarian, "barbarian", 8);
    const { sheet } = play(ninth, createState(ninth, catalog), rage);
    expect(attack(sheet.attacks, "Greataxe").damage_parts.at(-1)?.bonus).toBe(3);
  });

  it("Strength saves have Advantage while raging", () => {
    const { state } = play(barbarian, fresh(), rage);
    const raging = combatantFromCharacter(barbarian, state, catalog);
    const save = rollSavingThrow(raging, "str", 15, { rng: scriptedRng([3, 17]) });
    expect(save.roll).toMatchObject({ rolls: [3, 17], d20: 17, mode: "advantage" });
    const tired = rollSavingThrow(raging, "str", 15, {
      mode: "disadvantage",
      rng: scriptedRng([3]),
    });
    expect(tired.roll.mode).toBe("normal"); // Advantage and Disadvantage cancel
  });

  it("ends when Incapacitated, on a rest, or when switched off", () => {
    const stunned = play(barbarian, fresh(), rage, { type: "add_condition", condition: "stunned" });
    expect(stunned.state.active).toEqual([]);
    expect(stunned.notes).toContain("Rage ends (incapacitated).");
    expect(play(barbarian, fresh(), rage, { type: "long_rest" }).state.active).toEqual([]);
    const off = play(barbarian, fresh(), rage, { type: "deactivate", key: "barbarian:rage" });
    expect(off.state.active).toEqual([]);
  });

  it("can't start in Heavy armor, and ends when Heavy armor goes on", () => {
    const armored = play(barbarian, fresh(), { type: "add_item", item: "plate-armor" });
    const id = armored.state.inventory.find((i) => i.item === "plate-armor")?.id as string;
    const wearing = play(barbarian, armored.state, { type: "equip", id, equipped: true });
    expect(() => play(barbarian, wearing.state, rage)).toThrow(/wearing heavy armor/);
    const raging = play(barbarian, armored.state, rage);
    const donned = play(barbarian, raging.state, { type: "equip", id, equipped: true });
    expect(donned.state.active).toEqual([]);
    expect(donned.notes).toContain("Rage ends (wearing heavy armor).");
  });

  it("runs out of uses (2 at level 1)", () => {
    const off = { type: "deactivate", key: "barbarian:rage" } as const;
    expect(() => play(barbarian, fresh(), rage, off, rage, off, rage)).toThrow(
      "No uses of Rage left",
    );
  });

  it("means no Concentration and no spells", () => {
    const concentrating = play(barbarian, fresh(), { type: "set_concentration", spell: "Bless" });
    const raging = play(barbarian, concentrating.state, rage);
    expect(raging.notes).toContain("Concentration on Bless ends (Rage).");
    expect(() =>
      play(barbarian, raging.state, { type: "set_concentration", spell: "Bless" }),
    ).toThrow(PlayError);
    const caster = combatantFromCharacter(barbarian, raging.state, catalog);
    const light = lookup(catalog.spells, "fire-bolt") as SpellDef;
    expect(() => castSpell(caster, light, [])).toThrow(/can't cast spells/);
  });
});

describe("Sneak Attack (an optional rider from a class column)", () => {
  const rogue = autocomplete(classBuild("rogue", { name: "Pip" }));
  const withBow = () =>
    play(rogue, createState(rogue, catalog), { type: "add_item", item: "shortbow" });

  it("is offered on Finesse and Ranged weapons only", () => {
    const { sheet } = withBow();
    const sneak = (name: string) => attack(sheet.attacks, name).riders.map((r) => r.id);
    expect(sneak("Shortbow")).toEqual(["sneak-attack"]);
    expect(sneak("Dagger")).toEqual(["sneak-attack"]);
    expect(sneak("Unarmed Strike")).toEqual([]);
    expect(attack(sheet.attacks, "Dagger").riders[0]).toMatchObject({
      dice: "1d6",
      type: "piercing",
      once_per_turn: true,
      requires: "advantage_or_ally",
    });
  });

  it("grows with the Sneak Attack column (3d6 at Rogue 5)", () => {
    const fifth = levelUpIn(rogue, "rogue", 4);
    const sheet = computePlaySheet(fifth, createState(fifth, catalog), catalog);
    expect(attack(sheet.attacks, "Dagger").riders[0]?.dice).toBe("3d6");
  });

  it("needs Advantage, or an ally next to the target without Disadvantage", () => {
    const { state } = withBow();
    const pip = combatantFromCharacter(rogue, state, catalog);
    const target = { ...pip, armor_class: 10, hp: 30, max_hp: 30 };
    const sneak = [{ rider: "sneak-attack" }];
    expect(() => makeAttack(pip, "Dagger", target, { riders: sneak })).toThrow(/needs Advantage/);
    expect(() =>
      makeAttack(pip, "Dagger", target, {
        riders: sneak,
        ally_adjacent: true,
        mode: "disadvantage",
      }),
    ).toThrow(/needs Advantage/);
    const hit = makeAttack(pip, "Dagger", target, {
      riders: sneak,
      mode: "advantage",
      rng: scriptedRng([5, 15, 2, 6]),
    });
    expect(hit.riders).toEqual(["Sneak Attack"]);
    expect(hit.damage?.parts.map((p) => [p.dice, p.rolls])).toEqual([
      ["1d4", [2]],
      ["1d6", [6]],
    ]);
  });

  it("rolls its dice twice on a Critical Hit", () => {
    const { state } = withBow();
    const pip = combatantFromCharacter(rogue, state, catalog);
    const hit = makeAttack(pip, "Dagger", pip, {
      riders: [{ rider: "Sneak Attack" }],
      ally_adjacent: true,
      rng: scriptedRng([20, 1, 1, 3, 4]),
    });
    expect(hit.damage?.parts[1]?.rolls).toEqual([3, 4]);
  });
});

describe("Divine Strike (a rider with a choice of type, upgraded at level 14)", () => {
  const cleric = levelUpIn(autocomplete(classBuild("cleric", { name: "Oswin" })), "cleric", 6);

  it("is offered on weapon attacks, Necrotic or Radiant", () => {
    expect(cleric.choices["class:cleric:7#blessed_strikes"]).toEqual(["divine-strike"]);
    const sheet = computePlaySheet(cleric, createState(cleric, catalog), catalog);
    const mace = attack(sheet.attacks, "Mace");
    expect(mace.riders).toEqual([
      expect.objectContaining({ id: "divine-strike", dice: "1d8", type: ["necrotic", "radiant"] }),
    ]);
    expect(attack(sheet.attacks, "Unarmed Strike").riders).toEqual([]);
  });

  it("asks for the damage type", () => {
    const oswin = combatantFromCharacter(cleric, createState(cleric, catalog), catalog);
    const target = { ...oswin, armor_class: 5 };
    expect(() =>
      makeAttack(oswin, "Mace", target, { riders: [{ rider: "divine-strike" }] }),
    ).toThrow(/choose a damage type \(necrotic, radiant\)/);
    const hit = makeAttack(oswin, "Mace", target, {
      riders: [{ rider: "divine-strike", type: "radiant" }],
      rng: scriptedRng([15, 3, 8]),
    });
    expect(hit.instances.at(-1)).toEqual({ amount: 8, type: "radiant" });
  });

  it("becomes 2d8 at Cleric 14 (one rider, not two)", () => {
    const fourteenth = levelUpIn(cleric, "cleric", 7);
    const sheet = computePlaySheet(fourteenth, createState(fourteenth, catalog), catalog);
    expect(attack(sheet.attacks, "Mace").riders.map((r) => r.dice)).toEqual(["2d8"]);
  });
});
