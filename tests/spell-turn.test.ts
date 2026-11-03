import { describe, expect, it } from "vitest";
import type { SpellDef } from "../src/index";
import {
  afterCast,
  castTurnRefusals,
  dazeRefusal,
  planMetamagic,
  turnUses,
} from "../src/services/spell-turn";
import { catalog } from "./helpers";

// The pure rules behind a turn's spells: "One Spell with a Spell Slot per Turn", Metamagic, Daze.

const spell = (id: string) => catalog.spells[id] as SpellDef;
const sabel = {
  caster: "Sabel",
  known: true,
  points: { key: "sp", name: "Sorcery Points", left: 2 },
  cha: 2,
};
const none = { slot: false, leveled: false, quickened: false };
const texts = (m: { text: string }[]) => m.map((x) => x.text);

describe("castTurnRefusals", () => {
  it("one spell slot per turn; a cantrip is fine", () => {
    const after = afterCast(none, { level: 1, slotted: true, quickened: false });
    expect(
      texts(castTurnRefusals("Sabel", after, { level: 1, slotted: true, quickened: false })),
    ).toEqual(["Sabel has already used a spell slot to cast a spell this turn"]);
    expect(
      castTurnRefusals("Sabel", after, { level: 0, slotted: false, quickened: false }),
    ).toEqual([]);
  });

  it("Quickened Spell: not after a level 1+ spell, and no level 1+ spell after it", () => {
    const leveled = { ...none, leveled: true };
    expect(
      texts(castTurnRefusals("Sabel", leveled, { level: 0, slotted: false, quickened: true })),
    ).toEqual(["Sabel has already used a level 1+ spell this turn: no Quickened Spell"]);
    const quick = afterCast(none, { level: 0, slotted: false, quickened: true });
    expect(
      texts(castTurnRefusals("Sabel", quick, { level: 1, slotted: true, quickened: false })),
    ).toEqual(["Sabel has already used Quickened Spell this turn: no other level 1+ spell"]);
  });
});

describe("planMetamagic", () => {
  it("Distant Spell doubles a range, makes Touch 30 feet, and refuses Self", () => {
    const fireBolt = planMetamagic(spell("fire-bolt"), { option: "distant" }, sabel);
    expect(fireBolt.ok && fireBolt.spell.range).toBe("240 feet");
    const touch = planMetamagic(spell("shocking-grasp"), { option: "distant" }, sabel);
    expect(touch.ok && touch.spell.range).toBe("30 feet");
    const self = planMetamagic(spell("burning-hands"), { option: "distant" }, sabel);
    expect(self.ok).toBe(false);
  });

  it("Subtle Spell drops the components, but keeps a costly Material one", () => {
    const hold = planMetamagic(spell("hold-person"), { option: "subtle" }, sabel);
    expect(hold.ok && hold.spell.components).toBe("");
    const orb = planMetamagic(spell("chromatic-orb"), { option: "subtle" }, sabel);
    expect(orb.ok && orb.spell.components).toMatch(/^M \(.*GP/);
  });

  it("Transmuted Spell changes the listed types and the type picked for the cast", () => {
    const orb = planMetamagic(
      spell("chromatic-orb"),
      { option: "transmuted", damage_type: "cold" },
      sabel,
      "fire",
    );
    expect(orb.ok && orb.damage_type).toBe("cold");
    const ice = planMetamagic(
      spell("ice-storm"),
      { option: "transmuted", damage_type: "fire" },
      sabel,
    );
    expect(ice.ok && ice.spell.mechanics?.damage.map((d) => d.type)).toEqual([
      "bludgeoning",
      "fire",
    ]);
  });

  it("Heightened Spell costs 2 points: with 1 left, a shortage a GM can override", () => {
    const poor = { ...sabel, points: { key: "sp", name: "Sorcery Points", left: 1 } };
    const plan = planMetamagic(
      spell("hold-person"),
      { option: "heightened", targets: ["x"] },
      poor,
    );
    expect(plan.ok && plan.short?.text).toBe("Sorcery Points: 1 left");
  });

  it("an option the caster hasn't chosen is refused", () => {
    const plan = planMetamagic(
      spell("hold-person"),
      { option: "twinned" },
      { ...sabel, known: false },
    );
    expect(!plan.ok && plan.reason.text).toBe("Sabel doesn't have Twinned Spell");
  });
});

describe("Daze", () => {
  it("a second of moving, action and Bonus Action is refused; more of the same isn't", () => {
    const moved = turnUses({ used: { action: false, bonus_action: false }, moved: 10 });
    const acted = turnUses({ used: { action: true, bonus_action: false }, moved: 10 });
    expect(dazeRefusal("Ogre", true, moved, acted)?.text).toMatch(/^Ogre has already used/);
    expect(dazeRefusal("Ogre", true, moved, moved)).toBeNull();
    expect(dazeRefusal("Ogre", false, moved, acted)).toBeNull();
  });
});
