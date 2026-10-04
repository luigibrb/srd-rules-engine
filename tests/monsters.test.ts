import { describe, expect, it } from "vitest";
import {
  ABILITIES,
  applyAction,
  castSpell,
  combatantFromCharacter,
  combatantFromMonster,
  computePlaySheet,
  createState,
  lookup,
  type MonsterDef,
  makeAttack,
  type SpellDef,
  scriptedRng,
  useSaveAction,
} from "../src/index";
import { catalog, fighterBuild } from "./helpers";

const monster = (id: string) => lookup(catalog.monsters, id) as MonsterDef;
const mod = (score: number) => Math.floor((score - 10) / 2);
const all = Object.values(catalog.monsters);

describe("every SRD stat block", () => {
  it("has all 330 (235 monsters, 95 animals)", () => {
    expect(all).toHaveLength(330);
  });

  it("is consistent: HP dice, saves, PB by CR, Passive Perception, damage averages", () => {
    const cr = (c: string) => (c.includes("/") ? 1 / Number(c.split("/")[1]) : Number(c));
    const pbFor = (c: string) => Math.max(2, Math.ceil(cr(c) / 4) + 1);
    for (const m of all) {
      if (m.hit_dice) {
        const [, n, sides, sign, bonus] = /^(\d+)d(\d+)(?:([+-])(\d+))?$/.exec(m.hit_dice) ?? [];
        const avg =
          Math.floor((Number(n) * (Number(sides) + 1)) / 2) +
          (sign ? Number(`${sign}${bonus}`) : 0);
        expect(avg, `${m.id} HP`).toBe(m.hit_points);
      }
      for (const a of ABILITIES) {
        const expected = [mod(m.abilities[a]), mod(m.abilities[a]) + m.proficiency_bonus];
        expect(expected, `${m.id} ${a} save`).toContain(m.saving_throws[a]);
      }
      expect(m.proficiency_bonus, `${m.id} PB`).toBe(pbFor(m.cr));
      const perception = m.skills.perception ?? mod(m.abilities.wis);
      expect(m.passive_perception, `${m.id} Passive Perception`).toBe(10 + perception);
      for (const action of [...m.actions, ...m.bonus_actions, ...m.legendary_actions]) {
        for (const d of [...(action.attack?.damage ?? []), ...(action.save?.damage ?? [])]) {
          if (!d.dice) continue;
          const [count, sides] = d.dice.split("d").map(Number) as [number, number];
          const avg = Math.floor((count * (sides + 1)) / 2) + d.bonus;
          expect(avg, `${m.id} ${action.name}`).toBe(d.average);
        }
      }
    }
  });

  it("every monster turns into a combatant", () => {
    for (const m of all) {
      const c = combatantFromMonster(m);
      expect(c.hp, m.id).toBe(m.hit_points);
      for (const line of c.attacks) expect(line.damage_parts.length, m.id).toBeGreaterThan(0);
    }
  });
});

