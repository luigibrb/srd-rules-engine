import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyEncounterAction,
  type CharacterBuild,
  type CharacterState,
  type CombatantOptions,
  checkAction,
  combatantOptions,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  EncounterError,
  type OptionEntry,
  scriptedRng,
  seededRng,
} from "../src/index";
import * as svc from "../src/services/builder";
import { apply, autocomplete, catalog, classBuild, fighterBuild, levelUpIn } from "./helpers";

// What a combatant can do now: options built from the engine's own refusals (`checkAction`).

const level = (classId: string, n: number, name: string) =>
  levelUpIn(autocomplete(classBuild(classId, { name })), classId, n - 1);

/** A fighter with these masteries and weapons. */
const armed = (masteries: string[], build = fighterBuild()) =>
  apply(build, svc.setChoice, "class:fighter#weapon_mastery", masteries);

/**
 * Characters, then monsters, in Initiative order (characters first); positions when given.
 * `items` adds weapons to a character's state.
 */
function session(
  builds: Record<string, CharacterBuild>,
  monsters: { monster: string; at?: [number, number] }[],
  at: Record<string, [number, number]> = {},
  items: Record<string, string[]> = {},
) {
  const states: Record<string, CharacterState> = {};
  for (const [k, b] of Object.entries(builds)) {
    let state = createState(b, catalog);
    for (const item of items[k] ?? []) {
      state = applyAction(b, state, catalog, { type: "add_item", item }).state;
    }
    states[k] = state;
  }
  let encounter: Encounter = createEncounter();
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
    }
  };
  const keys = Object.keys(builds);
  const seen = new Map<string, number>();
  const monsterIds = monsters.map(({ monster }) => {
    const n = (seen.get(monster) ?? 0) + 1;
    seen.set(monster, n);
    return n === 1 ? monster : `${monster}-${n}`;
  });
  const ids = [...keys, ...monsterIds];
  act(
    [],
    ...keys.map((character) => ({ type: "add_character", character, side: "party" }) as const),
    ...monsters.map((m) => ({ type: "add_monster", monster: m.monster, side: "enemies" }) as const),
    ...keys.flatMap((id) =>
      at[id] ? [{ type: "place", id, x: at[id][0], y: at[id][1] } as const] : [],
    ),
    ...monsters.flatMap((m, i) =>
      m.at ? [{ type: "place", id: monsterIds[i] as string, x: m.at[0], y: m.at[1] } as const] : [],
    ),
    ...ids.map((id, i) => ({ type: "set_initiative", id, value: 20 - i }) as const),
    { type: "start" },
  );
  return {
    act,
    states,
    ctx,
    encounter: () => encounter,
    options: (id: string) => combatantOptions(encounter, id, ctx()),
  };
}

const next = { type: "next_turn" } as const;
/** Every option of a kind, by label. */
const all = (o: CombatantOptions): OptionEntry[] => [
  ...o.attacks,
  ...o.spells,
  ...o.features,
  ...o.save_actions,
  ...o.legendary,
  ...o.standard,
  ...o.zones,
];
const find = (entries: readonly OptionEntry[], label: string): OptionEntry => {
  const found = entries.find((x) => x.label.startsWith(label));
  if (!found) throw new Error(`no option '${label}' in ${entries.map((x) => x.label).join(", ")}`);
  return found;
};

