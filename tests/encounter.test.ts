import { describe, expect, it } from "vitest";
import { createHandler } from "../src/http/index";
import {
  applyEncounterAction,
  type CharacterState,
  computePlaySheet,
  createEncounter,
  createState,
  currentCombatant,
  type Encounter,
  type EncounterAction,
  EncounterError,
  encounterCombatant,
  makeAttack,
  scriptedRng,
} from "../src/index";
import { catalog, fighterBuild } from "./helpers";

const fighter = fighterBuild(); // Brakka: Initiative +2, AC 17, 12 HP, Speed 30

/** Apply actions in order, keeping Brakka's state up to date. */
function run(
  start: Encounter,
  actions: EncounterAction[],
  {
    rolls = [],
    state = createState(fighter, catalog),
  }: { rolls?: number[]; state?: CharacterState } = {},
) {
  let encounter = start;
  let brakka = state;
  const notes: string[] = [];
  const rng = scriptedRng(rolls);
  for (const action of actions) {
    const characters = { brakka: { build: fighter, state: brakka } };
    const r = applyEncounterAction(encounter, action, { catalog, characters, rng });
    encounter = r.encounter;
    brakka = r.states.brakka ?? brakka;
    notes.push(...r.notes);
  }
  return { encounter, brakka, notes };
}

const setup: EncounterAction[] = [
  { type: "add_character", character: "brakka" },
  { type: "add_monster", monster: "goblin-warrior" },
  { type: "add_monster", monster: "goblin-warrior" },
  { type: "add_monster", monster: "skeleton" },
];
/** Brakka 12 + 2 = 14, goblins (one group roll) 12 + 2 = 14, skeleton 5 + 3 = 8. */
const fight = () =>
  run(createEncounter(), [...setup, { type: "roll_initiative", group: true }, { type: "start" }], {
    rolls: [12, 12, 5],
  });

describe("setting up", () => {
  it("adds monsters with their average HP, numbered, and characters by key", () => {
    const { encounter, notes } = run(createEncounter(), setup);
    expect(encounter.combatants.map((c) => [c.id, c.name, c.hp, c.side])).toEqual([
      ["brakka", "Brakka", null, "party"],
      ["goblin-warrior", "Goblin Warrior", 10, ""],
      ["goblin-warrior-2", "Goblin Warrior 2", 10, ""],
      ["skeleton", "Skeleton", 13, ""],
    ]);
    expect(notes).toContain("Goblin Warrior 2 joins with 10 HP.");
  });

  it("rolls a monster's Hit Dice when asked", () => {
    const { encounter } = run(
      createEncounter(),
      [{ type: "add_monster", monster: "goblin-warrior", roll_hp: true }],
      { rolls: [1, 2, 3] },
    );
    expect(encounter.combatants[0]?.hp).toBe(6); // 3d6
  });

  it("refuses unknown monsters and characters that weren't given", () => {
    expect(() =>
      run(createEncounter(), [{ type: "add_monster", monster: "tarrasque-jr" }]),
    ).toThrow("Unknown monster 'tarrasque-jr'");
    expect(() => run(createEncounter(), [{ type: "add_character", character: "nobody" }])).toThrow(
      EncounterError,
    );
  });
});

describe("Initiative", () => {
  it("d20 + Initiative bonus; identical monsters share a roll; surprise is Disadvantage", () => {
    const { encounter } = run(
      createEncounter(),
      [...setup, { type: "roll_initiative", group: true, surprised: ["skeleton"] }],
      { rolls: [12, 12, 15, 5] },
    );
    expect(encounter.combatants.map((c) => c.initiative)).toEqual([14, 14, 14, 8]);
  });

  it("orders by Initiative; ties go to the higher bonus, then the order they joined", () => {
    const { encounter, notes } = fight();
    expect(encounter.order).toEqual(["brakka", "goblin-warrior", "goblin-warrior-2", "skeleton"]);
    expect(encounter.round).toBe(1);
    expect(notes.at(-1)).toBe("Round 1: Brakka's turn.");
  });

  it("the GM can reorder ties, but not break the Initiative order", () => {
    const { encounter } = fight();
    const tied = run(encounter, [
      { type: "set_order", ids: ["goblin-warrior", "brakka", "goblin-warrior-2", "skeleton"] },
    ]);
    expect(tied.encounter.order[0]).toBe("goblin-warrior");
    expect(currentCombatant(tied.encounter)?.id).toBe("brakka"); // still Brakka's turn
    expect(() =>
      run(encounter, [
        { type: "set_order", ids: ["skeleton", "brakka", "goblin-warrior", "goblin-warrior-2"] },
      ]),
    ).toThrow("set_order can only reorder tied Initiatives");
  });

  it("can't start before everyone has rolled", () => {
    expect(() => run(createEncounter(), [...setup, { type: "start" }])).toThrow(
      /Roll Initiative first: Brakka, Goblin Warrior/,
    );
  });
});

