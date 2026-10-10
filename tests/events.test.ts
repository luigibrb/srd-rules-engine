import { describe, expect, it } from "vitest";
import { createHandler } from "../src/http/index";
import {
  applyEncounterAction,
  type CharacterBuild,
  type CharacterState,
  createEncounter,
  createHistory,
  createState,
  type Encounter,
  type EncounterAction,
  EncounterError,
  type EncounterEvent,
  type EncounterHistory,
  recordAction,
  refusalCode,
  replayHistory,
  scriptedRng,
  seededRng,
  undoAction,
} from "../src/index";
import { autocomplete, catalog, classBuild, fighterBuild } from "./helpers";

// Events (what an action changed, as data), refusal codes, and undo by replaying a history.

function session(builds: Record<string, CharacterBuild>, rng = seededRng(5)) {
  const states: Record<string, CharacterState> = Object.fromEntries(
    Object.entries(builds).map(([k, b]) => [k, createState(b, catalog)]),
  );
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
  let history: EncounterHistory = createHistory(encounter, states);
  let events: EncounterEvent[] = [];
  const act = (...actions: EncounterAction[]) => {
    events = [];
    for (const action of actions) {
      const r = applyEncounterAction(encounter, action, { ...ctx(), rng });
      encounter = r.encounter;
      Object.assign(states, r.states);
      history = recordAction(history, action, r);
      events.push(...r.events);
    }
    return events;
  };
  return {
    act,
    ctx,
    states,
    encounter: () => encounter,
    history: () => history,
    set: (e: Encounter, s: Record<string, CharacterState>, h: EncounterHistory) => {
      encounter = e;
      Object.assign(states, s);
      history = h;
    },
  };
}

const setup: EncounterAction[] = [
  { type: "add_character", character: "brakka" },
  { type: "add_monster", monster: "goblin-warrior", side: "enemies" },
  { type: "place", id: "brakka", x: 0, y: 0 },
  { type: "place", id: "goblin-warrior", x: 1, y: 0 },
  { type: "set_initiative", id: "brakka", value: 20 },
  { type: "set_initiative", id: "goblin-warrior", value: 10 },
];

describe("events", () => {
  it("joining, the turn, an attack's damage and the economy", () => {
    const s = session({ brakka: fighterBuild() }, scriptedRng([20, 6, 6, 1, 1, 1]));
    const joined = s.act(...setup);
    expect(joined.filter((x) => x.type === "joined").map((x) => x.type)).toHaveLength(2);
    expect(s.act({ type: "start" })).toEqual([{ type: "turn", round: 1, id: "brakka" }]);
    const hit = s.act({
      type: "attack",
      id: "brakka",
      target: "goblin-warrior",
      attack: "Greatsword",
    });
    expect(hit).toContainEqual({ type: "used", id: "brakka", what: "action" });
    expect(hit).toContainEqual({
      type: "hp",
      id: "goblin-warrior",
      from: 10,
      to: 0,
      temp_from: 0,
      temp_to: 0,
    });
    expect(hit).toContainEqual({ type: "status", id: "goblin-warrior", status: "defeated" });
  });

  it("moves, conditions, Concentration, slots, effects and zones", () => {
    const ilse = autocomplete(classBuild("wizard", { name: "Ilse" }));
    const s = session({ ilse }, scriptedRng(Array(30).fill(1)));
    s.act(
      { type: "add_character", character: "ilse" },
      { type: "add_monster", monster: "goblin-warrior", side: "enemies" },
      { type: "place", id: "ilse", x: 0, y: 0 },
      { type: "place", id: "goblin-warrior", x: 6, y: 0 },
      { type: "set_initiative", id: "ilse", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 10 },
      { type: "start" },
    );
    expect(s.act({ type: "move", id: "ilse", to: { x: 1, y: 1 } })).toEqual([
      { type: "moved", id: "ilse", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, feet: 5 },
    ]);
    const cast = s.act({
      type: "cast",
      id: "ilse",
      spell: "burning-hands",
      area: { toward: { x: 6, y: 0 } },
    });
    expect(cast).toContainEqual({ type: "used", id: "ilse", what: "action" });
    expect(cast).toContainEqual({
      type: "resource",
      id: "ilse",
      resource: "spell_slot:1",
      spent_from: 0,
      spent_to: 1,
    });
    const cond = s.act({
      type: "effects",
      id: "goblin-warrior",
      actions: [{ type: "add_condition", condition: "prone" }],
      source: "ilse",
      rounds: 1,
    });
    expect(cond).toContainEqual({
      type: "condition_added",
      id: "goblin-warrior",
      condition: "prone",
    });
    expect(cond).toContainEqual(
      expect.objectContaining({ type: "effect_added", target: "goblin-warrior" }),
    );
    const conc = s.act({
      type: "effects",
      id: "ilse",
      actions: [{ type: "set_concentration", spell: "Bless" }],
    });
    expect(conc).toEqual([{ type: "concentration", id: "ilse", spell: "Bless", previous: null }]);
    expect(s.act({ type: "set_terrain", squares: [{ x: 3, y: 3 }], kind: "blocked" })).toEqual([
      { type: "map" },
    ]);
  });

  it("an action that stops for a decision says so", () => {
    const s = session({ brakka: fighterBuild() }, scriptedRng([1]));
    s.act(...setup, { type: "start" }, { type: "set_decisions", mode: "ask" });
    const encounter = {
      ...s.encounter(),
      combatants: s
        .encounter()
        .combatants.map((c) =>
          c.id === "brakka" ? { ...c, inspiration: { die: 8, by: "x" } } : c,
        ),
    };
    const r = applyEncounterAction(
      encounter,
      { type: "check", id: "brakka", skill: "athletics", dc: 25 },
      { ...s.ctx(), rng: scriptedRng([10]) },
    );
    expect(r.events).toEqual([
      expect.objectContaining({ type: "pending", combatant: "brakka", kind: "inspiration" }),
    ]);
    // The question as a message too: in the pending decision, its event and the result.
    const question = r.encounter.pending?.question_message;
    expect(question).toMatchObject({
      code: "decision.inspiration",
      params: { name: "Brakka", total: expect.any(Number), target: 25, die: 8 },
    });
    expect(question?.text).toBe(r.encounter.pending?.question);
    expect(r.messages).toEqual([question]);
    expect(r.events[0]).toMatchObject({ question_message: question });
    // Another action now is refused, saying which question waits.
    try {
      applyEncounterAction(r.encounter, { type: "dodge", id: "brakka" }, s.ctx());
      expect.unreachable();
    } catch (error) {
      expect((error as EncounterError).details[0]).toMatchObject({
        code: "refusal.waiting_decision",
        params: { question },
      });
    }
  });
});

