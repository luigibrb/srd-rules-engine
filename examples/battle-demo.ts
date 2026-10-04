/**
 * A short battle that shows the engine at work: a level 5 party built through the builder API
 * fights a red dragon wyrmling and its goblins on a 5-foot grid. The dice are seeded, so the
 * story is the same on every run (tests/demo.test.ts checks it).
 *
 *   npm run demo                 # or: npx tsx examples/battle-demo.ts [seed]
 *
 * Everything here goes through the public API: builder setters and choices, the sheet and its
 * explanations, play states, and encounter actions.
 */

import {
  applyEncounterAction,
  areaSquares,
  BuildError,
  builder,
  type Catalog,
  type CharacterBuild,
  type CharacterState,
  computePlaySheet,
  computeSheet,
  createBuild,
  createEncounter,
  createState,
  currentCombatant,
  type Encounter,
  type EncounterAction,
  type EncounterCombatant,
  EncounterError,
  explainStat,
  gridDistance,
  inArea,
  type Rng,
  resolve,
  seededRng,
  srdCatalog,
} from "../src/index";

/** The seed whose fight shows every feature below (found by trying seeds). */
export const DEMO_SEED = 7;

export function runDemo(seed = DEMO_SEED): string[] {
  const lines: string[] = [];
  const say = (text = "") => lines.push(text);
  const title = (text: string) => say(`\n== ${text} ==`);
  const catalog = srdCatalog();
  const rng = seededRng(seed);

  // --- 1. Building characters ---------------------------------------------------------------
  title("1. Building a character");
  let brakka = start(catalog, "Brakka", "fighter", "human", "soldier");
  // Every option knows why it can't be picked.
  const res = resolve(brakka, catalog);
  const skills = res.choices.find((c) => c.key === "class:fighter#skills");
  const athletics = skills && res.options(skills).find((o) => o.id === "athletics");
  say(`Fighter skill "Athletics": ${athletics?.unavailable ?? "available"}`);
  try {
    builder.setChoice(brakka, catalog, "class:fighter#skills", ["athletics", "perception"]);
  } catch (error) {
    if (!(error instanceof BuildError)) throw error;
    say(`Picking it anyway is refused: ${error.messages[0]}`);
  }
  brakka = complete(catalog, brakka, ["defense", "greatsword", "flail", "javelin", "alert"]);
  // Every number explains itself.
  const sheet = computeSheet(brakka, catalog);
  say(
    `Brakka, level ${sheet.level}: AC ${sheet.armor_class.total} = ${explainStat(sheet.armor_class)}`,
  );
  say(`HP ${sheet.max_hp?.total} = ${sheet.max_hp ? explainStat(sheet.max_hp) : "?"}`);

  title("2. Levelling up the party to 5");
  brakka = levelTo(catalog, brakka, "fighter", 5, ["alert"]);
  let ilse = start(catalog, "Ilse", "wizard", "elf", "sage");
  const spells: Record<string, string[]> = {
    ilse: ["fireball", "ray-of-frost", "shield", "magic-missile"],
    lute: ["healing-word", "vicious-mockery"],
  };
  ilse = levelTo(catalog, ilse, "wizard", 5, spells.ilse ?? []);
  let lute = start(catalog, "Lute", "bard", "halfling", "criminal");
  lute = levelTo(catalog, lute, "bard", 5, spells.lute ?? []);
  const party: Record<string, CharacterBuild> = { brakka, ilse, lute };
  for (const [key, build] of Object.entries(party)) {
    const s = computeSheet(build, catalog);
    const extras = [
      key === "brakka" ? `${s.attacks_per_action} attacks per action` : "",
      s.spell_slots.length
        ? `slots ${s.spell_slots.map((n, i) => `${n}×L${i + 1}`).join(" ")}`
        : "",
      spells[key]
        ? `with ${s.spells
            .filter((x) => spells[key]?.includes(x.id))
            .map((x) => x.name)
            .join(", ")}`
        : "",
    ].filter(Boolean);
    say(
      `${build.name}: ${s.classes.map((c) => `${c.name} ${c.level}`).join(" / ")}, HP ${s.max_hp?.total}, AC ${s.armor_class.total}${extras.length ? `, ${extras.join(", ")}` : ""}`,
    );
  }

  // --- 3. The battle ------------------------------------------------------------------------
  title("3. The battle");
  const fight = new Fight(catalog, party, rng, say);
  // Players decide after seeing a roll (Bardic Inspiration): the encounter asks them.
  fight.act(
    { type: "set_decisions", mode: "ask" },
    ...Object.keys(party).map((character) => ({ type: "add_character", character }) as const),
    { type: "add_monster", monster: "red-dragon-wyrmling", side: "enemies" },
    ...[1, 2, 3].map(
      () => ({ type: "add_monster", monster: "goblin-warrior", side: "enemies" }) as const,
    ),
    { type: "place", id: "brakka", x: 2, y: 2 },
    { type: "place", id: "lute", x: 1, y: 3 },
    { type: "place", id: "ilse", x: 0, y: 1 },
    { type: "place", id: "red-dragon-wyrmling", x: 12, y: 2 },
    { type: "place", id: "goblin-warrior", x: 8, y: 1 },
    { type: "place", id: "goblin-warrior-2", x: 9, y: 2 },
    { type: "place", id: "goblin-warrior-3", x: 8, y: 3 },
    { type: "roll_initiative", group: true },
    { type: "start" },
  );
  fight.run();

  title("4. After the battle");
  for (const [key, build] of Object.entries(party)) {
    const s = computePlaySheet(build, fight.states[key] as CharacterState, catalog);
    const used = s.play.uses.filter((u) => u.spent).map((u) => `${u.name} ${u.spent}/${u.max}`);
    const slots = s.play.spell_slots
      .filter((x) => x.spent)
      .map((x) => `L${x.level} ${x.spent}/${x.total}`);
    const spent = [...used, ...slots];
    say(
      `${build.name}: HP ${s.play.hp.current}/${s.play.hp.max}${spent.length ? `; spent ${spent.join(", ")}` : ""}`,
    );
  }
  return lines;
}