describe("turns and rounds", () => {
  it("cycles through the order, then starts a new round", () => {
    const { encounter } = fight();
    const next = { type: "next_turn" } as const;
    const { encounter: later, notes } = run(encounter, [next, next, next, next]);
    expect(later.round).toBe(2);
    expect(currentCombatant(later)?.id).toBe("brakka");
    expect(notes).toEqual([
      "Round 1: Goblin Warrior's turn.",
      "Round 1: Goblin Warrior 2's turn.",
      "Round 1: Skeleton's turn.",
      "Round 2: Brakka's turn.",
    ]);
  });

  it("one action and one Bonus Action on your turn; a reaction any time, once a round", () => {
    const { encounter } = fight();
    const acted = run(encounter, [
      { type: "use", id: "brakka", what: "action" },
      { type: "use", id: "brakka", what: "bonus_action" },
      { type: "use", id: "skeleton", what: "reaction" },
    ]).encounter;
    expect(() => run(acted, [{ type: "use", id: "brakka", what: "action" }])).toThrow(
      "Brakka has already used its action this turn",
    );
    expect(() => run(acted, [{ type: "use", id: "skeleton", what: "action" }])).toThrow(
      "It isn't Skeleton's turn",
    );
    expect(() => run(acted, [{ type: "use", id: "skeleton", what: "reaction" }])).toThrow(
      /already used its reaction/,
    );
    // The skeleton's reaction comes back at the start of its turn.
    const next = { type: "next_turn" } as const;
    const skeletonTurn = run(acted, [next, next, next]).encounter;
    expect(skeletonTurn.combatants.find((c) => c.id === "skeleton")?.used.reaction).toBe(false);
  });

  it("movement up to Speed, more with Dash (which uses the action)", () => {
    const { encounter } = fight();
    const moved = run(encounter, [{ type: "move", id: "brakka", feet: 20 }]).encounter;
    expect(() => run(moved, [{ type: "move", id: "brakka", feet: 15 }])).toThrow(
      "Brakka can move 10 more feet this turn",
    );
    const dashed = run(moved, [
      { type: "dash", id: "brakka" },
      { type: "move", id: "brakka", feet: 40 },
    ]).encounter;
    expect(dashed.combatants[0]).toMatchObject({ moved: 60, used: { action: true } });
  });

  it("a Grappled creature can't move; an Incapacitated one can't act", () => {
    const { encounter } = fight();
    const grappled = run(encounter, [
      {
        type: "effects",
        id: "goblin-warrior",
        actions: [{ type: "add_condition", condition: "grappled" }],
      },
      {
        type: "effects",
        id: "goblin-warrior-2",
        actions: [{ type: "add_condition", condition: "stunned" }],
      },
      { type: "next_turn" },
    ]).encounter;
    expect(() => run(grappled, [{ type: "move", id: "goblin-warrior", feet: 5 }])).toThrow(
      "Goblin Warrior can move 0 more feet this turn",
    );
    const stunnedTurn = run(grappled, [{ type: "next_turn" }]).encounter;
    expect(() =>
      run(stunnedTurn, [{ type: "use", id: "goblin-warrior-2", what: "action" }]),
    ).toThrow("Goblin Warrior 2 is Incapacitated");
  });
});