describe("combatantOptions: a fighter's turn", () => {
  it("attack lines with labels, the Attack action's attacks, Extra Attack and Action Surge", () => {
    const brakka = levelUpIn(fighterBuild(), "fighter", 4); // level 5: Extra Attack
    const s = session({ brakka }, [{ monster: "goblin-warrior" }]);
    let o = s.options("brakka");
    expect(o).toMatchObject({ id: "brakka", turn: true, economy: { action: true, movement: 30 } });
    const sword = find(o.attacks, "Greatsword");
    expect(sword).toMatchObject({
      label: "Greatsword +6 · 2d6+3 slashing",
      cost: "attack",
      available: true,
      reason: null,
      action: { type: "attack", id: "brakka", attack: "Greatsword", target: "goblin-warrior" },
      targets: { kind: "creature", count: 1, range: 5, ids: ["goblin-warrior"] },
    });
    expect(find(o.features, "Action Surge")).toMatchObject({
      available: false,
      reason: "Take your action first: Action Surge gives one additional action",
    });
    s.act([2], sword.action);
    o = s.options("brakka");
    expect(o.economy).toMatchObject({ action: false, attacks_left: 1 });
    expect(find(o.attacks, "Greatsword").available).toBe(true);
    expect(find(o.standard, "Dash")).toMatchObject({
      available: false,
      reason: "Brakka has already used its action this turn",
    });
    s.act([2], sword.action);
    o = s.options("brakka");
    expect(find(o.attacks, "Greatsword")).toMatchObject({
      available: false,
      reason: "Brakka has no attacks left this turn",
    });
    expect(find(o.features, "Action Surge")).toMatchObject({ available: true, uses: { left: 1 } });
    s.act([], find(o.features, "Action Surge").action);
    expect(find(s.options("brakka").attacks, "Greatsword").available).toBe(true);
  });

  it("the Light extra attack (Nick: part of the Attack action) and Cleave after a hit", () => {
    const masteries = ["shortsword", "scimitar", "greataxe"];
    const s = session(
      { brakka: armed(masteries) },
      [
        { monster: "goblin-warrior", at: [1, 0] },
        { monster: "goblin-warrior", at: [1, 1] },
        { monster: "goblin-warrior", at: [5, 5] },
      ],
      { brakka: [0, 0] },
      { brakka: masteries },
    );
    let o = s.options("brakka");
    expect(o.attacks.some((x) => x.action.type === "attack" && x.action.light_extra)).toBe(false);
    s.act([15, 1], find(o.attacks, "Shortsword").action);
    o = s.options("brakka");
    expect(find(o.attacks, "Scimitar +5 · 1d6+3 slashing (Light extra attack)")).toMatchObject({
      cost: "attack", // Nick
      available: true,
    });
    expect(find(o.attacks, "Shortsword +5 · 1d6+3 piercing (Light")).toMatchObject({
      available: false,
      reason: "The extra attack must be made with a different Light weapon than Shortsword",
    });

    const t = session(
      { brakka: armed(masteries) },
      [
        { monster: "goblin-warrior", at: [1, 0] },
        { monster: "goblin-warrior", at: [1, 1] },
        { monster: "goblin-warrior", at: [5, 5] },
      ],
      { brakka: [0, 0] },
      { brakka: masteries },
    );
    t.act([15, 5], find(t.options("brakka").attacks, "Greataxe").action);
    o = t.options("brakka");
    expect(o.economy.cleave).toEqual({ attack: "Greataxe", target: "goblin-warrior" });
    expect(find(o.attacks, "Greataxe +5 · 1d12+3 slashing (Cleave)")).toMatchObject({
      cost: "free",
      available: true,
      targets: { ids: ["goblin-warrior-2"] },
      action: { cleave: true, target: "goblin-warrior-2" },
    });
  });
});

describe("combatantOptions: out of turn", () => {
  it("only reactions: an Opportunity Attack; the rest says whose turn it is", () => {
    const s = session({ brakka: fighterBuild() }, [{ monster: "goblin-warrior" }]);
    const o = s.options("goblin-warrior");
    expect(o.turn).toBe(false);
    const available = all(o).filter((x) => x.available);
    expect(available.map((x) => [x.label, x.cost])).toEqual([
      ["Scimitar +4 · 1d6+2 slashing (Opportunity Attack)", "reaction"],
    ]);
    expect(find(o.attacks, "Scimitar").reason).toBe(
      "It isn't Goblin Warrior's turn: only a reaction can attack",
    );
    expect(find(o.standard, "Dodge").reason).toBe(
      "It isn't Goblin Warrior's turn: only a reaction can Dodge",
    );
  });
});