// --- building helpers -------------------------------------------------------------------------

export function start(
  catalog: Catalog,
  name: string,
  classId: string,
  species: string,
  background: string,
): CharacterBuild {
  let b = createBuild();
  b = builder.setClass(b, catalog, classId).build;
  b = builder.setSpecies(b, catalog, species).build;
  b = builder.setBackground(b, catalog, background).build;
  b = builder.setAbilityMethod(b, catalog, "standard_array").build;
  const cls = catalog.classes[classId];
  b = builder.setBaseScores(b, catalog, { ...(cls?.standard_array ?? {}) }).build;
  const [first, second] = catalog.backgrounds[background]?.ability_scores ?? [];
  b = builder.setBackgroundBonus(b, catalog, { [first as string]: 2, [second as string]: 1 }).build;
  return builder.setName(b, catalog, name).build;
}

/** Answer every open choice: the preferred options first, else the first legal one. */
export function complete(
  catalog: Catalog,
  build: CharacterBuild,
  prefer: readonly string[],
): CharacterBuild {
  let b = build;
  for (let guard = 0; guard < 500; guard++) {
    const res = resolve(b, catalog);
    const open = res.choices.find(
      (c) => c.fixed === null && res.selected(c).length < res.required(c),
    );
    if (!open) return b;
    const picked = res.selected(open);
    const free = res.options(open).filter((o) => !o.unavailable && !picked.includes(o.id));
    const rank = (id: string) => (prefer.includes(id) ? prefer.indexOf(id) : prefer.length);
    const next = [...free].sort((x, y) => rank(x.id) - rank(y.id))[0];
    if (!next) throw new Error(`No legal option left for ${open.key}`);
    b = builder.setChoice(b, catalog, open.key, [...picked, next.id]).build;
  }
  throw new Error("The build didn't complete");
}

/**
 * Re-pick choices that left out a preferred option they could take (prepared spells answered
 * before a later level added Fireball to the spellbook), like re-preparing after a Long Rest.
 */
function prefer(
  catalog: Catalog,
  build: CharacterBuild,
  wanted: readonly string[],
): CharacterBuild {
  let b = build;
  const res = resolve(b, catalog);
  for (const choice of res.choices) {
    const picked = res.selected(choice);
    const missing = res
      .options(choice)
      .filter((o) => wanted.includes(o.id) && !o.unavailable && !picked.includes(o.id))
      .map((o) => o.id);
    if (!missing.length || !picked.length) continue;
    const rest = picked.filter((id) => !wanted.includes(id));
    const keep = picked.filter((id) => wanted.includes(id));
    const values = [...keep, ...missing, ...rest].slice(0, picked.length);
    try {
      b = builder.setChoice(b, catalog, choice.key, values).build;
    } catch (error) {
      if (!(error instanceof BuildError)) throw error; // a choice that can't change: keep it
    }
  }
  return b;
}

