import { describe, expect, it } from "vitest";
import {
  type AttackResult,
  applyEncounterAction,
  createEncounter,
  type Encounter,
  type EncounterAction,
  scriptedRng,
} from "../src/index";
import { catalog } from "./helpers";

// SRD 5.2.1 stat block traits that act in combat: Fire Aura, Death Burst, Regeneration, Aura of
// Authority.

function fight(monsters: { monster: string; at: [number, number]; side?: string }[]) {
  let encounter: Encounter = createEncounter();
  const notes: string[] = [];
  let result: unknown = null;
  const act = (rolls: number[], ...actions: EncounterAction[]) => {
    for (const action of actions) {
      const r = applyEncounterAction(encounter, action, { catalog, rng: scriptedRng(rolls) });
      encounter = r.encounter;
      notes.push(...r.notes);
      result = r.result;
    }
  };
  const seen = new Map<string, number>();
  const ids = monsters.map(({ monster }) => {
    const n = (seen.get(monster) ?? 0) + 1;
    seen.set(monster, n);
    return n === 1 ? monster : `${monster}-${n}`;
  });
  act(
    [],
    ...monsters.map(
      (m) => ({ type: "add_monster", monster: m.monster, side: m.side ?? "enemies" }) as const,
    ),
    ...monsters.map(
      (m, i) => ({ type: "place", id: ids[i] as string, x: m.at[0], y: m.at[1] }) as const,
    ),
    ...ids.map((id, i) => ({ type: "set_initiative", id, value: 20 - i }) as const),
    { type: "start" },
  );
  const get = (id: string) => encounter.combatants.find((c) => c.id === id);
  return { act, notes, get, result: () => result };
}
const next = { type: "next_turn" } as const;

describe("monster traits in encounters", () => {
  it("Fire Aura: damage at the end of its turn to enemies of its choice within 5 feet", () => {
    const s = fight([
      { monster: "salamander", at: [0, 0] },
      { monster: "goblin-warrior", at: [2, 0], side: "party" },
      { monster: "goblin-warrior", at: [6, 0], side: "party" },
    ]);
    s.act([3, 3], next);
    expect(s.notes).toContain("Fire Aura: Goblin Warrior takes 6 fire.");
    expect(s.get("goblin-warrior-2")?.hp).toBe(10);
  });

  it("Death Burst: the creatures around it save when it dies", () => {
    const s = fight([
      { monster: "magma-mephit", at: [0, 0] },
      { monster: "goblin-warrior", at: [1, 0], side: "party" },
    ]);
    s.act([6, 6, 1], {
      type: "effects",
      id: "magma-mephit",
      actions: [{ type: "damage", amount: 50 }],
    });
    expect(s.notes).toContain("Death Burst: Magma Mephit explodes (Dexterity DC 11).");
    expect(s.get("goblin-warrior")?.hp).toBeLessThan(10);
  });

  it("Regeneration: back at the start of its turn, unless it took Fire; dies at 0 then", () => {
    const s = fight([
      { monster: "goblin-warrior", at: [0, 0], side: "party" },
      { monster: "troll", at: [1, 0] },
    ]);
    s.act([], { type: "effects", id: "troll", actions: [{ type: "damage", amount: 200 }] });
    expect(s.get("troll")).toMatchObject({ hp: 0, defeated: false, conditions: ["unconscious"] });
    s.act([], next);
    expect(s.get("troll")).toMatchObject({ hp: 15, defeated: false, conditions: [] });
    s.act(
      [],
      {
        type: "effects",
        id: "troll",
        actions: [{ type: "damage", amount: 15, damage_type: "fire" }],
      },
      next,
      next,
    );
    expect(s.get("troll")?.defeated).toBe(true);
    expect(s.notes).toContain(
      "Troll starts its turn at 0 Hit Points and can't regenerate: it dies.",
    );
  });

  it("Aura of Authority: Advantage on attack rolls for the captain's allies within 10 feet", () => {
    const s = fight([
      { monster: "hobgoblin-warrior", at: [0, 0] },
      { monster: "hobgoblin-captain", at: [1, 1] },
      { monster: "goblin-warrior", at: [1, 0], side: "party" },
    ]);
    s.act([10, 10, 3], {
      type: "attack",
      id: "hobgoblin-warrior",
      target: "goblin-warrior",
      attack: "Longsword",
    });
    expect((s.result() as AttackResult).roll.mode).toBe("advantage");
  });
});