describe("combatantOptions: spells", () => {
  it("slot levels left, a spent level gone, Concentration, a casting time of a minute", () => {
    const ilse = level("wizard", 3, "Ilse");
    const s = session({ ilse }, [{ monster: "goblin-warrior" }]);
    let o = s.options("ilse");
    const leveled = o.spells.filter((x) => x.action.type === "cast" && x.action.slot_level);
    expect(leveled.length).toBeGreaterThan(0);
    for (const x of leveled)
      expect(x.slot_levels).toEqual(x.label.includes("level 2") ? [2] : [1, 2]);
    const cantrip = o.spells.find((x) => x.label.includes("cantrip")) as OptionEntry;
    expect(cantrip.slot_levels).toEqual([]);
    // Spend every level 1 slot (4 at Wizard 3): level 1 spells move up to level 2 slots.
    const ref = { build: ilse, state: s.states.ilse as CharacterState };
    let state = ref.state;
    for (let i = 0; i < 4; i++) {
      state = applyAction(ilse, state, catalog, { type: "spend_slot", level: 1 }).state;
    }
    s.states.ilse = state;
    o = s.options("ilse");
    const first = o.spells.find((x) => x.label.includes("level 1") && x.available) as OptionEntry;
    expect(first.slot_levels).toEqual([2]);
    expect(first.action).toMatchObject({ slot_level: 2 });
    // A spell that takes a minute is listed, refused in the engine's words.
    expect(find(o.spells, "Alarm")).toMatchObject({
      available: false,
      reason: "Alarm takes 1 minute to cast: not in combat",
    });
    expect(find(o.spells, "Dancing Lights").note).toBeNull();
    // Concentrating: another Concentration spell says it would end it.
    s.states.ilse = { ...state, concentration: "Bless" };
    o = s.options("ilse");
    expect(find(o.spells, "Dancing Lights").note).toBe("Casting it ends Concentration on Bless");
    expect(find(o.spells, "Burning Hands").note).toBeNull();
  });

  it("no slot left: refused by the play state", () => {
    const ilse = autocomplete(classBuild("wizard", { name: "Ilse" }));
    const s = session({ ilse }, [{ monster: "goblin-warrior" }]);
    let state = s.states.ilse as CharacterState;
    for (let i = 0; i < 2; i++) {
      state = applyAction(ilse, state, catalog, { type: "spend_slot", level: 1 }).state;
    }
    s.states.ilse = state;
    const spell = s
      .options("ilse")
      .spells.find((x) => x.label.includes("level 1") && !x.reason?.includes("minute"));
    expect(spell).toMatchObject({
      available: false,
      slot_levels: [],
      reason: "Ilse: No level 1 spell slots left",
    });
  });
});

describe("combatantOptions: monsters", () => {
  it("a Recharge not ready, daily spell uses, legendary actions and their uses", () => {
    const s = session({ brakka: fighterBuild() }, [
      { monster: "adult-red-dragon" },
      { monster: "mage" },
    ]);
    s.act([], next); // the dragon's turn
    let o = s.options("adult-red-dragon");
    const breath = find(o.save_actions, "Fire Breath");
    expect(breath).toMatchObject({
      cost: "action",
      available: true,
      targets: { kind: "area", area: { shape: "cone" } },
      action: { type: "save_action", ability: "Fire Breath", targets: [] },
    });
    expect(find(o.legendary, "Pounce")).toMatchObject({
      available: false,
      reason:
        "Adult Red Dragon takes legendary actions after another creature's turn, not on its own",
    });
    s.act([1, 1, 1, 1, 1, 1, 1, 1], breath.action, next); // the mage's turn
    o = s.options("adult-red-dragon");
    expect(find(o.save_actions, "Fire Breath")).toMatchObject({
      available: false,
      reason: "Adult Red Dragon's Fire Breath hasn't recharged",
    });
    expect(o.economy.legendary).toEqual({ left: 3, max: 3 });
    const pounce = find(o.legendary, "Pounce");
    expect(pounce).toMatchObject({
      cost: "legendary",
      available: true,
      uses: { left: 3, max: 3 },
      action: { type: "legendary", action: "Pounce", target: "brakka" },
    });
    const rays = find(o.legendary, "Fiery Rays");
    s.act([1, 1, 1, 1, 1, 1, 1, 1, 1, 1], rays.action); // the rays miss
    o = s.options("adult-red-dragon");
    expect(find(o.legendary, "Fiery Rays")).toMatchObject({
      available: false,
      reason: "Adult Red Dragon can't take Fiery Rays again until the start of its next turn",
      uses: { left: 2, max: 3 },
    });

    const mage = s.options("mage");
    const fly = find(mage.spells, "Fly");
    expect(fly).toMatchObject({ uses: { left: 1, max: 1 }, available: true });
    s.act([10, 10, 10, 10], { ...fly.action, targets: ["mage"] } as EncounterAction);
    expect(find(s.options("mage").spells, "Fly")).toMatchObject({
      available: false,
      uses: { left: 0, max: 1 },
    });
    expect(find(s.options("mage").spells, "Fireball")).toMatchObject({
      slot_levels: [4],
      label: "Fireball (level 4)",
      note: null,
    });
    expect(find(s.options("mage").spells, "Invisibility").note).toBe(
      "Casting it ends Concentration on Fly",
    );
  });
});

