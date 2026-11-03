import { describe, expect, it } from "vitest";
import {
  applyEncounterAction,
  type CharacterBuild,
  type CharacterState,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  resolve,
  scriptedRng,
} from "../src/index";
import * as svc from "../src/services/builder";
import { speedOf } from "../src/services/encounter";
import { autocomplete, catalog, classBuild, fighterBuild } from "./helpers";

// What a spell's hit does besides damage (SRD 5.2.1 "Spells"): Shocking Grasp ("it can't make
// Opportunity Attacks until the start of its next turn"), Ray of Frost ("its Speed is reduced by
// 10 feet until the start of your next turn"), Chill Touch ("it can't regain Hit Points until the
// end of your next turn"), and Chromatic Orb's damage type, chosen when casting.

/** Ilse, a level 1 wizard with these cantrips and Chromatic Orb prepared. */
function ilse(): CharacterBuild {
  let b = autocomplete(classBuild("wizard", { name: "Ilse" }));
  const set = (kind: string, ids: string[]) => {
    const res = resolve(b, catalog);
    const choice = res.choices.find((c) => c.key === `class:wizard#${kind}`);
    if (!choice) throw new Error(`no ${kind}`);
    const others = res.selected(choice).filter((x) => !ids.includes(x));
    b = svc.setChoice(b, catalog, choice.key, [
      ...ids,
      ...others.slice(0, Math.max(0, res.required(choice) - ids.length)),
    ]).build;
    b = autocomplete(b);
  };
  set("cantrips", ["ray-of-frost", "shocking-grasp", "chill-touch"]);
  set("spellbook", ["chromatic-orb"]);
  set("prepared", ["chromatic-orb"]);
  return b;
}

function session() {
  const builds: Record<string, CharacterBuild> = { ilse: ilse(), brakka: fighterBuild() };
  const states: Record<string, CharacterState> = Object.fromEntries(
    Object.entries(builds).map(([k, b]) => [k, createState(b, catalog)]),
  );
  let encounter: Encounter = createEncounter();
  const notes: string[] = [];
  const ctx = () => ({
    catalog,
    characters: Object.fromEntries(
      Object.entries(builds).map(([k, build]) => [
        k,
        { build, state: states[k] as CharacterState },
      ]),
    ),
  });
  const act = (rolls: number[], ...actions: EncounterAction[]) => {
    for (const action of actions) {
      const r = applyEncounterAction(encounter, action, { ...ctx(), rng: scriptedRng(rolls) });
      encounter = r.encounter;
      Object.assign(states, r.states);
      notes.push(...r.notes);
    }
  };
  act(
    [],
    { type: "add_character", character: "ilse" },
    { type: "add_character", character: "brakka" },
    { type: "add_monster", monster: "goblin-warrior", side: "enemies" },
    { type: "set_initiative", id: "ilse", value: 20 },
    { type: "set_initiative", id: "goblin-warrior", value: 15 },
    { type: "set_initiative", id: "brakka", value: 10 },
    { type: "start" },
  );
  const goblin = () => encounter.combatants.find((c) => c.id === "goblin-warrior");
  return {
    act,
    notes,
    goblin,
    speed: () => speedOf(ctx(), goblin() as never, encounter),
    encounter: () => encounter,
  };
}

const cast = (spell: string, extra: Partial<Extract<EncounterAction, { type: "cast" }>> = {}) =>
  ({ type: "cast", id: "ilse", spell, targets: ["goblin-warrior"], ...extra }) as EncounterAction;
const next = { type: "next_turn" } as const;

