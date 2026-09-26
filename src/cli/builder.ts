/**
 * Interactive level 1 character builder.
 *
 * The shell is a thin UI over `services/builder`: every choice goes through a validated setter,
 * and the character panel is recomputed from scratch after each change.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Catalog, lookup } from "../content/catalog";
import {
  type AbilityMap,
  type AbilityMethod,
  ALIGNMENT_NAMES,
  ALIGNMENTS,
  type Alignment,
  type CharacterBuild,
  createBuild,
  updateBuild,
} from "../models/build";
import {
  ABILITIES,
  ABILITY_NAMES,
  type Ability,
  isSkill,
  SKILL_ABILITY,
  STEPS,
  type Step,
  skillName,
  titleCase,
} from "../models/content";
import { pointBuyStatus, rollAbilityScores, unassignedValues } from "../rules/ability-scores";
import { type ActiveChoice, type OptionView, resolve } from "../rules/build-resolution";
import { issuesForStep } from "../rules/build-validation";
import { abilityModifier, signed } from "../rules/dice";
import { mathRng, type Rng } from "../rules/rng";
import { computeSheet, type DerivedSheet } from "../rules/sheet";
import * as svc from "../services/builder";
import { BuildError, evaluate, STEP_TITLES } from "../services/builder";
import { BackToMenu, type Console, QuitBuilder } from "./console";
import { pad, padLeft, renderMenu, renderPanel, renderSheet, shorten } from "./render";

interface Row {
  id: string;
  label: string;
  extra?: string;
  unavailable?: string | null;
  details?: string;
}

type Setter<A extends unknown[]> = (
  build: CharacterBuild,
  catalog: Catalog,
  ...args: A
) => svc.BuildResult;

export interface BuilderAppOptions {
  build?: CharacterBuild;
  rng?: Rng;
  /** Where `save` writes `<name>.json`. Default: `characters`. */
  saveDir?: string;
}

export class BuilderApp {
  build: CharacterBuild;
  private dirty = false;
  private readonly rng: Rng;
  private readonly saveDir: string;

  constructor(
    private readonly con: Console,
    private readonly catalog: Catalog,
    { build, rng, saveDir }: BuilderAppOptions = {},
  ) {
    this.build = build ?? createBuild();
    this.rng = rng ?? mathRng;
    this.saveDir = saveDir ?? "characters";
  }

  // --- main loop --------------------------------------------------------------------------

  async run(): Promise<CharacterBuild> {
    const con = this.con;
    con.title("Character Builder · Level 1 · SRD 5.2.1");
    con.info("Work through the steps in order, or jump to any step by number.");
    con.info("At any prompt: 'back' returns to this menu, 'quit' exits.");
    try {
      for (;;) await this.hub();
    } catch (error) {
      if (!(error instanceof QuitBuilder)) throw error;
      await this.onQuit();
    }
    return this.build;
  }

  private async hub(): Promise<void> {
    const ev = evaluate(this.build, this.catalog);
    this.con.say();
    renderPanel(ev, this.con, this.catalog);
    renderMenu(ev, this.con, this.catalog);
    const next = svc.nextIncompleteStep(ev);
    const fallback = next ? STEP_TITLES[next] : "Review & save";
    let answer: string;
    try {
      answer = await this.con.ask(`Step number, 'sheet', 'save' or Enter for ${fallback} >`);
    } catch (error) {
      if (error instanceof BackToMenu) return;
      throw error;
    }
    const n = /^\d+$/.test(answer) ? Number(answer) : null;
    if (!answer) {
      if (next) await this.runStep(next);
      else await this.review();
    } else if (n !== null && n >= 1 && n <= STEPS.length) {
      await this.runStep(STEPS[n - 1] as Step);
    } else if (n === STEPS.length + 1) {
      await this.review();
    } else if (answer.toLowerCase() === "sheet") {
      renderSheet(ev, this.con, this.catalog);
    } else if (answer.toLowerCase() === "save") {
      this.save();
    } else {
      this.con.error(`Unknown command '${answer}'`);
    }
  }