describe("combatantOptions: conditions", () => {
  it("Incapacitated, Restrained (no movement) and Prone (stand up)", () => {
    const s = session({ brakka: fighterBuild() }, [{ monster: "goblin-warrior" }]);
    const cond = (condition: string) =>
      ({
        type: "effects",
        id: "brakka",
        actions: [{ type: "add_condition", condition }],
      }) as EncounterAction;
    s.act([], cond("prone"));
    let o = s.options("brakka");
    expect(find(o.standard, "Stand up")).toMatchObject({ cost: "movement", available: true });
    s.act([], cond("restrained"));
    o = s.options("brakka");
    expect(o.economy.movement).toBe(0);
    expect(find(o.standard, "Move")).toMatchObject({
      available: false,
      reason: "Brakka has no movement left this turn",
    });
    expect(find(o.standard, "Stand up").reason).toBe("Brakka can't right itself at Speed 0");
    s.act([], cond("stunned"));
    o = s.options("brakka");
    expect(find(o.attacks, "Greatsword").reason).toBe("Brakka is Incapacitated");
    expect(find(o.standard, "Dodge").reason).toBe("Brakka is Incapacitated");
  });
});

describe("combatantOptions: positions", () => {
  it("targets within reach or range only, nearest first; none in reach is said", () => {
    const s = session(
      { brakka: fighterBuild() },
      [
        { monster: "goblin-warrior", at: [6, 0] },
        { monster: "goblin-warrior", at: [2, 0] },
      ],
      { brakka: [0, 0] },
    );
    const o = s.options("brakka");
    expect(find(o.attacks, "Greatsword")).toMatchObject({
      available: false,
      reason: "Goblin Warrior 2 is 10 feet away: out of Greatsword's reach (5 ft)",
      targets: { ids: [] },
      action: { target: "" },
    });
    expect(find(o.attacks, "Javelin +5 · 1d6+3 piercing (thrown")).toMatchObject({
      available: true,
      targets: { range: 120, ids: ["goblin-warrior-2", "goblin-warrior"] },
    });
    expect(find(o.standard, "Move")).toMatchObject({
      action: { type: "move", to: { x: 0, y: 0 } },
      targets: { kind: "point", range: 30 },
    });
  });

  it("positions required: off the map, an attack is refused, here and in checkAction", () => {
    const s = session({ brakka: fighterBuild() }, [{ monster: "goblin-warrior", at: [1, 0] }]);
    const attack = {
      type: "attack",
      id: "brakka",
      target: "goblin-warrior",
      attack: "Greatsword",
    } as const;
    // Optional (the default): the distance is unknown and the attack passes.
    expect(checkAction(s.encounter(), attack, s.ctx()).ok).toBe(true);
    s.act([], { type: "set_positions", mode: "required" });
    expect(s.encounter().positions).toBe("required");
    const offMap = { code: "refusal.off_map", params: { name: "Brakka" } };
    expect(checkAction(s.encounter(), attack, s.ctx())).toEqual({
      ok: false,
      reasons: ["Brakka isn't on the map"],
      codes: ["off_map"],
      reason_messages: [{ ...offMap, text: "Brakka isn't on the map" }],
    });
    const help = { type: "help", id: "brakka", target: "goblin-warrior" } as const;
    expect(checkAction(s.encounter(), help, s.ctx()).codes).toEqual(["off_map"]);
    expect(find(s.options("brakka").attacks, "Greatsword")).toMatchObject({
      available: false,
      reason: "Brakka isn't on the map",
      code: "off_map",
      reason_message: offMap,
    });
    expect(() =>
      applyEncounterAction(s.encounter(), attack, { ...s.ctx(), rng: scriptedRng([15, 4]) }),
    ).toThrow("Brakka isn't on the map");
    // Placed, against a goblin off the map: refused too.
    s.act([], { type: "place", id: "brakka", x: 0, y: 0 });
    s.act([], { type: "remove", id: "goblin-warrior" });
    s.act([], { type: "add_monster", monster: "goblin-warrior", side: "enemies" });
    const target = { ...attack, target: "goblin-warrior" };
    expect(checkAction(s.encounter(), target, s.ctx()).reasons).toEqual([
      "Goblin Warrior isn't on the map",
    ]);
  });

  it("positions required with nobody on the map changes nothing", () => {
    const s = session({ brakka: fighterBuild() }, [{ monster: "goblin-warrior" }]);
    s.act([], { type: "set_positions", mode: "required" });
    const attack = {
      type: "attack",
      id: "brakka",
      target: "goblin-warrior",
      attack: "Greatsword",
    } as const;
    expect(checkAction(s.encounter(), attack, s.ctx()).ok).toBe(true);
  });
});

