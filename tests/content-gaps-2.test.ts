import { describe, expect, it } from "vitest";
import {
  applyEncounterAction,
  type CharacterBuild,
  type CharacterState,
  createCatalog,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  resolve,
  scriptedRng,
} from "../src/index";
import * as svc from "../src/services/builder";
import { srdPack } from "../src/srd";
import { autocomplete, classBuild } from "./helpers";

// More content as data (homebrew, no SRD example): spells a feat adds to its owner's spell lists,
// and a saving throw around the creature a weapon hit.

const homebrew = createCatalog(srdPack, {
  name: "homebrew",
  feats: [
    {
      id: "fire-touched",
      name: "Fire-Touched",
      category: "general",
      grants: { expanded_spells: ["fireball"] },
    },
  ],
  spells: [
    {
      id: "thorn-burst",
      name: "Thorn Burst",
      level: 1,
      school: "conjuration",
      lists: ["ranger"],
      casting_time:
        "Bonus Action, which you take immediately after hitting a creature with a Ranged weapon",
      range: "Self",
      components: "V",
      duration: "Instantaneous",
      description:
        "The target of the attack and each creature within 5 feet of it make a Dexterity saving throw, taking 1d10 Piercing damage on a failed save or half as much on a successful one.",
      mechanics: {
        save: { ability: "dex", on_success: "half" },
        damage: [{ dice: "1d10", type: "piercing" }],
        after_hit: true,
        after_hit_with: "ranged",
        around_target: 5,
      },
    },
  ],
});

const levelUp = (b: CharacterBuild, classId: string, to: number, feat?: string) => {
  let x = autocomplete(b, homebrew);
  for (let l = 2; l <= to; l++) {
    x = svc.levelUp(x, homebrew, classId, null).build;
    if (feat && l === 4) x = svc.setChoice(x, homebrew, `class:${classId}:4#feat`, [feat]).build;
    x = autocomplete(x, homebrew);
  }
  return x;
};
const options = (b: CharacterBuild, key: string) => {
  const res = resolve(b, homebrew);
  const choice = res.choices.find((c) => c.key === key);
  return choice ? res.options(choice).map((o) => o.id) : [];
};

describe("spells added to a character's spell lists", () => {
  it("a Cleric with the feat can prepare Fireball, once it has level 3 slots", () => {
    const cleric = levelUp(classBuild("cleric", { name: "Mira" }), "cleric", 5, "fire-touched");
    expect(options(cleric, "class:cleric#prepared")).toContain("fireball");
    const plain = levelUp(classBuild("cleric", { name: "Mira" }), "cleric", 5);
    expect(options(plain, "class:cleric#prepared")).not.toContain("fireball");
  });
});

describe("a saving throw around the creature a weapon hit", () => {
  it("after a Longbow hit: the target and the creature next to it save", () => {
    let ranger = autocomplete(classBuild("ranger", { name: "Wren" }), homebrew);
    const res = resolve(ranger, homebrew);
    const prepared = res.choices.find((c) => c.key === "class:ranger#prepared");
    if (!prepared) throw new Error("no prepared spells");
    const others = res.selected(prepared).filter((x) => x !== "thorn-burst");
    ranger = svc.setChoice(ranger, homebrew, prepared.key, [
      "thorn-burst",
      ...others.slice(0, res.required(prepared) - 1),
    ]).build;
    ranger = autocomplete(ranger, homebrew);
    const states: Record<string, CharacterState> = { wren: createState(ranger, homebrew) };
    let e: Encounter = createEncounter();
    const notes: string[] = [];
    const act = (rolls: number[], ...actions: EncounterAction[]) => {
      for (const action of actions) {
        const r = applyEncounterAction(e, action, {
          catalog: homebrew,
          characters: { wren: { build: ranger, state: states.wren as CharacterState } },
          rng: scriptedRng(rolls),
        });
        e = r.encounter;
        Object.assign(states, r.states);
        notes.push(...r.notes);
      }
    };
    act(
      [],
      { type: "add_character", character: "wren" },
      { type: "add_monster", monster: "goblin-warrior", side: "enemies" },
      { type: "add_monster", monster: "goblin-warrior", side: "enemies" },
      { type: "set_initiative", id: "wren", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 10 },
      { type: "set_initiative", id: "goblin-warrior-2", value: 5 },
      { type: "start" },
      { type: "place", id: "wren", x: 0, y: 0 },
      { type: "place", id: "goblin-warrior", x: 6, y: 0 },
      { type: "place", id: "goblin-warrior-2", x: 7, y: 0 },
    );
    act([18, 1], { type: "attack", id: "wren", target: "goblin-warrior", attack: "Longbow" });
    // Both goblins save against Thorn Burst: the d10 rolls 4, both fail (d20 rolls of 2).
    act([4, 2, 2], { type: "cast", id: "wren", spell: "thorn-burst" });
    const saves = notes.filter((n) => n.includes("fails"));
    expect(saves.some((n) => n.startsWith("Goblin Warrior:"))).toBe(true);
    expect(saves.some((n) => n.startsWith("Goblin Warrior 2:"))).toBe(true);
  });
});

describe("a tool proficiency, or another when you already have it", () => {
  const tools = createCatalog(srdPack, {
    name: "homebrew",
    feats: [
      { id: "smithy", name: "Smithy", category: "origin", grants: { tools: ["smiths-tools"] } },
      {
        id: "forge-trained",
        name: "Forge-Trained",
        category: "general",
        grants: {
          choices: [
            {
              id: "tool",
              label: "Forge-Trained: Smith's Tools",
              kind: "tool",
              category: "artisan",
              unless_proficient: "smiths-tools",
            },
          ],
        },
      },
    ],
  });
  const fighter = (origin: string | null) => {
    let b = autocomplete(classBuild("fighter", { name: "Brakka" }), tools);
    if (origin) b = svc.setChoice(b, tools, "species:human#versatile", [origin]).build;
    b = autocomplete(b, tools);
    for (let l = 2; l <= 4; l++) {
      b = svc.levelUp(b, tools, "fighter", null).build;
      if (l === 4) b = svc.setChoice(b, tools, "class:fighter:4#feat", ["forge-trained"]).build;
      b = autocomplete(b, tools);
    }
    return b;
  };
  const choice = (b: CharacterBuild) => {
    const res = resolve(b, tools);
    return res.choices.find((c) => c.key.includes("forge-trained") && c.key.endsWith("#tool"));
  };

  it("gives Smith's Tools, with nothing to choose", () => {
    const b = fighter(null);
    expect(choice(b)?.fixed).toEqual(["smiths-tools"]);
  });

  it("asks for another Artisan's Tools when the character already has Smith's Tools", () => {
    const b = fighter("smithy");
    const c = choice(b);
    expect(c?.fixed).toBeNull();
    const res = resolve(b, tools);
    const smith = c && res.options(c).find((o) => o.id === "smiths-tools");
    expect(smith?.unavailable).toBeTruthy();
  });
});