  private async runStep(step: Step): Promise<void> {
    const handlers: Record<Step, () => Promise<void>> = {
      class: () => this.stepClass(),
      species: () => this.stepSpecies(),
      background: () => this.stepBackground(),
      abilities: () => this.stepAbilities(),
      equipment: () => this.stepChoices("equipment"),
      features: () => this.stepFeatures(),
      proficiencies: () => this.stepProficiencies(),
      languages: () => this.stepChoices("languages"),
      details: () => this.stepDetails(),
    };
    this.con.title(STEP_TITLES[step]);
    try {
      await handlers[step]();
    } catch (error) {
      if (!(error instanceof BackToMenu)) throw error;
    }
  }

  private async onQuit(): Promise<void> {
    if (this.dirty) {
      try {
        if (await this.con.confirm("Save your character before quitting?", true)) this.save();
      } catch (error) {
        if (!(error instanceof QuitBuilder || error instanceof BackToMenu)) throw error;
      }
    }
    this.con.say("Farewell, adventurer.");
  }

  // --- helpers ----------------------------------------------------------------------------

  private apply<A extends unknown[]>(setter: Setter<A>, ...args: A): boolean {
    try {
      const result = setter(this.build, this.catalog, ...args);
      this.build = result.build;
      for (const note of result.notes) this.con.warn(note);
    } catch (error) {
      if (!(error instanceof BuildError)) throw error;
      for (const message of error.messages) this.con.error(message);
      return false;
    }
    this.dirty = true;
    return true;
  }

  private sheet(build: CharacterBuild = this.build): DerivedSheet {
    return computeSheet(build, this.catalog);
  }

  /** Show numbered rows and read `count` picks. Enter keeps a complete current pick. */
  private async select(
    rows: readonly Row[],
    count = 1,
    current: readonly string[] = [],
    hint = "",
  ): Promise<string[]> {
    const con = this.con;
    rows.forEach((row, i) => {
      const chosen = current.includes(row.id) ? "◉" : " ";
      const label = pad(row.label, 24);
      if (row.unavailable) {
        con.say(con.style(` ${chosen} ${padLeft(i + 1, 2)}. ${label} ✘ ${row.unavailable}`, "dim"));
      } else {
        const extra = row.extra ? ` ${con.style(row.extra, "dim")}` : "";
        con.say(` ${con.style(chosen, "green")} ${padLeft(i + 1, 2)}. ${label}${extra}`);
      }
    });
    if (hint) con.info(hint);
    const ids = new Set(rows.map((r) => r.id));
    const keep = current.length === count && current.every((c) => ids.has(c));
    const what = count === 1 ? "one number" : `${count} numbers, e.g. '1 4'`;
    const prompt = `Choose ${what}${keep ? " (Enter keeps current)" : ""}, '?N' for details >`;
    const inRange = (t: string) => /^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= rows.length;
    for (;;) {
      const answer = await con.ask(prompt);
      if (!answer && keep) return [...current];
      if (/^\?\s*\d+$/.test(answer)) {
        const row = rows[Number(answer.slice(1)) - 1];
        if (row) {
          con.say(con.style(row.label, "bold"));
          for (const line of (row.details || row.extra || "No details.").split("\n")) {
            con.say(`  ${line}`);
          }
        }
        continue;
      }
      const tokens = answer.split(/[,\s]+/).filter(Boolean);
      if (!tokens.length || !tokens.every(inRange)) {
        con.error(`Enter ${what} between 1 and ${rows.length}`);
        continue;
      }
      const picked = tokens.map((t) => rows[Number(t) - 1] as Row);
      if (new Set(picked.map((r) => r.id)).size !== picked.length) {
        con.error("Each option can be chosen only once");
        continue;
      }
      if (picked.length !== count) {
        con.error(`Choose exactly ${count}`);
        continue;
      }
      const blocked = picked.filter((r) => r.unavailable);
      if (blocked.length) {
        for (const r of blocked) con.error(`${r.label}: ${r.unavailable}`);
        continue;
      }
      return picked.map((r) => r.id);
    }
  }

  // --- generic choices --------------------------------------------------------------------

  private async stepChoices(step: Step): Promise<void> {
    const visited = new Set<string>();
    let anyChoice = false;
    for (;;) {
      const res = resolve(this.build, this.catalog);
      const todo = res.choicesForStep(step).filter((c) => !visited.has(c.key));
      const first = todo[0];
      if (!first) break;
      anyChoice = true;
      await this.runChoice(first);
      visited.add(first.key);
    }
    if (!anyChoice) {
      this.con.info("Nothing to choose here yet — pick your class, species and background.");
    }
  }