describe("attacks in an encounter", () => {
  it("a goblin's hit goes to Brakka's state", () => {
    const { encounter } = fight();
    const ctx = {
      catalog,
      characters: { brakka: { build: fighter, state: createState(fighter, catalog) } },
    };
    const goblin = encounterCombatant(encounter, "goblin-warrior", ctx);
    const target = encounterCombatant(encounter, "brakka", ctx);
    const hit = makeAttack(goblin, "Scimitar", target, { rng: scriptedRng([15, 4]) });
    expect(hit.hit).toBe(true);
    const { brakka } = run(encounter, [
      {
        type: "effects",
        id: "brakka",
        actions: [{ type: "damage", instances: [...hit.instances], critical: hit.critical_hit }],
      },
    ]);
    expect(computePlaySheet(fighter, brakka, catalog).play.hp.current).toBe(6);
  });

  it("a monster at 0 HP dies and its turns are skipped", () => {
    const { encounter } = fight();
    const { encounter: after, notes } = run(encounter, [
      {
        type: "effects",
        id: "goblin-warrior",
        actions: [{ type: "damage", instances: [{ amount: 12, type: "slashing" }] }],
      },
      { type: "next_turn" },
    ]);
    expect(after.combatants[1]).toMatchObject({ hp: 0, defeated: true });
    expect(notes).toEqual([
      "Goblin Warrior drops to 0 Hit Points and dies.",
      "Goblin Warrior is out of the fight: turn skipped.",
      "Round 1: Goblin Warrior 2's turn.",
    ]);
  });

  it("a monster's defenses and condition immunities apply", () => {
    const { encounter } = fight();
    const { encounter: after, notes } = run(encounter, [
      {
        type: "effects",
        id: "skeleton",
        actions: [
          { type: "damage", instances: [{ amount: 4, type: "bludgeoning" }] }, // Vulnerable
          { type: "add_condition", condition: "poisoned" }, // immune
        ],
      },
    ]);
    expect(after.combatants[3]).toMatchObject({ hp: 5, conditions: [] });
    expect(notes).toContain("Skeleton is immune to Poisoned.");
  });

  it("reminds a character at 0 HP to make a Death Saving Throw (when not rolled automatically)", () => {
    const { encounter } = fight();
    const down = run({ ...encounter, auto_death_saves: false }, [
      { type: "effects", id: "brakka", actions: [{ type: "damage", amount: 12 }] },
      { type: "next_turn" },
      { type: "next_turn" },
      { type: "next_turn" },
      { type: "next_turn" },
    ]);
    expect(down.notes).toContain("Brakka is at 0 Hit Points: make a Death Saving Throw.");
  });
});

describe("leaving and ending", () => {
  it("removing a combatant keeps whose turn it is", () => {
    const { encounter } = fight();
    const onSkeleton = run(encounter, [
      { type: "next_turn" },
      { type: "next_turn" },
      { type: "next_turn" },
      { type: "remove", id: "goblin-warrior" },
    ]).encounter;
    expect(currentCombatant(onSkeleton)?.id).toBe("skeleton");
  });

  it("ends the fight", () => {
    const { encounter } = fight();
    const ended = run(encounter, [{ type: "end" }]).encounter;
    expect([ended.round, ended.order]).toEqual([0, []]);
    expect(currentCombatant(ended)).toBeNull();
  });
});

describe("POST /v1/encounters/apply", () => {
  it("runs a list of actions and returns changed character states", async () => {
    const handler = createHandler({ rng: scriptedRng([12, 12]) });
    const post = async (path: string, body: unknown) => {
      const res = await handler(
        new Request(`http://test${path}`, { method: "POST", body: JSON.stringify(body) }),
      );
      return { status: res.status, body: await res.json() };
    };
    const state = (await post("/v1/state/new", { build: fighter })).body;
    const characters = { brakka: { build: fighter, state } };
    const res = await post("/v1/encounters/apply", {
      encounter: createEncounter(),
      characters,
      action: [
        { type: "add_character", character: "brakka" },
        { type: "add_monster", monster: "goblin-warrior" },
        { type: "roll_initiative" },
        { type: "start" },
        { type: "effects", id: "brakka", actions: [{ type: "damage", amount: 5 }] },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.encounter.round).toBe(1);
    expect(res.body.states.brakka.hp.current).toBe(7);
    const refused = await post("/v1/encounters/apply", {
      encounter: res.body.encounter,
      characters,
      action: { type: "use", id: "goblin-warrior", what: "action" },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.detail[0]).toMatch(/It isn't Goblin Warrior's turn/);
  });
});