export function levelTo(
  catalog: Catalog,
  build: CharacterBuild,
  classId: string,
  level: number,
  wanted: readonly string[],
): CharacterBuild {
  let b = complete(catalog, build, wanted);
  while (1 + b.levels.length < level) {
    b = complete(catalog, builder.levelUp(b, catalog, classId).build, wanted);
  }
  return prefer(catalog, b, wanted);
}

// --- the battle -------------------------------------------------------------------------------

class Fight {
  encounter: Encounter = createEncounter();
  readonly states: Record<string, CharacterState>;
  private triedTooFar = false;

  constructor(
    private readonly catalog: Catalog,
    private readonly builds: Record<string, CharacterBuild>,
    private readonly rng: Rng,
    private readonly say: (text?: string) => void,
  ) {
    this.states = Object.fromEntries(
      Object.entries(builds).map(([k, b]) => [k, createState(b, catalog)]),
    );
  }

  /** Apply actions, print their notes, and answer decisions the way a player would. */
  act(...actions: EncounterAction[]): boolean {
    for (const first of actions) {
      let action: EncounterAction | null = first;
      while (action) {
        let r: ReturnType<typeof applyEncounterAction>;
        try {
          r = applyEncounterAction(this.encounter, action, {
            catalog: this.catalog,
            characters: Object.fromEntries(
              Object.entries(this.builds).map(([k, build]) => [
                k,
                { build, state: this.states[k] as CharacterState },
              ]),
            ),
            rng: this.rng,
          });
        } catch (error) {
          if (!(error instanceof EncounterError)) throw error;
          this.say(`  ✘ Refused: ${error.messages.join("; ")}`);
          return false;
        }
        this.encounter = r.encounter;
        Object.assign(this.states, r.states);
        action = null;
        if (r.pending) {
          // The action stopped after the roll: the player sees it and decides.
          const use = r.pending.recommended;
          this.say(`  ? ${r.pending.question} → ${use ? "yes" : "no"}`);
          action = { type: "decide", use };
        } else {
          for (const note of r.notes) {
            if (/^Round \d+: /.test(note)) this.say(); // a blank line before each turn
            this.say(`  ${note}`);
          }
          this.opportunityAttacks(r.notes);
        }
      }
    }
    return true;
  }

  /** "Brakka leaves Goblin Warrior's reach": the goblin takes its Opportunity Attack. */
  private opportunityAttacks(notes: readonly string[]): void {
    for (const note of notes) {
      const m = /^(.+) leaves (.+)'s reach: /.exec(note);
      const mover = m && this.byName(m[1] as string);
      const foe = m && this.byName(m[2] as string);
      if (!mover || !foe || this.isDown(foe)) continue;
      const attack = foe.monster
        ? this.catalog.monsters[foe.monster]?.actions.find((a) => a.attack?.kind === "melee")?.name
        : "Greatsword";
      if (attack) {
        this.act({ type: "attack", id: foe.id, target: mover.id, attack, opportunity: true });
      }
    }
  }

  private byName(name: string): EncounterCombatant | undefined {
    return this.encounter.combatants.find((c) => c.name === name);
  }

  get(id: string): EncounterCombatant | undefined {
    return this.encounter.combatants.find((c) => c.id === id);
  }

  private alive(side: "party" | "enemies"): EncounterCombatant[] {
    return this.encounter.combatants.filter((c) => {
      if (c.defeated) return false;
      if (c.character) {
        const s = this.states[c.character] as CharacterState;
        return side === "party" && !s.dead && (s.hp.current ?? 1) > 0;
      }
      return side === "enemies";
    });
  }