  private async runChoice(choice: ActiveChoice): Promise<void> {
    const res = resolve(this.build, this.catalog);
    const d = choice.definition;
    const count = d.count > 1 ? ` (choose ${d.count})` : "";
    const src = choice.source;
    const via = src.granted_by ? ` (via ${src.granted_by})` : "";
    this.con.say();
    this.con.say(`${this.con.style(`${choice.label}${count}`, "bold")}  — from ${src.name}${via}`);
    const rows = res.options(choice).map((view) => this.choiceRow(choice, view));
    for (;;) {
      const picked = await this.select(rows, d.count, res.selected(choice), d.hint);
      if (this.apply(svc.setChoice, choice.key, picked)) return;
    }
  }

  private choiceRow(choice: ActiveChoice, view: OptionView): Row {
    const kind = choice.definition.kind;
    const sheet = this.sheet();
    let extra = view.description;
    let details = view.description;
    if ((kind === "skill" || kind === "skill_or_tool") && isSkill(view.id)) {
      const ability = SKILL_ABILITY[view.id];
      const mod = sheet.modifiers[ability] + sheet.proficiency_bonus;
      extra = `${ability.toUpperCase()} · ${signed(mod)} when proficient`;
    } else if (kind === "ability") {
      const a = view.id as Ability;
      extra = `your ${ABILITY_NAMES[a]} is ${sheet.scores[a]} (${signed(sheet.modifiers[a])})`;
    } else if (kind === "weapon_mastery") {
      const w = lookup(this.catalog.weapons, view.id);
      if (w) {
        const carried = Object.hasOwn(sheet.equipment, view.id) ? "★ in your gear · " : "";
        const props = w.properties.join(", ") || "no properties";
        extra = `${carried}${w.category} ${w.kind}, ${w.damage} ${w.damage_type}`;
        details = `${w.name}: ${w.damage} ${w.damage_type} · ${props}\n${view.description}`;
      }
    } else if ((kind === "feat" || kind === "option") && choice.definition.count === 1) {
      const preview = this.preview(choice, view.id);
      extra = [preview, shorten(view.description)].filter(Boolean).join(" · ");
    }
    return { id: view.id, label: view.name, extra, unavailable: view.unavailable, details };
  }

  /** What picking this option changes on the sheet, e.g. 'AC 16→17'. */
  private preview(choice: ActiveChoice, optionId: string): string {
    const without = Object.fromEntries(
      Object.entries(this.build.choices).filter(([k]) => k !== choice.key),
    );
    const before = this.sheet(updateBuild(this.build, { choices: without }));
    const after = this.sheet(
      updateBuild(this.build, { choices: { ...without, [choice.key]: [optionId] } }),
    );
    if (!after.scores_complete) return "";
    const hp = (s: DerivedSheet) => s.max_hp?.total ?? 0;
    const changes: string[] = [];
    for (const [label, a, b] of [
      ["AC", before.armor_class.total, after.armor_class.total],
      ["HP", hp(before), hp(after)],
      ["Init", before.initiative.total, after.initiative.total],
      ["Speed", before.speed.total, after.speed.total],
    ] as const) {
      if (a !== b) changes.push(`${label} ${a}→${b}`);
    }
    const newWarnings = after.warnings.filter((w) => !before.warnings.includes(w));
    changes.push(
      ...newWarnings.filter((w) => w.includes("Speed")).map((w) => `⚠ ${w.split(":")[0]}`),
    );
    if (choice.step === "equipment" && !changes.length) {
      changes.push(`AC ${after.armor_class.total}`);
    }
    return changes.length ? this.con.style(changes.join(", "), "cyan") : "";
  }

  // --- steps ------------------------------------------------------------------------------

  private async stepClass(): Promise<void> {
    const rows = Object.values(this.catalog.classes).map((cls): Row => {
      const primary = cls.primary_abilities
        .map((a) => ABILITY_NAMES[a])
        .join(cls.primary_mode === "any" ? " or " : " and ");
      const saves = cls.grants.saving_throws.map((a) => ABILITY_NAMES[a]).join(", ");
      const traits = cls.grants.traits.map((t) => `${t.name}: ${t.text}`).join("\n");
      return {
        id: cls.id,
        label: cls.name,
        extra: `Primary ${primary} · Hit Die d${cls.hit_die} · Complexity ${cls.complexity}`,
        details: `${cls.description}\nSaving throws: ${saves}\n${traits}`,
      };
    });
    const current = this.build.class_id ? [this.build.class_id] : [];
    const [picked] = await this.select(rows, 1, current);
    this.apply(svc.setClass, picked as string);
    if (Object.keys(this.catalog.classes).length === 1) {
      this.con.info("More classes will appear as they're added under content/*/classes/.");
    }
  }

