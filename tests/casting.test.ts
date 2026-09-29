import { describe, expect, it } from "vitest";
import { createHandler } from "../src/http/index";
import {
  type Combatant,
  cantripTier,
  castSpell,
  lookup,
  NO_CONDITION_ROLLS,
  type SpellDef,
  scriptedRng,
  seededRng,
} from "../src/index";
import * as svc from "../src/services/builder";
import { apply, autocomplete, catalog, classBuild } from "./helpers";

const spell = (id: string) => lookup(catalog.spells, id) as SpellDef;
const zero = { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 };
const wizardLine = {
  source: "Wizard",
  list: "wizard",
  ability: "int",
  save_dc: 13,
  attack_bonus: 5,
  modifier: 3,
} as const;
const creature = (o: Partial<Combatant> = {}): Combatant => ({
  name: "Target",
  level: 1,
  armor_class: 12,
  hp: 40,
  temp_hp: 0,
  max_hp: 40,
  proficiency_bonus: 2,
  modifiers: zero,
  saving_throws: zero,
  ability_checks: zero,
  skills: {},
  defenses: { resistances: [], vulnerabilities: [], immunities: [] },
  conditions: [],
  attacks: [],
  critical_hit_on: 20,
  attacks_per_action: 1,
  spellcasting: [],
  advantages: [],
  no_spells: false,
  condition_immunities: [],
  save_actions: [],
  condition_rolls: NO_CONDITION_ROLLS,
  legendary_actions: [],
  legendary_resistance: 0,
  size: null,
  ...o,
});
const mage = (level = 1) => creature({ name: "Mage", level, spellcasting: [wizardLine] });