// Golden stat blocks: every value below was checked against the SRD 5.2.1 Markdown. They cover
// the formats the importer handles: animals, groups, legendary actions, a garbled ability table,
// a missing score, qualified speeds, conditional damage, "First Failure", defense notes.
describe("golden stat blocks", () => {
  it("Animated Armor", () => {
    expect(monster("animated-armor")).toMatchObject({
      group: "Animated Objects",
      size: "Medium",
      creature_type: "Construct",
      alignment: "Unaligned",
      armor_class: 18,
      initiative: 2,
      hit_points: 33,
      hit_dice: "6d8+6",
      speed: { walk: 25 },
      abilities: { str: 14, dex: 11, con: 13, int: 1, wis: 3, cha: 1 },
      saving_throws: { str: 2, dex: 0, con: 1, int: -5, wis: -4, cha: -5 },
      immunities: ["poison", "psychic"],
      condition_immunities: [
        "charmed",
        "deafened",
        "exhaustion",
        "frightened",
        "paralyzed",
        "petrified",
        "poisoned",
      ],
      passive_perception: 6,
      cr: "1",
      xp: 200,
      proficiency_bonus: 2,
    });
    const slam = monster("animated-armor").actions.find((a) => a.name === "Slam");
    expect(slam?.attack).toEqual({
      kind: "melee",
      bonus: 4,
      reach: 5,
      range: null,
      damage: [{ average: 5, dice: "1d6", bonus: 2, type: "bludgeoning" }],
    });
  });

  it("Goblin Warrior: damage that needs Advantage stays text", () => {
    const goblin = monster("goblin-warrior");
    expect(goblin).toMatchObject({
      group: "Goblins",
      size: "Small",
      creature_type: "Fey (Goblinoid)",
      alignment: "Chaotic Neutral",
      armor_class: 15,
      hit_dice: "3d6",
      skills: { stealth: 6 },
      gear: "Leather Armor, Scimitar, Shield, Shortbow",
      cr: "1/4",
      xp: 50,
    });
    const [scimitar, shortbow] = goblin.actions;
    expect(scimitar?.attack?.damage).toEqual([
      { average: 5, dice: "1d6", bonus: 2, type: "slashing" },
    ]);
    expect(scimitar?.text).toContain(
      "plus 2 (1d4) Slashing damage if the attack roll had Advantage",
    );
    expect(shortbow?.attack).toMatchObject({ kind: "ranged", bonus: 4, range: "80/320" });
  });

  it("Skeleton: a vulnerability and condition immunities", () => {
    expect(monster("skeleton")).toMatchObject({
      vulnerabilities: ["bludgeoning"],
      immunities: ["poison"],
      condition_immunities: ["exhaustion", "poisoned"],
      saving_throws: { str: 0, dex: 3, con: 2, int: -2, wis: -1, cha: -3 },
    });
  });

  it("Allosaurus (an animal)", () => {
    const allosaurus = monster("allosaurus");
    expect(allosaurus).toMatchObject({
      group: null,
      size: "Large",
      creature_type: "Beast (Dinosaur)",
      armor_class: 13,
      hit_points: 51,
      hit_dice: "6d10+18",
      speed: { walk: 60 },
      skills: { perception: 5 },
      passive_perception: 15,
      cr: "2",
      xp: 450,
    });
    expect(allosaurus.actions.map((a) => a.attack?.damage[0]?.dice)).toEqual(["2d10", "1d8"]);
  });

  it("Swarm of Insects: a speed that's the GM's choice stays a note", () => {
    expect(monster("swarm-of-insects")).toMatchObject({
      speed: { walk: 20 },
      speed_note: "Climb or Fly 20 ft. (GM's choice)",
      resistances: ["bludgeoning", "piercing", "slashing"],
      condition_immunities: [
        "charmed",
        "frightened",
        "grappled",
        "paralyzed",
        "petrified",
        "prone",
        "restrained",
        "stunned",
      ],
      cr: "1/2",
    });
  });

  it("Adult Red Dragon: legendary actions and a breath weapon", () => {
    const dragon = monster("adult-red-dragon");
    expect(dragon).toMatchObject({
      group: "Red Dragons",
      size: "Huge",
      creature_type: "Dragon (Chromatic)",
      armor_class: 19,
      initiative: 12,
      hit_points: 256,
      hit_dice: "19d12+133",
      speed: { walk: 40, climb: 40, fly: 80 },
      skills: { perception: 13, stealth: 6 },
      immunities: ["fire"],
      passive_perception: 23,
      cr: "17",
      xp: 18000,
      proficiency_bonus: 6,
    });
    expect(dragon.traits.map((t) => t.name)).toEqual([
      "Legendary Resistance (3/Day, or 4/Day in Lair)",
    ]);
    const rend = dragon.actions.find((a) => a.name === "Rend");
    expect(rend?.attack?.damage).toEqual([
      { average: 13, dice: "1d10", bonus: 8, type: "slashing" },
      { average: 5, dice: "2d4", bonus: 0, type: "fire" },
    ]);
    const breath = dragon.actions.find((a) => a.name === "Fire Breath");
    expect(breath).toMatchObject({
      recharge: "5–6",
      save: {
        ability: "dex",
        dc: 21,
        damage: [{ average: 59, dice: "17d6", bonus: 0, type: "fire" }],
        on_success: "half",
        conditions: [],
      },
    });
    expect(dragon.legendary_text).toMatch(/^Legendary Action Uses: 3 \(4 in Lair\)\./);
    expect(dragon.legendary_actions.map((a) => a.name)).toEqual([
      "Commanding Presence",
      "Fiery Rays",
      "Pounce",
    ]);
  });

  it("Ancient Red Dragon: an ability table with merged cells", () => {
    expect(monster("ancient-red-dragon")).toMatchObject({
      armor_class: 22,
      hit_points: 507,
      hit_dice: "26d20+234",
      abilities: { str: 30, dex: 10, con: 29, int: 18, wis: 15, cha: 27 },
      saving_throws: { str: 10, dex: 7, con: 9, int: 4, wis: 9, cha: 8 },
      cr: "24",
      xp: 62000,
      proficiency_bonus: 7,
    });
  });

  it("Will-o'-Wisp: the Strength score the Markdown leaves out (a −5 modifier: 1)", () => {
    expect(monster("will-o-wisp")).toMatchObject({
      size: "Tiny",
      speed: { walk: 5, fly: 50 },
      hover: true,
      abilities: { str: 1, dex: 28, con: 10, int: 13, wis: 14, cha: 11 },
      saving_throws: { str: -5, dex: 9 },
      resistances: ["acid", "bludgeoning", "cold", "fire", "necrotic", "piercing", "slashing"],
      immunities: ["lightning", "poison"],
    });
  });

  it("Young White Dragon: the Intelligence save missing its minus sign", () => {
    expect(monster("young-white-dragon").saving_throws.int).toBe(-2);
  });

  it("Werebear: bear-form speeds are notes, and a misformatted Melee or Ranged attack", () => {
    const bear = monster("werebear");
    expect(bear).toMatchObject({
      size: "Medium or Small",
      creature_type: "Monstrosity (Lycanthrope)",
      alignment: "Neutral Good",
      speed: { walk: 30 },
      speed_note: "40 ft. (bear form only); Climb 30 ft. (bear form only)",
      gear: "Handaxes (4)",
      cr: "5",
      xp: 1800,
      proficiency_bonus: 3,
    });
    const handaxe = bear.actions.find((a) => a.name.startsWith("Handaxe"));
    expect(handaxe?.attack).toMatchObject({
      kind: "melee_or_ranged",
      bonus: 7,
      reach: 5,
      range: "20/60",
      damage: [{ average: 14, dice: "3d6", bonus: 4, type: "slashing" }],
    });
  });

  it("Mimic: an attack with Advantage in a parenthesis, and damage after an aside", () => {
    const bite = monster("mimic").actions.find((a) => a.name === "Bite");
    expect(bite?.attack).toMatchObject({
      bonus: 5,
      reach: 5,
      damage: [
        { average: 7, dice: "1d8", bonus: 3, type: "piercing" },
        { average: 4, dice: "1d8", bonus: 0, type: "acid" },
      ],
    });
    expect(monster("mimic")).toMatchObject({
      immunities: ["acid"],
      condition_immunities: ["prone"],
    });
  });

  it("Ankheg: '+5 (with Advantage if…)'", () => {
    const bite = monster("ankheg").actions.find((a) => a.name === "Bite");
    expect(bite?.attack).toMatchObject({ bonus: 5, reach: 5 });
    expect(bite?.attack?.damage.map((d) => d.type)).toEqual(["slashing", "acid"]);
  });

  it("Rakshasa: a qualified vulnerability stays a note", () => {
    const rakshasa = monster("rakshasa");
    expect(rakshasa).toMatchObject({
      vulnerabilities: [],
      defenses_note:
        "Vulnerabilities: Piercing damage from weapons wielded by creatures under the effect of a _Bless_ spell",
      condition_immunities: ["charmed", "frightened"],
      cr: "13",
      xp: 10000,
      proficiency_bonus: 5,
    });
    const command = rakshasa.actions.find((a) => a.name === "Baleful Command");
    expect(command?.save?.conditions).toEqual(["frightened", "incapacitated"]);
  });

  it("Silver Dragon Wyrmling: '450 XP', and a First Failure", () => {
    const wyrmling = monster("silver-dragon-wyrmling");
    expect(wyrmling).toMatchObject({
      saving_throws: { dex: 2, wis: 2 },
      cr: "2",
      xp: 450,
    });
    const paralyzing = wyrmling.actions.find((a) => a.name === "Paralyzing Breath");
    expect(paralyzing?.save).toEqual({
      ability: "con",
      dc: 13,
      damage: [],
      on_success: "none",
      conditions: ["incapacitated"], // the first failure; Paralyzed on a second one stays text
      area: { shape: "cone", size: 15, width: 5 }, // "each creature in a 15-foot Cone"
      range: null,
    });
  });

  it("Remorhaz: Swallow's later states stay text", () => {
    const m = monster("remorhaz");
    const swallow = [...m.actions, ...m.bonus_actions].find((a) => a.name === "Swallow");
    expect(swallow?.text).toContain(
      "A swallowed creature has the Blinded and Restrained conditions",
    );
    expect(swallow?.save).toBeNull();
  });
});