  private async stepSpecies(): Promise<void> {
    const rows = Object.values(this.catalog.species).map((sp): Row => {
      const g = sp.grants;
      const speed = g.effects.find((e) => e.target === "speed")?.value ?? 30;
      const dv = g.effects.find((e) => e.target === "darkvision")?.value ?? 0;
      const size = g.size ? titleCase(g.size) : "Small/Medium";
      const senses = dv ? ` · Darkvision ${dv}` : "";
      const traits = g.traits.map((t) => `${t.name}: ${t.text}`).join("\n");
      const choices = g.choices.map((c) => c.label).join(", ");
      return {
        id: sp.id,
        label: sp.name,
        extra: `${size} · Speed ${speed}${senses} · ${sp.description}`,
        details: `${sp.description}\n${traits}\nChoices: ${choices || "none"}`,
      };
    });
    const current = this.build.species_id ? [this.build.species_id] : [];
    const [picked] = await this.select(rows, 1, current);
    if (this.apply(svc.setSpecies, picked as string)) await this.stepChoices("species");
  }

  private async stepBackground(): Promise<void> {
    const cls = lookup(this.catalog.classes, this.build.class_id);
    const primaries = new Set<Ability>(cls?.primary_abilities ?? []);
    const rows = Object.values(this.catalog.backgrounds).map((bg): Row => {
      const abilities = bg.ability_scores
        .map((a) => `${a.toUpperCase()}${primaries.has(a) ? "★" : ""}`)
        .join(", ");
      const feats = bg.grants.feats
        .map((f) => lookup(this.catalog.feats, f.feat)?.name ?? f.feat)
        .join(", ");
      const skills = bg.grants.skills.map(skillName).join(", ");
      const tools =
        bg.grants.tools.map((t) => lookup(this.catalog.tools, t)?.name ?? t).join(", ") ||
        "your choice";
      return {
        id: bg.id,
        label: bg.name,
        extra: `${abilities} · Feat ${feats} · ${skills}`,
        details:
          `${bg.description}\nAbility scores: ` +
          `${bg.ability_scores.map((a) => ABILITY_NAMES[a]).join(", ")}\n` +
          `Feat: ${feats}\nSkills: ${skills}\nTool: ${tools}`,
      };
    });
    const hint = cls ? `★ = your ${cls.name}'s primary ability` : "";
    const current = this.build.background_id ? [this.build.background_id] : [];
    const [picked] = await this.select(rows, 1, current, hint);
    this.apply(svc.setBackground, picked as string);
  }

  // --- ability scores ---------------------------------------------------------------------

  private async stepAbilities(): Promise<void> {
    const con = this.con;
    const rules = this.catalog.creation;
    if (!this.build.class_id) con.warn("Tip: choose a class first to get recommendations.");
    const rows: Row[] = [
      {
        id: "standard_array",
        label: "Standard Array",
        extra: `assign ${rules.standard_array.join(", ")}`,
      },
      { id: "point_buy", label: "Point Buy", extra: `spend ${rules.point_buy.budget} points` },
      { id: "roll", label: "Roll 4d6", extra: "drop the lowest die, six times" },
    ];
    const current = this.build.ability_method ? [this.build.ability_method] : [];
    const method = (await this.select(rows, 1, current))[0] as AbilityMethod;
    if (method !== this.build.ability_method || !Object.keys(this.build.base_scores).length) {
      const pool = method === "roll" ? await this.rollPool() : [];
      this.apply(svc.setAbilityMethod, method, pool);
    }
    if (method === "point_buy") await this.pointBuyEditor();
    else await this.assignEditor();
    await this.bonusEditor();
  }

  private async rollPool(): Promise<number[]> {
    for (;;) {
      const rolls = rollAbilityScores(this.rng);
      for (const r of rolls) {
        this.con.say(
          `  [${r.rolls.join(" ")}] drop ${r.dropped} → ${this.con.style(String(r.total), "bold")}`,
        );
      }
      this.con.say(`  Total ${rolls.reduce((sum, r) => sum + r.total, 0)}`);
      if (await this.con.confirm("Keep these rolls? (n rerolls — check with your GM)")) {
        return rolls.map((r) => r.total);
      }
    }
  }