  run(): void {
    while (this.encounter.round <= 6) {
      const enemies = this.alive("enemies");
      if (
        !enemies.some((c) => c.monster === "red-dragon-wyrmling") ||
        !this.alive("party").length
      ) {
        break;
      }
      const c = currentCombatant(this.encounter) as EncounterCombatant;
      if (this.isDown(c)) {
        // At 0 Hit Points: the Death Saving Throw was rolled at the start of the turn.
      } else if (c.character === "ilse") this.wizard(c);
      else if (c.character === "lute") this.bard(c);
      else if (c.character === "brakka") this.fighter(c);
      else if (c.monster === "red-dragon-wyrmling") this.dragon(c);
      else if (c.monster) this.goblin(c);
      this.act({ type: "next_turn" });
    }
    const dragon = this.get("red-dragon-wyrmling");
    this.say(dragon?.defeated ? "The wyrmling falls. The party wins." : "The fight goes on…");
  }

  /** Fireball on the goblins while they're bunched up, then Ray of Frost on the dragon. */
  private wizard(c: EncounterCombatant): void {
    const goblins = this.alive("enemies").filter((x) => x.monster === "goblin-warrior");
    const slots = computePlaySheet(
      this.builds.ilse as CharacterBuild,
      this.states.ilse as CharacterState,
      this.catalog,
    ).play.spell_slots;
    const third = slots.find((s) => s.level === 3);
    // Fireball (a 20-foot Sphere): the point that catches the most goblins and no friend.
    const point = third && third.spent < third.total ? this.fireballPoint(c, goblins) : null;
    if (point) {
      this.act({ type: "cast", id: c.id, spell: "fireball", area: { point } });
    } else {
      const target = this.nearestEnemy(c, true);
      // Ray of Frost: the dragon is immune to fire.
      if (target) this.act({ type: "cast", id: c.id, spell: "ray-of-frost", targets: [target.id] });
    }
  }

  private fireballPoint(
    c: EncounterCombatant,
    goblins: readonly EncounterCombatant[],
  ): { x: number; y: number } | null {
    const sphere = { shape: "sphere", size: 20, width: 5 } as const;
    const space = (x: EncounterCombatant) => ({ position: x.position ?? { x: 0, y: 0 }, size: 1 });
    let best: { point: { x: number; y: number }; hits: number } | null = null;
    for (const g of goblins) {
      for (let dx = -4; dx <= 4; dx++) {
        for (let dy = -4; dy <= 4; dy++) {
          const point = { x: (g.position?.x ?? 0) + dx, y: (g.position?.y ?? 0) + dy };
          const squares = areaSquares(sphere, space(c), { point });
          if (this.alive("party").some((p) => inArea(squares, space(p)))) continue;
          const hits = goblins.filter((x) => inArea(squares, space(x))).length;
          if (hits >= 2 && (!best || hits > best.hits)) best = { point, hits };
        }
      }
    }
    return best?.point ?? null;
  }

  /** Bardic Inspiration on Brakka, then Vicious Mockery; Healing Word on a wounded friend. */
  private bard(c: EncounterCombatant): void {
    const hurt = this.alive("party").find((x) => {
      const s = computePlaySheet(
        this.builds[x.character as string] as CharacterBuild,
        this.states[x.character as string] as CharacterState,
        this.catalog,
      );
      return s.play.hp.current <= s.play.hp.max / 2;
    });
    if (hurt) this.act({ type: "cast", id: c.id, spell: "healing-word", targets: [hurt.id] });
    else if (!this.get("brakka")?.inspiration) {
      this.act({ type: "feature", id: c.id, feature: "Bardic Inspiration", target: "brakka" });
    }
    const target = this.nearestEnemy(c, true);
    if (target)
      this.act({ type: "cast", id: c.id, spell: "vicious-mockery", targets: [target.id] });
  }

  /** Close in on the dragon, attack twice (Extra Attack), and Action Surge for two more. */
  private fighter(c: EncounterCombatant): void {
    const dragon = this.get("red-dragon-wyrmling") as EncounterCombatant;
    const swing: EncounterAction = {
      type: "attack",
      id: c.id,
      target: dragon.id,
      attack: "Greatsword",
    };
    if ((this.states.brakka as CharacterState).conditions.includes("prone")) {
      this.act({ type: "stand", id: c.id });
    }
    if (!this.triedTooFar && this.distance(c, dragon) > 5) {
      this.triedTooFar = true;
      this.act(swing); // refused: out of reach
    }
    this.approach(c, dragon);
    if (this.distance(this.get(c.id) as EncounterCombatant, dragon) > 5) return;
    const attack = () => !this.get(dragon.id)?.defeated && this.act(swing);
    attack();
    attack();
    const surge = computePlaySheet(
      this.builds.brakka as CharacterBuild,
      this.states.brakka as CharacterState,
      this.catalog,
    ).play.uses.find((u) => u.key === "fighter:action-surge");
    if (surge && surge.spent < surge.max && !this.get(dragon.id)?.defeated) {
      this.act({ type: "feature", id: c.id, feature: "Action Surge" });
      attack();
      attack();
    }
  }