describe("monsters in combat", () => {
  const fighter = fighterBuild(); // AC 17, 12 HP
  const brakka = () => combatantFromCharacter(fighter, createState(fighter, catalog), catalog);

  it("a monster attacks with its stat block's attacks", () => {
    const dragon = combatantFromMonster(monster("adult-red-dragon"));
    expect(dragon.attacks.map((a) => a.name)).toEqual(["Rend"]);
    const hit = makeAttack(dragon, "Rend", brakka(), { rng: scriptedRng([5, 4, 1, 2]) });
    expect(hit).toMatchObject({ total: 19, hit: true });
    expect(hit.instances).toEqual([
      { amount: 12, type: "slashing" },
      { amount: 3, type: "fire" },
    ]);
  });

  it("a breath weapon: one damage roll, half on a success, the target's defenses apply", () => {
    const dragon = combatantFromMonster(monster("adult-red-dragon"));
    const imp = combatantFromMonster(monster("imp")); // immune to Fire
    const sixes = Array(17).fill(6);
    const r = useSaveAction(dragon, "Fire Breath", [brakka(), imp], {
      rng: scriptedRng([25, 2, ...sixes]),
    });
    expect(r).toMatchObject({ ability: "dex", dc: 21 });
    expect(r.targets.map((t) => [t.save?.success, t.instances[0]?.amount])).toEqual([
      [true, 51],
      [false, 102],
    ]);
    expect(r.targets[1]?.outcome?.dealt).toBe(0); // Immunity
    const { state } = applyAction(fighter, createState(fighter, catalog), catalog, {
      type: "damage",
      instances: [...(r.targets[0]?.instances ?? [])],
    });
    expect(computePlaySheet(fighter, state, catalog).play.dead).toBe(true); // 51 ≥ 12 + 12
  });

  it("a condition the target is immune to isn't applied", () => {
    const laughter = lookup(catalog.spells, "hideous-laughter") as SpellDef;
    const caster = {
      ...brakka(),
      spellcasting: [
        {
          source: "Wizard",
          list: "wizard",
          ability: "int" as const,
          save_dc: 30,
          attack_bonus: 5,
          modifier: 3,
        },
      ],
    };
    const wisp = combatantFromMonster(monster("will-o-wisp")); // immune to Prone
    const r = castSpell(caster, laughter, [wisp], { rng: scriptedRng([1]) });
    expect(r.targets[0]?.conditions).toEqual(["incapacitated"]);
  });

  it("keeps a monster's current HP and conditions from the encounter", () => {
    const goblin = combatantFromMonster(monster("goblin-warrior"), {
      hp: 4,
      conditions: ["prone"],
    });
    expect(goblin).toMatchObject({ hp: 4, max_hp: 10, conditions: ["prone"] });
  });

  it("refuses a saving throw action it doesn't have", () => {
    const goblin = combatantFromMonster(monster("goblin-warrior"));
    expect(() => useSaveAction(goblin, "Fire Breath", [])).toThrow(/no saving throw action/);
  });
});