  private primaries(): Set<Ability> {
    return new Set(lookup(this.catalog.classes, this.build.class_id)?.primary_abilities ?? []);
  }

  /** Map the class's recommended standard array onto any pool of six values. */
  private suggestion(pool: readonly number[]): AbilityMap | null {
    const cls = lookup(this.catalog.classes, this.build.class_id);
    if (!cls) return null;
    const ranked = [...ABILITIES].sort((a, b) => cls.standard_array[b] - cls.standard_array[a]);
    const values = [...pool].sort((a, b) => b - a);
    return Object.fromEntries(ranked.map((a, i) => [a, values[i]]));
  }

  private async assignEditor(): Promise<void> {
    const con = this.con;
    const rules = this.catalog.creation;
    const method = this.build.ability_method as AbilityMethod;
    const pool = method === "standard_array" ? rules.standard_array : this.build.rolled_pool;
    const suggestion = this.suggestion(pool);
    const primaries = this.primaries();
    for (;;) {
      const scores: AbilityMap = { ...this.build.base_scores };
      const free = unassignedValues(method, scores, rules, this.build.rolled_pool);
      con.say();
      for (const a of ABILITIES) {
        const star = primaries.has(a) ? "★" : " ";
        const score = scores[a];
        const value =
          score !== undefined ? `${padLeft(score, 2)} (${signed(abilityModifier(score))})` : "--";
        const hint = con.style(suggestion ? `suggested ${suggestion[a]}` : "", "dim");
        con.say(
          `  ${star} ${a.toUpperCase()} ${pad(ABILITY_NAMES[a], 13)} ${pad(value, 8)} ${hint}`,
        );
      }
      con.say(`  Unassigned: ${free.join(" ") || "none"}`);
      const answer = (
        await con.ask("Assign with 'str 15', 'swap str dex', 'suggest', 'clear', Enter when done >")
      ).toLowerCase();
      if (!answer) {
        if (free.length) {
          con.error("Assign every value first");
          continue;
        }
        return;
      }
      if (answer === "suggest") {
        if (suggestion === null) con.error("Choose a class to get a suggestion");
        else this.apply(svc.setBaseScores, suggestion);
        continue;
      }
      if (answer === "clear") {
        this.apply(svc.setBaseScores, {});
        continue;
      }
      const parts = answer.split(/\s+/);
      if (parts.length === 3 && parts[0] === "swap") {
        const a = parseAbility(parts[1] as string);
        const b = parseAbility(parts[2] as string);
        const sa = a ? scores[a] : undefined;
        const sb = b ? scores[b] : undefined;
        if (a && b && sa !== undefined && sb !== undefined) {
          scores[a] = sb;
          scores[b] = sa;
          this.apply(svc.setBaseScores, scores);
        } else {
          con.error("Swap two abilities that both have values");
        }
        continue;
      }
      if (parts.length === 2 && /^\d+$/.test(parts[1] as string)) {
        const ability = parseAbility(parts[0] as string);
        const value = Number(parts[1]);
        if (ability === null) {
          con.error(`Unknown ability '${parts[0]}'`);
          continue;
        }
        const released = scores[ability];
        delete scores[ability];
        const available = released !== undefined ? [...free, released] : free;
        if (!available.includes(value)) {
          const left = [...available].sort((x, y) => y - x);
          con.error(`${value} isn't available (unassigned: [${left.join(", ")}])`);
          continue;
        }
        scores[ability] = value;
        this.apply(svc.setBaseScores, scores);
        continue;
      }
      con.error("Try 'str 15', 'swap str dex', 'suggest' or 'clear'");
    }
  }