describe("golden spells (mechanics checked against the SRD text)", () => {
  it("every spell's mechanics, as reviewed (a change here needs a review against the SRD)", () => {
    const withMechanics = Object.values(catalog.spells).filter((s) => s.mechanics);
    expect(withMechanics).toHaveLength(53);
    expect(Object.fromEntries(withMechanics.map((s) => [s.id, s.mechanics]))).toMatchSnapshot();
  });

  it("every spell with mechanics casts, at its level and with a 9th-level slot", () => {
    for (const s of Object.values(catalog.spells)) {
      const m = s.mechanics;
      if (!m) continue;
      if (m.cantrip_scaling) expect(s.level, s.id).toBe(0);
      if (m.upcast) expect(s.level, s.id).toBeGreaterThan(0);
      const count = Math.min(m.targets ?? 2, 2);
      const targets = Array.from({ length: count }, () => creature());
      const slots = s.level === 0 ? [undefined] : [s.level, 9];
      for (const slot_level of slots) {
        const r = castSpell(mage(20), s, targets, { slot_level, rng: seededRng(s.level) });
        expect(r.targets.length, s.id).toBeGreaterThanOrEqual(count);
      }
    }
  });

  it("Fire Bolt: a ranged spell attack for 1d10 Fire, more dice at 5, 11 and 17", () => {
    const r = castSpell(mage(), spell("fire-bolt"), [creature()], { rng: scriptedRng([7, 6]) });
    expect(r).toMatchObject({ slot_level: null, attack_bonus: 5, caster_actions: [] });
    expect(r.targets[0]).toMatchObject({
      attack: { total: 12, hit: true, critical_hit: false },
      instances: [{ amount: 6, type: "fire" }],
      actions: [{ type: "damage", instances: [{ amount: 6, type: "fire" }], critical: false }],
    });
    const at5 = castSpell(mage(5), spell("fire-bolt"), [creature()], {
      rng: scriptedRng([15, 3, 4]),
    });
    expect(at5.targets[0]?.instances).toEqual([{ amount: 7, type: "fire" }]);
    expect([1, 4, 5, 10, 11, 16, 17, 20].map(cantripTier)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it("Fire Bolt: a natural 20 doubles the dice, a natural 1 misses", () => {
    const crit = castSpell(mage(), spell("fire-bolt"), [creature({ armor_class: 30 })], {
      rng: scriptedRng([20, 2, 9]),
    });
    expect(crit.targets[0]).toMatchObject({ critical: true, instances: [{ amount: 11 }] });
    const miss = castSpell(mage(), spell("fire-bolt"), [creature({ armor_class: 1 })], {
      rng: scriptedRng([1]),
    });
    expect(miss.targets[0]).toMatchObject({ attack: { hit: false }, instances: [], actions: [] });
  });

  it("Acid Splash: a Dexterity save or 1d6 Acid, nothing on a success", () => {
    const r = castSpell(mage(), spell("acid-splash"), [creature(), creature()], {
      rng: scriptedRng([18, 2, 4]), // saves 18 and 2 against DC 13, then the damage
    });
    expect(r.save_dc).toBe(13);
    expect(r.targets.map((t) => [t.save?.success, t.instances])).toEqual([
      [true, []],
      [false, [{ amount: 4, type: "acid" }]],
    ]);
  });

  it("Eldritch Blast: one attack per beam (three at level 11)", () => {
    const r = castSpell(mage(11), spell("eldritch-blast"), [creature()], {
      rng: scriptedRng([15, 10, 1, 15, 5]),
    });
    expect(r.targets.map((t) => [t.target, t.attack?.hit, t.instances])).toEqual([
      [0, true, [{ amount: 10, type: "force" }]],
      [0, false, []],
      [0, true, [{ amount: 5, type: "force" }]],
    ]);
    expect(() => castSpell(mage(11), spell("eldritch-blast"), [creature(), creature()])).toThrow(
      /3 beams: give 1 target or 3/,
    );
  });

  it("Fireball: 8d6 Fire, +1d6 per slot above 3, half on a success", () => {
    const dice = [6, 6, 6, 6, 6, 6, 6, 6, 6, 1]; // 10d6 = 55
    const r = castSpell(mage(), spell("fireball"), [creature(), creature()], {
      slot_level: 5,
      rng: scriptedRng([20, 1, ...dice]),
    });
    expect(r.damage?.parts[0]).toMatchObject({ dice: "10d6", total: 55 });
    expect(r.targets.map((t) => t.instances)).toEqual([
      [{ amount: 27, type: "fire" }],
      [{ amount: 55, type: "fire" }],
    ]);
    expect(r.caster_actions).toEqual([{ type: "spend_slot", level: 5 }]);
  });

  it("Ice Storm: two damage types, halved separately; the upcast adds Bludgeoning dice", () => {
    const r = castSpell(mage(), spell("ice-storm"), [creature()], {
      slot_level: 5,
      rng: scriptedRng([20, 5, 5, 5, 3, 3, 3, 3]),
    });
    expect(r.damage?.parts.map((p) => [p.dice, p.total])).toEqual([
      ["3d10", 15],
      ["4d6", 12],
    ]);
    expect(r.targets[0]?.instances).toEqual([
      { amount: 7, type: "bludgeoning" },
      { amount: 6, type: "cold" },
    ]);
  });

  it("Burning Hands, Inflict Wounds and Guiding Bolt upcast their dice", () => {
    const parts = (id: string, slot: number, rolls: number[]) =>
      castSpell(mage(), spell(id), [creature()], { slot_level: slot, rng: scriptedRng(rolls) })
        .targets[0]?.instances;
    expect(parts("burning-hands", 1, [1, 2, 2, 2])).toEqual([{ amount: 6, type: "fire" }]);
    expect(parts("inflict-wounds", 2, [1, 1, 1, 1])).toEqual([{ amount: 3, type: "necrotic" }]);
    const bolt = castSpell(mage(), spell("guiding-bolt"), [creature()], {
      slot_level: 3,
      rng: scriptedRng([15, 1, 1, 1, 1, 1, 1]),
    });
    expect(bolt.targets[0]?.instances).toEqual([{ amount: 6, type: "radiant" }]); // 6d6
  });

  it("Cure Wounds and Healing Word: dice plus the spellcasting modifier", () => {
    const cure = castSpell(mage(), spell("cure-wounds"), [creature()], {
      slot_level: 2,
      rng: scriptedRng([1, 2, 3, 4]),
    });
    expect(cure.targets[0]).toMatchObject({ healing: 13, actions: [{ type: "heal", amount: 13 }] });
    const word = castSpell(mage(), spell("healing-word"), [creature()], {
      rng: scriptedRng([4, 4]),
    });
    expect(word.targets[0]?.healing).toBe(11);
  });

  it("Hold Person: Paralyzed on a failed Wisdom save, one more target per slot level", () => {
    const r = castSpell(mage(), spell("hold-person"), [creature(), creature()], {
      slot_level: 3,
      rng: scriptedRng([2, 19]),
    });
    expect(r.targets.map((t) => t.conditions)).toEqual([["paralyzed"], []]);
    expect(r.targets[0]?.actions).toEqual([{ type: "add_condition", condition: "paralyzed" }]);
    expect(r.caster_actions).toEqual([
      { type: "spend_slot", level: 3 },
      { type: "set_concentration", spell: "Hold Person" },
    ]);
    expect(() =>
      castSpell(mage(), spell("hold-person"), [creature(), creature()], { slot_level: 2 }),
    ).toThrow(/at most 1/);
  });
});

describe("parsed and corrected spells", () => {
  it("Hideous Laughter gives both Prone and Incapacitated", () => {
    const r = castSpell(mage(), spell("hideous-laughter"), [creature()], { rng: scriptedRng([1]) });
    expect(r.targets[0]?.conditions).toEqual(["prone", "incapacitated"]);
  });

  it("Hypnotic Pattern also gives Incapacitated (while Charmed)", () => {
    const r = castSpell(mage(), spell("hypnotic-pattern"), [creature()], { rng: scriptedRng([1]) });
    expect(r.targets[0]?.conditions).toEqual(["charmed", "incapacitated"]);
  });

  it("Mass Cure Wounds heals up to six creatures", () => {
    const six = Array.from({ length: 6 }, () => creature());
    const r = castSpell(mage(), spell("mass-cure-wounds"), six, { rng: seededRng(1) });
    expect(new Set(r.targets.map((t) => t.healing)).size).toBe(1); // rolled once
    expect(() => castSpell(mage(), spell("mass-cure-wounds"), [...six, creature()])).toThrow(
      /at most 6/,
    );
  });

  it("Weird deals only its first 10d10 when cast", () => {
    expect(spell("weird").mechanics?.damage).toEqual([
      { dice: "10d10", type: "psychic", add_modifier: false },
    ]);
  });

  it("Starry Wisp doesn't make its target Invisible", () => {
    expect(spell("starry-wisp").mechanics?.conditions).toEqual([]);
  });

  it("rejected drafts stay text", () => {
    expect(spell("holy-aura").mechanics).toBeNull();
    expect(spell("produce-flame").mechanics).toBeNull();
    expect(spell("contact-other-plane").mechanics).toBeNull();
  });
});

describe("castSpell", () => {
  it("previews damage against the target's defenses", () => {
    const resistant = creature({
      defenses: { resistances: ["fire"], vulnerabilities: [], immunities: [] },
    });
    const r = castSpell(mage(), spell("fire-bolt"), [resistant], { rng: scriptedRng([15, 9]) });
    expect(r.targets[0]?.outcome).toMatchObject({ dealt: 4, hp: 36 });
  });

  it("uses the spellcasting feature whose list has the spell, or the one asked for", () => {
    const cleric = { ...wizardLine, source: "Cleric", list: "cleric", save_dc: 16 };
    const both = creature({ spellcasting: [cleric, wizardLine] });
    expect(castSpell(both, spell("fireball"), [], { rng: scriptedRng([]) }).save_dc).toBe(13);
    const forced = castSpell(both, spell("fireball"), [], { spellcasting: "Cleric" });
    expect(forced.spellcasting).toBe("Cleric");
    expect(() => castSpell(both, spell("fireball"), [], { spellcasting: "Bard" })).toThrow(
      /no spellcasting from 'Bard'/,
    );
  });

  it("refuses illegal slots and casters without Spellcasting", () => {
    expect(() => castSpell(mage(), spell("fire-bolt"), [], { slot_level: 1 })).toThrow(/cantrip/);
    expect(() => castSpell(mage(), spell("fireball"), [], { slot_level: 2 })).toThrow(/level 3/);
    expect(() => castSpell(creature(), spell("fireball"), [])).toThrow(/no spellcasting/);
  });

  it("casts a spell without mechanics: the slot and a note", () => {
    const r = castSpell(mage(), spell("mage-armor"), [], { pact: true });
    expect(r.caster_actions).toEqual([{ type: "spend_pact_slot" }]);
    expect(r.notes[0]).toMatch(/effects aren't automated/);
  });
});

describe("POST /v1/state/cast", () => {
  it("spends the caster's slot and applies the effects to the targets' states", async () => {
    let wizard = classBuild("wizard", { name: "Ilse" });
    wizard = apply(wizard, svc.setChoice, "class:wizard#cantrips", [
      "fire-bolt",
      "light",
      "mage-hand",
    ]);
    wizard = autocomplete(wizard);
    const book = wizard.choices["class:wizard#spellbook"] ?? [];
    const spellbook = ["burning-hands", ...book.filter((s) => s !== "burning-hands")].slice(0, 6);
    wizard = apply(wizard, svc.setChoice, "class:wizard#spellbook", spellbook);
    wizard = autocomplete(wizard);
    const prepared = wizard.choices["class:wizard#prepared"] ?? [];
    wizard = apply(wizard, svc.setChoice, "class:wizard#prepared", [
      "burning-hands",
      ...prepared.filter((s) => s !== "burning-hands").slice(0, 3),
    ]);
    const handler = createHandler({ rng: scriptedRng([1, 3, 3, 3]) });
    const post = async (path: string, body: unknown) => {
      const res = await handler(
        new Request(`http://test${path}`, { method: "POST", body: JSON.stringify(body) }),
      );
      return { status: res.status, body: await res.json() };
    };
    const state = (await post("/v1/state/new", { build: wizard })).body;
    const caster = { build: wizard, state };
    const cast = await post("/v1/state/cast", {
      caster,
      spell: "burning-hands",
      targets: [caster],
    });
    expect(cast.status).toBe(200);
    expect(cast.body.caster_state.spell_slots_spent).toEqual([1]);
    expect(cast.body.result.targets[0].instances).toEqual([{ amount: 9, type: "fire" }]);
    expect(cast.body.target_states[0].hp.current).toBeLessThan(state.hp.current ?? 99);
    const unknown = await post("/v1/state/cast", { caster, spell: "fireball", targets: [] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.detail[0]).toBe("Ilse can't cast Fireball");
  });
});