describe("checkAction", () => {
  it("agrees with applyEncounterAction on every option, and changes nothing", () => {
    const masteries = ["shortsword", "scimitar", "greataxe"];
    const s = session(
      { brakka: armed(masteries), ilse: level("wizard", 3, "Ilse") },
      [
        { monster: "goblin-warrior", at: [1, 0] },
        { monster: "adult-red-dragon", at: [4, 4] },
      ],
      { brakka: [0, 0], ilse: [0, 3] },
      { brakka: masteries },
    );
    const before = JSON.stringify(s.encounter());
    let checked = 0;
    for (let turn = 0; turn < 4; turn++) {
      for (const id of ["brakka", "ilse", "goblin-warrior", "adult-red-dragon"]) {
        for (const x of all(s.options(id))) {
          const verdict = checkAction(s.encounter(), x.action, s.ctx());
          let applied = true;
          try {
            applyEncounterAction(s.encounter(), x.action, { ...s.ctx(), rng: seededRng(7) });
          } catch (error) {
            if (!(error instanceof EncounterError)) throw error;
            applied = false;
          }
          expect(verdict.ok, `${id}: ${x.label}`).toBe(applied);
          if (x.available) expect(verdict.ok, x.label).toBe(true);
          checked++;
        }
      }
      if (turn === 0)
        s.act([15, 5], {
          type: "attack",
          id: "brakka",
          target: "goblin-warrior",
          attack: "Greataxe",
        });
      s.act([3, 3, 3, 3], next);
    }
    expect(checked).toBeGreaterThan(100);
    expect(JSON.stringify(s.encounter())).not.toBe(before); // the turns moved on, not the checks
    expect(
      checkAction(
        s.encounter(),
        { type: "attack", id: "nobody", target: "x", attack: "y" },
        s.ctx(),
      ),
    ).toEqual({
      ok: false,
      reasons: ["No combatant 'nobody' in the encounter"],
      codes: ["unknown"],
      reason_messages: [
        {
          code: "refusal.no_combatant_encounter",
          params: { id: "nobody" },
          text: "No combatant 'nobody' in the encounter",
        },
      ],
    });
  });

  it("an action that stops for a decision counts as allowed", () => {
    const s = session({ brakka: fighterBuild() }, [{ monster: "goblin-warrior" }]);
    s.act([], { type: "set_decisions", mode: "ask" });
    // Brakka holds a Bardic Inspiration die: a failed check asks whether to add it.
    const encounter: Encounter = {
      ...s.encounter(),
      combatants: s
        .encounter()
        .combatants.map((c) =>
          c.id === "brakka" ? { ...c, inspiration: { die: 8, by: "x" } } : c,
        ),
    };
    const check: EncounterAction = { type: "check", id: "brakka", skill: "athletics", dc: 25 };
    const r = applyEncounterAction(encounter, check, { ...s.ctx(), rng: scriptedRng([10]) });
    expect(r.pending?.kind).toBe("inspiration");
    expect(checkAction(encounter, check, s.ctx())).toEqual({
      ok: true,
      reasons: [],
      codes: [],
      reason_messages: [],
    });
  });

  it("ten combatants' options stay quick", () => {
    const s = session(
      { brakka: fighterBuild(), ilse: level("wizard", 5, "Ilse") },
      Array.from({ length: 8 }, (_, i) => ({
        monster: "goblin-warrior",
        at: [i + 1, 2] as [number, number],
      })),
      { brakka: [0, 0], ilse: [0, 4] },
    );
    const ids = s.encounter().combatants.map((c) => c.id);
    const start = performance.now();
    for (const id of ids) s.options(id);
    const ms = (performance.now() - start) / ids.length;
    expect(ms).toBeLessThan(200);
  });
});