  private async pointBuyEditor(): Promise<void> {
    const con = this.con;
    const rules = this.catalog.creation.point_buy;
    const primaries = this.primaries();
    const suggestion = this.suggestion(this.catalog.creation.standard_array);
    const minimum = () => Object.fromEntries(ABILITIES.map((a) => [a, rules.min_score]));
    if (Object.keys(this.build.base_scores).length < ABILITIES.length) {
      this.apply(svc.setBaseScores, { ...minimum(), ...this.build.base_scores });
    }
    for (;;) {
      const scores: AbilityMap = { ...this.build.base_scores };
      const status = pointBuyStatus(scores, rules);
      con.say();
      con.say(con.style("    Ability          Score Mod  Cost  +1 costs  Max reachable", "bold"));
      for (const a of ABILITIES) {
        const st = status.abilities[a];
        const star = primaries.has(a) ? "★" : " ";
        let inc = st.increase_cost === null ? "at max" : `${st.increase_cost} pt`;
        if (st.increase_cost !== null && !st.can_increase) inc = con.style(`${inc} ✘`, "red");
        con.say(
          `  ${star} ${a.toUpperCase()} ${pad(ABILITY_NAMES[a], 13)} ${padLeft(st.score, 3)} ` +
            `${padLeft(signed(abilityModifier(st.score)), 4)} ${padLeft(st.cost, 5)}  ${pad(inc, 9)} ` +
            `${padLeft(st.max_affordable, 6)}`,
        );
      }
      const left = con.style(String(status.remaining), status.remaining ? "green" : "bold");
      con.say(`  Points spent ${status.spent}/${status.budget} · ${left} left`);
      const answer = (
        await con.ask("'+str' / '-dex' / 'con 14', 'suggest', 'reset', Enter when done >")
      )
        .toLowerCase()
        .replaceAll(" ", "");
      if (!answer) {
        if (
          status.remaining &&
          !(await con.confirm(`${status.remaining} points unspent. Finish anyway?`, false))
        ) {
          continue;
        }
        return;
      }
      if (answer === "reset") {
        this.apply(svc.setBaseScores, minimum());
        continue;
      }
      if (answer === "suggest") {
        if (suggestion === null) con.error("Choose a class to get a suggestion");
        else this.apply(svc.setBaseScores, suggestion);
        continue;
      }
      const m = /^(?:([+-])([a-z]+)|([a-z]+)(\d+))$/.exec(answer);
      const ability = parseAbility(m ? ((m[2] ?? m[3]) as string) : "");
      if (!m || ability === null) {
        con.error("Try '+str', '-dex' or 'con 14'");
        continue;
      }
      const currentScore = scores[ability] ?? rules.min_score;
      const target = m[1] ? currentScore + (m[1] === "+" ? 1 : -1) : Number(m[4]);
      if (target < rules.min_score || target > rules.max_score) {
        con.error(`Point buy scores range from ${rules.min_score} to ${rules.max_score}`);
        continue;
      }
      const newCost = status.spent - (rules.costs[currentScore] ?? 0) + (rules.costs[target] ?? 0);
      if (newCost > rules.budget) {
        con.error(
          `${ABILITY_NAMES[ability]} ${target} needs ${newCost - status.spent} more points; ` +
            `you have ${status.remaining} ` +
            `(max reachable: ${status.abilities[ability].max_affordable})`,
        );
        continue;
      }
      scores[ability] = target;
      this.apply(svc.setBaseScores, scores);
    }
  }

  private async bonusEditor(): Promise<void> {
    const con = this.con;
    const bg = lookup(this.catalog.backgrounds, this.build.background_id);
    if (!bg) {
      con.warn("Choose a background to apply its ability score increases.");
      return;
    }
    const base = this.build.base_scores;
    if (Object.keys(base).length < ABILITIES.length) return;
    const cap = this.catalog.creation.max_score_at_creation;
    const primaries = this.primaries();
    con.say();
    con.say(
      `${con.style(`${bg.name} ability score increases`, "bold")} — ` +
        bg.ability_scores.map((a) => ABILITY_NAMES[a]).join(", "),
    );
    const current = Object.entries(this.build.background_bonus) as [Ability, number][];
    const currentPattern = current.length
      ? [
          current
            .map(([, v]) => v)
            .sort()
            .join(",") === "1,2"
            ? "2-1"
            : "1-1-1",
        ]
      : [];
    const [pattern] = await this.select(
      [
        { id: "2-1", label: "+2 and +1", extra: "focus: push one score higher" },
        { id: "1-1-1", label: "+1 / +1 / +1", extra: "spread: good for evening out odd scores" },
      ],
      1,
      currentPattern,
    );
    if (pattern === "1-1-1") {
      this.apply(svc.setBackgroundBonus, Object.fromEntries(bg.ability_scores.map((a) => [a, 1])));
      return;
    }

    const rows = (inc: number, options: readonly Ability[]): Row[] =>
      options.map((a) => {
        const before = base[a] as number;
        const after = before + inc;
        const mods = `${signed(abilityModifier(before))} → ${signed(abilityModifier(after))}`;
        const gain = abilityModifier(after) > abilityModifier(before) ? " · raises modifier" : "";
        const star = primaries.has(a) ? " · ★ primary" : "";
        return {
          id: a,
          label: ABILITY_NAMES[a],
          extra: `${before} → ${after} (${mods})${gain}${star}`,
          unavailable: after > cap ? `can't exceed ${cap}` : null,
        };
      });

    con.say("Which ability gets +2?");
    const plus2 = (
      await this.select(
        rows(2, bg.ability_scores),
        1,
        current.filter(([, v]) => v === 2).map(([a]) => a),
      )
    )[0] as Ability;
    con.say("Which ability gets +1?");
    const others = bg.ability_scores.filter((a) => a !== plus2);
    const plus1 = (
      await this.select(
        rows(1, others),
        1,
        current.filter(([a, v]) => v === 1 && a !== plus2).map(([a]) => a),
      )
    )[0] as Ability;
    this.apply(svc.setBackgroundBonus, { [plus2]: 2, [plus1]: 1 });
  }