  /** Fire Breath at the party when it's ready, else close in and Rend twice. */
  private dragon(c: EncounterCombatant): void {
    const target = this.nearestEnemy(c, false);
    if (!target) return;
    this.approach(c, target);
    const me = this.get(c.id) as EncounterCombatant;
    // Fire Breath is a 15-foot Cone: breathe when the target is that close.
    if (!me.expended.includes("Fire Breath") && this.distance(me, target) <= 15) {
      const toward = target.position ?? { x: 0, y: 0 };
      this.act({ type: "save_action", id: c.id, ability: "Fire Breath", area: { toward } });
    } else if (this.distance(me, target) <= 5) {
      this.act({ type: "attack", id: c.id, target: target.id, attack: "Rend" });
      if (!this.isDown(target))
        this.act({ type: "attack", id: c.id, target: target.id, attack: "Rend" });
    }
  }

  /** Rush the nearest character and slash. */
  private goblin(c: EncounterCombatant): void {
    const target = this.nearestEnemy(c, false);
    if (!target) return;
    this.approach(c, target);
    if (this.distance(this.get(c.id) as EncounterCombatant, target) <= 5) {
      this.act({ type: "attack", id: c.id, target: target.id, attack: "Scimitar" });
    }
  }

  private isDown(c: EncounterCombatant): boolean {
    if (!c.character) return Boolean(this.get(c.id)?.defeated);
    const s = this.states[c.character] as CharacterState;
    return s.dead || s.hp.current === 0;
  }

  private nearestEnemy(
    c: EncounterCombatant,
    dragonFirst: boolean,
  ): EncounterCombatant | undefined {
    const side = c.character ? "enemies" : "party";
    const foes = this.alive(side);
    if (dragonFirst) {
      const dragon = foes.find((x) => x.monster === "red-dragon-wyrmling");
      if (dragon) return dragon;
    }
    return [...foes].sort((a, b) => this.distance(c, a) - this.distance(c, b))[0];
  }

  private distance(a: EncounterCombatant, b: EncounterCombatant): number {
    return gridDistance(a.position ?? { x: 0, y: 0 }, 1, b.position ?? { x: 0, y: 0 }, 1);
  }

  /** Move next to `target`, or as close as its Speed allows, to a free square. */
  private approach(c: EncounterCombatant, target: EncounterCombatant): void {
    if (this.distance(c, target) <= 5) return;
    const from = c.position as { x: number; y: number };
    const to = target.position as { x: number; y: number };
    const taken = new Set(
      this.encounter.combatants
        .filter((x) => !x.defeated && x.position)
        .map((x) => `${x.position?.x},${x.position?.y}`),
    );
    const steps = 6; // 30 feet
    const options: { x: number; y: number }[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) options.push({ x: to.x + dx, y: to.y + dy });
    }
    const reachable = (p: { x: number; y: number }) =>
      Math.max(Math.abs(p.x - from.x), Math.abs(p.y - from.y)) <= steps;
    const free = options.filter((p) => !taken.has(`${p.x},${p.y}`));
    const near = free.filter(reachable).sort((a, b) => cheb(a, from) - cheb(b, from))[0];
    if (near) {
      this.say(`  ${c.name} moves to ${near.x},${near.y}.`);
      this.act({ type: "move", id: c.id, to: near });
      return;
    }
    // Too far: go as far as the Speed allows, straight toward the target.
    const clamp = (d: number) => Math.max(-steps, Math.min(steps, d));
    const partial = { x: from.x + clamp(to.x - from.x), y: from.y + clamp(to.y - from.y) };
    if (!taken.has(`${partial.x},${partial.y}`)) {
      this.say(`  ${c.name} moves to ${partial.x},${partial.y}.`);
      this.act({ type: "move", id: c.id, to: partial });
    }
  }
}

function cheb(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

if (process.argv[1]?.endsWith("battle-demo.ts")) {
  const seed = process.argv[2] ? Number(process.argv[2]) : DEMO_SEED;
  process.stdout.write(`${runDemo(seed).join("\n")}\n`);
}