describe("refusal codes", () => {
  it("a code for each kind of refusal", () => {
    const s = session({ brakka: fighterBuild() });
    s.act(...setup, { type: "start" });
    const refused = (action: EncounterAction) => {
      try {
        applyEncounterAction(s.encounter(), action, { ...s.ctx(), rng: scriptedRng([10, 10]) });
      } catch (error) {
        if (error instanceof EncounterError) return error.codes;
      }
      return [];
    };
    expect(refused({ type: "dodge", id: "goblin-warrior" })).toEqual(["not_your_turn"]);
    expect(refused({ type: "move", id: "brakka", to: { x: 9, y: 9 } })).toEqual(["no_movement"]);
    expect(refused({ type: "move", id: "brakka", to: { x: 1, y: 0 } })).toEqual(["no_path"]);
    expect(refused({ type: "cast", id: "brakka", spell: "fireball", targets: [] })).toEqual([
      "unknown",
    ]);
    expect(
      refused({
        type: "attack",
        id: "brakka",
        target: "goblin-warrior",
        attack: "Javelin",
        thrown: true,
        cover: "total",
      }),
    ).toEqual(["total_cover"]);
    expect(refusalCode("Ilse: No level 1 spell slots left")).toBe("no_resources");
    expect(refusalCode("Something new")).toBe("refused");
  });

  it("over HTTP: `codes` next to `detail`; apply returns events and a log with the dice", async () => {
    const handler = createHandler({ catalog, rng: scriptedRng([15, 3]) });
    const post = async (body: unknown) => {
      const res = await handler(
        new Request("http://test/v1/encounters/apply", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
      return { status: res.status, body: await res.json() };
    };
    const ok = await post({
      encounter: {},
      action: [{ type: "add_monster", monster: "goblin-warrior" }, { type: "roll_initiative" }],
    });
    expect(ok.body.log).toEqual([
      { action: { type: "add_monster", monster: "goblin-warrior" }, rolls: [] },
      { action: { type: "roll_initiative" }, rolls: [15] },
    ]);
    expect(ok.body.events).toContainEqual({ type: "initiative", id: "goblin-warrior", value: 17 });
    const refused = await post({ encounter: ok.body.encounter, action: { type: "next_turn" } });
    expect(refused).toMatchObject({ status: 400, body: { codes: ["not_started"] } });
  });
});

describe("history: replay and undo", () => {
  it("replaying the history gives the same encounter and states; undo takes back one action", () => {
    const s = session({ brakka: fighterBuild() }, seededRng(11));
    s.act(...setup, { type: "start" });
    s.act({ type: "attack", id: "brakka", target: "goblin-warrior", attack: "Unarmed Strike" });
    s.act({ type: "next_turn" });
    s.act({ type: "attack", id: "goblin-warrior", target: "brakka", attack: "Scimitar" });
    const before = { encounter: s.encounter(), states: { ...s.states } };
    const replayed = replayHistory(s.history(), s.ctx());
    expect(replayed.encounter).toEqual(before.encounter);
    expect(replayed.states).toEqual(before.states);
    const undone = undoAction(s.history(), s.ctx());
    expect(undone.history.steps).toHaveLength(s.history().steps.length - 1);
    expect(undone.encounter.turn).toBe(1); // still the goblin's turn, before its attack
    expect(undone.encounter.combatants.find((c) => c.id === "goblin-warrior")?.used.action).toBe(
      false,
    );
    expect(undone.states.brakka?.hp).toEqual(
      replayHistory(undone.history, s.ctx()).states.brakka?.hp,
    );
  });

  it("a decision replays with the same dice; undoing it brings the question back", () => {
    const lute = autocomplete(classBuild("bard", { name: "Lute" }));
    const s = session({ lute, brakka: fighterBuild() }, seededRng(3));
    s.act(
      { type: "add_character", character: "lute" },
      { type: "add_character", character: "brakka" },
      { type: "set_initiative", id: "lute", value: 20 },
      { type: "set_initiative", id: "brakka", value: 10 },
      { type: "start" },
      { type: "set_decisions", mode: "ask" },
      { type: "feature", id: "lute", feature: "Bardic Inspiration", target: "brakka" },
      { type: "next_turn" },
    );
    s.act({ type: "check", id: "brakka", skill: "athletics", dc: 30 });
    expect(s.encounter().pending?.kind).toBe("inspiration");
    s.act({ type: "decide", use: true });
    expect(s.encounter().pending).toBeNull();
    const replayed = replayHistory(s.history(), s.ctx());
    expect(replayed.encounter).toEqual(s.encounter());
    const undone = undoAction(s.history(), s.ctx());
    expect(undone.encounter.pending?.kind).toBe("inspiration");
  });
});