  // --- features / proficiencies / details -------------------------------------------------

  private async stepFeatures(): Promise<void> {
    const res = resolve(this.build, this.catalog);
    for (const src of res.featSources()) {
      if (!(src.key.split("@")[1] ?? "").includes("#")) {
        // Granted outright, not chosen here.
        this.con.info(`${src.name} (from ${src.granted_by}): ${src.feat.description}`);
      }
    }
    for (const issue of issuesForStep(evaluate(this.build, this.catalog).report, "features")) {
      if (issue.severity === "note") this.con.warn(issue.message);
    }
    await this.stepChoices("features");
  }

  private async stepProficiencies(): Promise<void> {
    const res = resolve(this.build, this.catalog);
    const fixed = [...res.skills()]
      .filter(([s]) => !res.choices.some((c) => res.selected(c).includes(s)))
      .map(([s, src]) => `${skillName(s)} (${src})`);
    if (fixed.length) this.con.info(`Already proficient: ${fixed.join(", ")}`);
    await this.stepChoices("proficiencies");
  }

  private async stepDetails(): Promise<void> {
    const con = this.con;
    const current = this.build.name;
    for (;;) {
      const name = (await con.ask(`Name${current ? ` [${current}]` : ""} >`)) || current;
      if (this.apply(svc.setName, name)) break;
    }
    const rows = ALIGNMENTS.map((a): Row => ({ id: a, label: ALIGNMENT_NAMES[a], extra: a }));
    const currentAlignment = this.build.alignment ? [this.build.alignment] : [];
    const [picked] = await this.select(rows, 1, currentAlignment);
    this.apply(svc.setAlignment, picked as Alignment);
  }

  private async review(): Promise<void> {
    const ev = evaluate(this.build, this.catalog);
    renderSheet(ev, this.con, this.catalog);
    this.con.say();
    for (const issue of ev.report.issues) {
      const where = STEP_TITLES[issue.step];
      if (issue.severity === "error") this.con.error(`[${where}] ${issue.message}`);
      else if (issue.severity === "pending") this.con.warn(`[${where}] ${issue.message}`);
      else this.con.info(`[${where}] note: ${issue.message}`);
    }
    if (ev.report.is_complete) {
      this.con.say(this.con.style("✔ Your character is complete and valid.", "green", "bold"));
      try {
        if (await this.con.confirm("Save it?")) this.save();
      } catch (error) {
        if (!(error instanceof BackToMenu)) throw error;
      }
    }
  }

  save(): string {
    const slug =
      this.build.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "character";
    mkdirSync(this.saveDir, { recursive: true });
    const path = join(this.saveDir, `${slug}.json`);
    writeFileSync(path, `${JSON.stringify(this.build, null, 2)}\n`, "utf-8");
    this.dirty = false;
    this.con.say(this.con.style(`Saved to ${path}`, "green"));
    return path;
  }
}

function parseAbility(token: string): Ability | null {
  const t = token.toLowerCase();
  if (t.length < 3) return null;
  return ABILITIES.find((a) => ABILITY_NAMES[a].toLowerCase().startsWith(t) || a === t) ?? null;
}