describe("hit riders", () => {
  it("Ray of Frost: 10 feet less Speed until the start of the caster's next turn", () => {
    const s = session();
    expect(s.speed()).toBe(30);
    s.act([18, 1], cast("ray-of-frost"));
    expect(s.speed()).toBe(20);
    expect(s.notes).toContain(
      "Goblin Warrior's Speed is 10 feet lower until the start of the caster's next turn (Ray of Frost).",
    );
    s.act([], next, next); // the goblin's turn, Brakka's
    expect(s.speed()).toBe(20);
    s.act([], next); // Ilse's turn starts: it ends
    expect(s.speed()).toBe(30);
  });

  it("Shocking Grasp: no Opportunity Attacks until the start of the target's next turn", () => {
    const s = session();
    s.act([18, 1], cast("shocking-grasp"));
    const oa: EncounterAction = {
      type: "attack",
      id: "goblin-warrior",
      target: "ilse",
      attack: "Scimitar",
      opportunity: true,
    };
    expect(() => s.act([15, 3], oa)).toThrow("can't make Opportunity Attacks");
    s.act([], next); // the goblin's turn: the mark ends
    expect(s.encounter().marks).toEqual([]);
  });

  it("Chill Touch: no healing until the end of the caster's next turn", () => {
    const s = session();
    s.act([18, 1], cast("chill-touch"));
    const heal: EncounterAction = {
      type: "effects",
      id: "goblin-warrior",
      actions: [{ type: "heal", amount: 5 }],
    };
    const hp = s.goblin()?.hp;
    s.act([], heal);
    expect(s.goblin()?.hp).toBe(hp);
    expect(s.notes).toContain("Goblin Warrior can't regain Hit Points (Chill Touch).");
    s.act([], next, next, next, next); // through Ilse's next turn, to the goblin's
    s.act([], heal);
    expect(s.goblin()?.hp).toBe(10); // healed again, up to its 10 Hit Points
  });
});

describe("Chromatic Orb", () => {
  it("deals the damage type chosen when casting; asks for one", () => {
    const s = session();
    expect(() => s.act([18, 1, 1, 1], cast("chromatic-orb"))).toThrow(/Chromatic Orb/);
    s.act([18, 2, 3, 4], cast("chromatic-orb", { damage_type: "thunder" }));
    expect(s.notes.some((n) => /\b9 thunder\b/i.test(n))).toBe(true);
  });
});

describe("Ensnaring Strike", () => {
  // "immediately after hitting a creature with a weapon … On a failed save, the target has the
  // Restrained condition until the spell ends."
  it("restrains the creature a weapon hit, on a failed Strength save", () => {
    let wren = autocomplete(classBuild("ranger", { name: "Wren" }));
    const res = resolve(wren, catalog);
    const prepared = res.choices.find((c) => c.key === "class:ranger#prepared");
    if (!prepared) throw new Error("no prepared spells");
    const others = res.selected(prepared).filter((x) => x !== "ensnaring-strike");
    wren = svc.setChoice(wren, catalog, prepared.key, [
      "ensnaring-strike",
      ...others.slice(0, res.required(prepared) - 1),
    ]).build;
    wren = autocomplete(wren);
    let state = createState(wren, catalog);
    let e: Encounter = createEncounter();
    const act = (rolls: number[], ...actions: EncounterAction[]) => {
      for (const action of actions) {
        const r = applyEncounterAction(e, action, {
          catalog,
          characters: { wren: { build: wren, state } },
          rng: scriptedRng(rolls),
        });
        e = r.encounter;
        state = r.states.wren ?? state;
      }
    };
    act(
      [],
      { type: "add_character", character: "wren" },
      { type: "add_monster", monster: "goblin-warrior", side: "enemies" },
      { type: "set_initiative", id: "wren", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 10 },
      { type: "start" },
    );
    expect(() =>
      act([2], {
        type: "cast",
        id: "wren",
        spell: "ensnaring-strike",
        targets: ["goblin-warrior"],
      }),
    ).toThrow("is cast right after Wren hits a creature");
    act([18, 1], { type: "attack", id: "wren", target: "goblin-warrior", attack: "Longbow" });
    act([2], { type: "cast", id: "wren", spell: "ensnaring-strike", targets: ["goblin-warrior"] });
    const goblin = e.combatants.find((c) => c.id === "goblin-warrior");
    expect(goblin?.conditions).toContain("restrained");
  });
});
