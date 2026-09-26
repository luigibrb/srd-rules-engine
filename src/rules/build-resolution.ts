/**
 * Resolve a build into its active content sources and the choices they ask for.
 *
 * A *source* is anything that grants something: the base creation rules, a class level, a
 * subclass level, the species, a chosen option (e.g. Wood Elf), the background, a feat, an
 * equipment package. Sources declare *choices*; answering a choice can activate new sources
 * (choosing the Skilled feat adds a source that asks for three proficiencies).
 *
 * Keys are stable strings so a build can store answers without nesting:
 *
 * - source: `creation`, `species:elf`, `background:soldier`
 * - class levels: `class:fighter` (your first level in the class, whether you started in it or
 *   multiclassed into it), then `class:fighter:2` … `class:fighter:20`
 * - subclass levels: `subclass:champion:3`, `subclass:champion:7`, …
 * - choice: `<source key>#<choice id>`, e.g. `species:elf#lineage`, `class:fighter:4#feat`
 * - option source: `<choice key>=<option id>`, e.g. `species:elf#lineage=wood-elf`
 * - feat source: `feat:<feat id>@<granting source or choice key>`
 * - feature source: `feature:<feature id>@<choice key>` (Eldritch Invocations, Metamagic)
 */

import { type Catalog, lookup } from "../content/catalog";
import type { CharacterBuild } from "../models/build";
import {
  ABILITIES,
  ABILITY_NAMES,
  type Ability,
  type ChoiceDef,
  type ChoiceKind,
  choiceStep,
  type Effect,
  type FeatDef,
  type GrantedIdList,
  type Grants,
  isSkill,
  type Prerequisite,
  SKILL_ABILITY,
  SKILLS,
  type Skill,
  type Step,
  type SubclassDef,
  skillName,
} from "../models/content";
import { finalScores } from "./ability-scores";
import { isWeaponProficient } from "./weapons";

/** Ability score used when none has been assigned yet. */
export const DEFAULT_SCORE = 10;

export interface ActiveSource {
  readonly key: string;
  readonly name: string;
  readonly grants: Grants;
  readonly params: Readonly<Record<string, string>>;
  readonly feat: FeatDef | null;
  /** A selectable class feature (Eldritch Invocation, Metamagic option). */
  readonly feature: FeatDef | null;
  readonly description: string;
  /** Name of the source that granted this one (feats). */
  readonly granted_by: string;
  /** The character level at which this source was gained. */
  readonly level: number;
  /** The class a class or subclass feature belongs to (and everything it grants). */
  readonly class_id: string | null;
}

export interface ActiveChoice {
  readonly key: string;
  readonly source: ActiveSource;
  readonly definition: ChoiceDef;
  readonly label: string;
  readonly step: Step;
  /** The character level at which this choice is made. */
  readonly level: number;
  /** Answer pre-filled by the granting source (e.g. Acolyte's Magic Initiate list). */
  readonly fixed: readonly string[] | null;
}

/** One level of the character: which class it went into. */
export interface ClassLevel {
  /** Character level (1–20). */
  readonly level: number;
  readonly class_id: string;
  /** Level in that class after this level. */
  readonly class_level: number;
  /** Hit Die roll for this level, or `null` for the fixed value (always `null` at level 1). */
  readonly hp: number | null;
}

/** One selectable option, with the reason it can't be picked (if any). */
export interface OptionView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly unavailable: string | null;
}

function source(
  key: string,
  name: string,
  grants: Grants,
  extra: Partial<Omit<ActiveSource, "key" | "name" | "grants">> = {},
): ActiveSource {
  return {
    key,
    name,
    grants,
    params: {},
    feat: null,
    feature: null,
    description: "",
    granted_by: "",
    level: 1,
    class_id: null,
    ...extra,
  };
}

function activeChoice(src: ActiveSource, definition: ChoiceDef): ActiveChoice {
  const value = Object.hasOwn(src.params, definition.id) ? src.params[definition.id] : undefined;
  return {
    key: `${src.key}#${definition.id}`,
    source: src,
    definition,
    label: definition.label,
    step: choiceStep(definition),
    level: src.level,
    fixed: value !== undefined ? [value] : null,
  };
}

function view(id: string, name: string, description = "", unavailable: string | null = null) {
  return { id, name, description, unavailable } satisfies OptionView;
}

/** Combine two grants (a class's core traits and its level 1 features) into one. */
export function mergeGrants(a: Grants, b: Grants): Grants {
  const out = { ...a } as Record<string, unknown>;
  for (const [key, value] of Object.entries(b)) {
    const current = out[key];
    if (Array.isArray(value)) out[key] = [...(current as unknown[]), ...value];
    else if (typeof value === "number") out[key] = ((current as number) ?? 0) + value;
    else if (value !== null) out[key] = value;
  }
  return out as unknown as Grants;
}

export class Resolution {
  constructor(
    readonly build: CharacterBuild,
    readonly catalog: Catalog,
    readonly sources: readonly ActiveSource[],
    readonly choices: readonly ActiveChoice[],
    /** Every character level with the class it went into, in order. */
    readonly levels: readonly ClassLevel[],
  ) {}

  get characterLevel(): number {
    return 1 + this.build.levels.length;
  }

  // --- choice access ----------------------------------------------------------------------

  selected(choice: ActiveChoice): readonly string[] {
    return choice.fixed ?? answers(this.build, choice.key);
  }

  /**
   * How many answers a choice needs. Usually its `count`, but an Expertise choice ("in which you
   * have proficiency") or a spell choice (you can't learn a spell twice) needs no more than the
   * options left, e.g. when a multiclass caster already knows every cantrip on a short list.
   * A spell choice whose list depends on an unanswered choice still needs its full count.
   */
  required(choice: ActiveChoice): number {
    const { count, kind, spell_list } = choice.definition;
    if (kind !== "expertise" && kind !== "spell") return count;
    if (kind === "spell" && spell_list?.some((l) => this.resolveRef(choice.source, l) === null)) {
      return count;
    }
    const selected = this.selected(choice);
    const eligible = this.options(choice).filter((o) => !o.unavailable || selected.includes(o.id));
    return Math.min(count, eligible.length);
  }

  choice(key: string): ActiveChoice | undefined {
    return this.choices.find((c) => c.key === key);
  }

  /** Level 1 choices asked in a step, in order. Expertise comes last: it needs every skill pick. */
  choicesForStep(step: Step): ActiveChoice[] {
    return expertiseLast(
      this.choices.filter((c) => c.level === 1 && c.step === step && c.fixed === null),
    );
  }

  /** The choices made when reaching a character level (2+), in the order to ask them. */
  choicesForLevel(level: number): ActiveChoice[] {
    const order: Step[] = ["features", "spells", "proficiencies", "languages"];
    const rank = (c: ActiveChoice) => (order.includes(c.step) ? order.indexOf(c.step) : -1);
    const atLevel = this.choices.filter((c) => c.level === level && c.fixed === null);
    return expertiseLast([...atLevel].sort((a, b) => rank(a) - rank(b)));
  }

  /** Another choice declared by the same source, by its id (e.g. Magic Initiate's `spell_list`). */
  sibling(choice: ActiveChoice, id: string): ActiveChoice | undefined {
    return this.choice(`${choice.source.key}#${id}`);
  }

  /**
   * Resolve a content value that may refer to a sibling choice (`"$spell_list"`): the first
   * answer to that choice, or `null` while it's unanswered.
   */
  resolveRef(src: ActiveSource, value: string): string | null {
    if (!value.startsWith("$")) return value;
    const ref = this.choice(`${src.key}#${value.slice(1)}`);
    return (ref && this.selected(ref)[0]) ?? null;
  }

  private *selections(
    kinds: readonly ChoiceKind[],
    exclude?: string,
  ): Generator<[string, ActiveChoice]> {
    for (const c of this.choices) {
      if (kinds.includes(c.definition.kind) && c.key !== exclude) {
        for (const value of this.selected(c)) yield [value, c];
      }
    }
  }

  // --- classes and levels -----------------------------------------------------------------

  /** Class id → class level, counting character levels up to `atLevel`. */
  classLevels(atLevel = Number.POSITIVE_INFINITY): Map<string, number> {
    const out = new Map<string, number>();
    for (const l of this.levels) if (l.level <= atLevel) out.set(l.class_id, l.class_level);
    return out;
  }

  /** The subclass chosen for a class, if any. */
  subclassOf(classId: string): SubclassDef | undefined {
    for (const c of this.choices) {
      if (c.definition.kind === "subclass" && c.source.class_id === classId) {
        const sub = lookup(this.catalog.subclasses, this.selected(c)[0]);
        if (sub?.class === classId) return sub;
      }
    }
    return undefined;
  }

  // --- ability scores ---------------------------------------------------------------------

  /**
   * Ability scores from before the given character level: base scores, background bonus, then
   * every increase gained at an earlier level (feats, Primal Champion…), each within its cap.
   * Without a level, all increases count. Unassigned scores count as 10.
   */
  abilityScores(beforeLevel = Number.POSITIVE_INFINITY): Record<Ability, number> {
    const known = finalScores(this.build.base_scores, this.build.background_bonus);
    const scores = Object.fromEntries(
      ABILITIES.map((a) => [a, known[a] ?? DEFAULT_SCORE]),
    ) as Record<Ability, number>;
    const raise = (a: Ability, by: number, max: number) => {
      scores[a] = Math.max(scores[a], Math.min(max, scores[a] + by));
    };
    const increases: { level: number; apply: () => void }[] = [];
    for (const c of this.choices) {
      if (c.definition.kind !== "ability_increase" || c.level >= beforeLevel) continue;
      for (const value of this.selected(c)) {
        if ((ABILITIES as readonly string[]).includes(value)) {
          increases.push({
            level: c.level,
            apply: () => raise(value as Ability, 1, c.definition.max_score),
          });
        }
      }
    }
    for (const src of this.sources) {
      if (src.level >= beforeLevel) continue;
      for (const bonus of src.grants.ability_bonuses) {
        increases.push({
          level: src.level,
          apply: () => raise(bonus.ability, bonus.value, bonus.max),
        });
      }
    }
    increases.sort((a, b) => a.level - b.level);
    for (const inc of increases) inc.apply();
    return scores;
  }

  /** Why a prerequisite isn't met by a choice made at `level`, or `null` if it is. */
  unmetPrerequisite(
    pre: Prerequisite | null,
    level: number,
    excludeChoice?: string,
  ): string | null {
    if (!pre) return null;
    if (pre.level !== null && level < pre.level) return `requires level ${pre.level}+`;
    if (pre.class_level) {
      const have = this.classLevels(level).get(pre.class_level.class) ?? 0;
      if (have < pre.class_level.level) {
        const name =
          lookup(this.catalog.classes, pre.class_level.class)?.name ?? pre.class_level.class;
        return pre.class_level.level > 1
          ? `requires ${name} level ${pre.class_level.level}+`
          : `requires ${name}`;
      }
    }
    if (pre.abilities) {
      const scores = this.abilityScores(level);
      if (!pre.abilities.any_of.some((a) => scores[a] >= (pre.abilities?.min ?? 0))) {
        const names = pre.abilities.any_of.map((a) => ABILITY_NAMES[a]).join(" or ");
        return `requires ${names} ${pre.abilities.min}+`;
      }
    }
    const owned = new Set(
      this.sources
        .filter((s) => s.level <= level && !s.key.endsWith(`@${excludeChoice}`))
        .flatMap((s) => [s.feat?.id, s.feature?.id])
        .filter((id): id is string => id !== undefined),
    );
    for (const id of pre.requires) {
      if (!owned.has(id)) {
        const name =
          lookup(this.catalog.features, id)?.name ?? lookup(this.catalog.feats, id)?.name ?? id;
        return `requires ${name}`;
      }
    }
    if (pre.trait) {
      const has = this.sources.some(
        (s) => s.level <= level && s.grants.traits.some((t) => t.name === pre.trait),
      );
      if (!has) return `requires the ${pre.trait} feature`;
    }
    if (pre.spells.length) {
      const known = this.spells(new Set(excludeChoice ? [excludeChoice] : []));
      if (!pre.spells.some((id) => known.has(id))) {
        const names = pre.spells.map((id) => lookup(this.catalog.spells, id)?.name ?? id);
        return `requires knowing ${names.join(" or ")}`;
      }
    }
    if (pre.spellcasting) {
      const has = this.sources.some((s) => s.level <= level && s.grants.spellcasting?.progression);
      if (!has) return "requires the Spellcasting or Pact Magic feature";
    }
    return null;
  }

  // --- aggregated grants (fixed + selected) ---------------------------------------------

  /** Skill → name of the source that made you proficient. */
  skills(excludeChoice?: string): Map<Skill, string> {
    const owned = new Map<Skill, string>();
    for (const src of this.sources) {
      for (const skill of src.grants.skills) setDefault(owned, skill, src.name);
    }
    for (const [value, c] of this.selections(["skill", "skill_or_tool"], excludeChoice)) {
      if (isSkill(value)) setDefault(owned, value, c.source.name);
    }
    return owned;
  }

  /** Tool id → name of the source that made you proficient. */
  tools(excludeChoice?: string): Map<string, string> {
    const owned = new Map<string, string>();
    for (const src of this.sources) {
      for (const tool of src.grants.tools) setDefault(owned, tool, src.name);
    }
    for (const [value, c] of this.selections(["tool", "skill_or_tool"], excludeChoice)) {
      if (lookup(this.catalog.tools, value)) setDefault(owned, value, c.source.name);
    }
    return owned;
  }

  /** Language id → name of the source that taught it. */
  languages(excludeChoice?: string): Map<string, string> {
    const owned = new Map<string, string>();
    for (const src of this.sources) {
      for (const lang of src.grants.languages) setDefault(owned, lang, src.name);
    }
    for (const [value, c] of this.selections(["language"], excludeChoice)) {
      setDefault(owned, value, c.source.name);
    }
    return owned;
  }

  /**
   * Spell id → name of the source that gives it: granted cantrips and always-prepared spells,
   * plus every spell choice (except the given choice keys).
   */
  spells(excludeChoices: ReadonlySet<string> = new Set()): Map<string, string> {
    const owned = new Map<string, string>();
    for (const src of this.sources) {
      for (const id of [...src.grants.cantrips, ...src.grants.spells]) {
        setDefault(owned, id, src.name);
      }
    }
    for (const c of this.choices) {
      // A known_only choice points at spells you already have; it doesn't teach one.
      if (c.definition.kind !== "spell" || c.definition.known_only || excludeChoices.has(c.key))
        continue;
      for (const value of this.selected(c)) setDefault(owned, value, c.source.name);
    }
    return owned;
  }

  /** Skill → name of the source that gave you Expertise in it. */
  expertise(excludeChoice?: string): Map<Skill, string> {
    const owned = new Map<Skill, string>();
    for (const [value, c] of this.selections(["expertise"], excludeChoice)) {
      if (isSkill(value)) setDefault(owned, value, c.source.name);
    }
    return owned;
  }

  featSources(): (ActiveSource & { feat: FeatDef })[] {
    return this.sources.filter((s): s is ActiveSource & { feat: FeatDef } => s.feat !== null);
  }

  featureSources(): (ActiveSource & { feature: FeatDef })[] {
    return this.sources.filter((s): s is ActiveSource & { feature: FeatDef } => s.feature !== null);
  }

  weaponMasteries(): string[] {
    return [...this.selections(["weapon_mastery"])].map(([v]) => v);
  }

  savingThrows(): Set<Ability> {
    return new Set(this.sources.flatMap((s) => s.grants.saving_throws));
  }

  effects(): [Effect, ActiveSource][] {
    return this.sources.flatMap((s) => s.grants.effects.map((e): [Effect, ActiveSource] => [e, s]));
  }

  /** Concatenate a list of granted ids across sources, preserving order, without repeats. */
  granted(attr: GrantedIdList): string[] {
    return [...new Set(this.sources.flatMap((s) => s.grants[attr]))];
  }

  // --- option views -----------------------------------------------------------------------

  /** Every option for a choice, each with the reason it's unavailable (if any). */
  options(choice: ActiveChoice): OptionView[] {
    return optionViews(this, choice);
  }
}

/** The answers stored in a build for a choice key (empty if unanswered). */
export function answers(build: CharacterBuild, key: string): readonly string[] {
  return (Object.hasOwn(build.choices, key) ? build.choices[key] : undefined) ?? [];
}

/** Source key of a class level: `class:wizard` for the first level, then `class:wizard:2`… */
export function classLevelKey(classId: string, classLevel: number): string {
  return classLevel === 1 ? `class:${classId}` : `class:${classId}:${classLevel}`;
}

export function resolve(build: CharacterBuild, catalog: Catalog): Resolution {
  const sources: ActiveSource[] = [];
  const choices: ActiveChoice[] = [];

  const addFeat = (
    featId: string,
    key: string,
    params: Readonly<Record<string, string>>,
    parent: ActiveSource,
  ) => {
    const feat = lookup(catalog.feats, featId);
    if (feat) {
      addSource(
        source(key, feat.name, feat.grants, {
          params,
          feat,
          granted_by: parent.name,
          level: parent.level,
          class_id: parent.class_id,
        }),
      );
    }
  };

  const addSource = (src: ActiveSource): void => {
    if (sources.some((s) => s.key === src.key)) return;
    sources.push(src);
    // Grants that switch on at higher levels of the source's class.
    for (const gate of src.grants.at_class_level) {
      const reached = src.class_id
        ? levels.find((l) => l.class_id === src.class_id && l.class_level === gate.level)
        : undefined;
      if (reached) {
        addSource({
          ...src,
          key: `${src.key}+${gate.level}`,
          grants: gate.grants,
          level: reached.level,
        });
      }
    }
    for (const grant of src.grants.feats) {
      addFeat(grant.feat, `feat:${grant.feat}@${src.key}`, grant.params, src);
    }
    for (const definition of src.grants.choices) {
      const choice = activeChoice(src, definition);
      choices.push(choice);
      const picked = choice.fixed ?? answers(build, choice.key);
      const inherit = { level: src.level, class_id: src.class_id };
      if (definition.kind === "option") {
        for (const optId of picked) {
          const opt = definition.options.find((o) => o.id === optId);
          if (opt) {
            addSource(
              source(`${choice.key}=${optId}`, `${opt.name} (${src.name})`, opt.grants, {
                description: opt.description,
                ...inherit,
              }),
            );
          }
        }
      } else if (definition.kind === "feat") {
        for (const featId of picked) addFeat(featId, `feat:${featId}@${choice.key}`, {}, src);
      } else if (definition.kind === "feature") {
        for (const id of picked) {
          const feature = lookup(catalog.features, id);
          if (feature) {
            addSource(
              source(`feature:${id}@${choice.key}`, feature.name, feature.grants, {
                feature,
                granted_by: src.name,
                ...inherit,
              }),
            );
          }
        }
      }
    }
  };

  // Every character level and the class it went into.
  const levels: ClassLevel[] = [];
  const counts = new Map<string, number>();
  const entries = [
    ...(build.class_id !== null ? [{ class_id: build.class_id, hp: null, level: 1 }] : []),
    ...build.levels.map((l, i) => ({ ...l, level: i + 2 })),
  ];
  for (const entry of entries) {
    const classLevel = (counts.get(entry.class_id) ?? 0) + 1;
    counts.set(entry.class_id, classLevel);
    levels.push({
      level: entry.level,
      class_id: entry.class_id,
      class_level: classLevel,
      hp: entry.hp,
    });
  }

  const addClassLevel = (l: ClassLevel) => {
    const cls = lookup(catalog.classes, l.class_id);
    if (!cls) return;
    const features = cls.features[String(l.class_level)] ?? EMPTY_GRANTS;
    const grants =
      l.class_level === 1
        ? mergeGrants(l.level === 1 ? cls.grants : cls.multiclass, features)
        : features;
    const base = { level: l.level, class_id: cls.id };
    addSource(source(classLevelKey(cls.id, l.class_level), cls.name, grants, base));
    const sub = subclassFor(cls.id);
    const subFeatures = sub?.features[String(l.class_level)];
    if (sub && subFeatures) {
      addSource(source(`subclass:${sub.id}:${l.class_level}`, sub.name, subFeatures, base));
    }
  };

  const subclassFor = (classId: string): SubclassDef | undefined => {
    for (const c of choices) {
      if (c.definition.kind === "subclass" && c.source.class_id === classId) {
        const sub = lookup(catalog.subclasses, (c.fixed ?? answers(build, c.key))[0]);
        if (sub?.class === classId) return sub;
      }
    }
    return undefined;
  };

  addSource(source("creation", "Character creation", catalog.creation.base_grants));
  const [first, ...rest] = levels;
  if (first) addClassLevel(first);
  const species = lookup(catalog.species, build.species_id);
  if (species) addSource(source(`species:${species.id}`, species.name, species.grants));
  const background = lookup(catalog.backgrounds, build.background_id);
  if (background) {
    addSource(source(`background:${background.id}`, background.name, background.grants));
  }
  for (const l of rest) addClassLevel(l);

  return new Resolution(build, catalog, sources, choices, levels);
}

const EMPTY_GRANTS = Object.freeze({
  size: null,
  skills: [],
  tools: [],
  languages: [],
  saving_throws: [],
  armor_training: [],
  weapon_proficiencies: [],
  feats: [],
  resistances: [],
  cantrips: [],
  spells: [],
  spellcasting: null,
  ac_calculations: [],
  ability_bonuses: [],
  effects: [],
  items: [],
  gp: 0,
  traits: [],
  choices: [],
  at_class_level: [],
}) as Grants;

function expertiseLast(choices: ActiveChoice[]): ActiveChoice[] {
  const last = (c: ActiveChoice) => (c.definition.kind === "expertise" ? 1 : 0);
  return [...choices].sort((a, b) => last(a) - last(b));
}

// --- options ------------------------------------------------------------------------------

function optionViews(res: Resolution, choice: ActiveChoice): OptionView[] {
  const d = choice.definition;
  const cat = res.catalog;
  const ok = (id: string) => d.allowed === null || d.allowed.includes(id);
  const inCategory = (category: string) => d.category === null || d.category.includes(category);

  switch (d.kind) {
    case "option": {
      const taken = takenByOtherInstances(res, choice);
      return d.options.map((o) =>
        view(
          o.id,
          o.name,
          o.description,
          taken.has(o.id) ? `already chosen for ${taken.get(o.id)}` : null,
        ),
      );
    }
    case "ability":
      return ABILITIES.filter(ok).map((a) => view(a, ABILITY_NAMES[a]));
    case "ability_increase": {
      const scores = res.abilityScores(choice.level);
      return ABILITIES.filter(ok).map((a) =>
        view(
          a,
          ABILITY_NAMES[a],
          `currently ${scores[a]}`,
          scores[a] >= d.max_score ? `already at ${d.max_score}` : null,
        ),
      );
    }
    case "skill":
      return skillViews(res, choice, ok);
    case "tool":
      return toolViews(res, choice, ok);
    case "skill_or_tool":
      return [...skillViews(res, choice, ok), ...toolViews(res, choice, ok)];
    case "language": {
      const known = res.languages(choice.key);
      return Object.values(cat.languages)
        .filter((lang) => ok(lang.id) && inCategory(lang.category))
        .map((lang) => view(lang.id, lang.name, "", knownFrom(known.get(lang.id))));
    }
    case "feat":
    case "feature": {
      const isFeat = d.kind === "feat";
      const owned = new Map(
        (isFeat
          ? res.featSources().map((s) => [s.feat.id, s] as const)
          : res.featureSources().map((s) => [s.feature.id, s] as const)
        )
          .filter(([, s]) => !s.key.endsWith(`@${choice.key}`))
          .map(([id, s]) => [id, s.name]),
      );
      return Object.values(isFeat ? cat.feats : cat.features)
        .filter((feat) => ok(feat.id) && inCategory(feat.category))
        .map((feat) => {
          let reason: string | null = null;
          if (owned.has(feat.id) && !feat.repeatable) {
            reason = isFeat ? "you already have this feat" : "you already have this";
          } else if (repeatsExhausted(res, feat, choice.key)) {
            reason = "you already have it with every option";
          } else {
            reason = res.unmetPrerequisite(feat.prerequisite, choice.level, choice.key);
          }
          return view(feat.id, feat.name, feat.description, reason);
        });
    }
    case "subclass":
      return Object.values(cat.subclasses)
        .filter((s) => s.class === choice.source.class_id && ok(s.id))
        .map((s) => view(s.id, s.name, s.description));
    case "weapon_mastery": {
      const proficiencies = res.granted("weapon_proficiencies");
      return Object.values(cat.weapons)
        .filter(
          (w) => ok(w.id) && inCategory(w.category) && (!d.weapon_kind || w.kind === d.weapon_kind),
        )
        .map((w) => {
          const mastery = cat.masteries[w.mastery];
          const name = mastery?.name ?? w.mastery;
          const unavailable = isWeaponProficient(w, proficiencies) ? null : "not proficient";
          return view(
            w.id,
            `${w.name} (${name})`,
            `${name}: ${mastery?.description ?? ""}`,
            unavailable,
          );
        });
    }
    case "spell":
      return spellViews(res, choice, ok);
    case "expertise": {
      const proficient = res.skills();
      const expert = res.expertise(choice.key);
      return SKILLS.filter(ok).map((s) => {
        let reason: string | null = null;
        if (!proficient.has(s)) reason = "not proficient";
        else if (expert.has(s)) reason = `already have Expertise from ${expert.get(s)}`;
        return view(s, skillName(s), `${ABILITY_NAMES[SKILL_ABILITY[s]]} skill`, reason);
      });
    }
  }
}

function spellViews(res: Resolution, choice: ActiveChoice, ok: (id: string) => boolean) {
  const d = choice.definition;
  let lists: string[] | null = null;
  if (d.spell_list !== null) {
    lists = [];
    for (const entry of d.spell_list) {
      const list = res.resolveRef(choice.source, entry);
      if (list === null) return []; // the list isn't chosen yet
      lists.push(list);
    }
  }
  let spells = Object.values(res.catalog.spells).filter(
    (s) =>
      ok(s.id) &&
      (d.spell_level === null || s.level === d.spell_level) &&
      (d.max_spell_level === null || (s.level >= 1 && s.level <= d.max_spell_level)) &&
      (lists === null || s.lists.some((l) => lists.includes(l))) &&
      (!d.ritual || s.ritual) &&
      (d.school === null || s.school === d.school),
  );
  // Choices tied by subset_of (spellbook ⊇ prepared) share spells by design.
  const linked = new Set([choice.key]);
  if (d.subset_of !== null) {
    const pool = res.choices.filter((c) => c.definition.tag === d.subset_of);
    const picked = new Set(pool.flatMap((c) => res.selected(c)));
    for (const c of pool) linked.add(c.key);
    spells = spells.filter((s) => picked.has(s.id));
  }
  if (d.tag !== null) {
    for (const other of res.choices)
      if (other.definition.subset_of === d.tag) linked.add(other.key);
  }
  const known = res.spells(linked);
  if (d.known_only) {
    return spells.filter((s) => known.has(s.id)).map((s) => view(s.id, s.name, s.description));
  }
  return spells.map((s) =>
    view(
      s.id,
      s.name,
      s.description,
      known.has(s.id) ? `already known from ${known.get(s.id)}` : null,
    ),
  );
}

function knownFrom(src: string | undefined): string | null {
  return src ? `already known from ${src}` : null;
}

function skillViews(res: Resolution, choice: ActiveChoice, ok: (id: string) => boolean) {
  const owned = res.skills(choice.key);
  return SKILLS.filter(ok).map((s) =>
    view(
      s,
      skillName(s),
      `${ABILITY_NAMES[SKILL_ABILITY[s]]} skill`,
      owned.has(s) ? `already proficient from ${owned.get(s)}` : null,
    ),
  );
}

function toolViews(res: Resolution, choice: ActiveChoice, ok: (id: string) => boolean) {
  const owned = res.tools(choice.key);
  const category = choice.definition.category;
  return Object.values(res.catalog.tools)
    .filter((t) => ok(t.id) && (category === null || category.includes(t.category)))
    .map((t) =>
      view(
        t.id,
        t.name,
        t.category.replaceAll("-", " "),
        owned.has(t.id) ? `already proficient from ${owned.get(t.id)}` : null,
      ),
    );
}

/**
 * A repeatable feat whose repeats must differ (Magic Initiate: a different spell list each
 * time) can't be taken again once every option of that choice is used.
 */
function repeatsExhausted(res: Resolution, feat: FeatDef, excludeChoice: string): boolean {
  const differ = feat.repeat_requires_different;
  if (!differ) return false;
  const definition = feat.grants.choices.find((c) => c.id === differ);
  if (definition?.kind !== "option") return false;
  const used = new Set<string>();
  for (const c of res.choices) {
    const owner = c.source.feat ?? c.source.feature;
    if (
      owner?.id === feat.id &&
      c.definition.id === differ &&
      !c.source.key.endsWith(`@${excludeChoice}`)
    ) {
      for (const v of res.selected(c)) used.add(v);
    }
  }
  return definition.options.every((o) => used.has(o.id));
}

/** For a repeatable feat whose repeats must differ (Magic Initiate spell list). */
function takenByOtherInstances(res: Resolution, choice: ActiveChoice): Map<string, string> {
  const feat = choice.source.feat ?? choice.source.feature;
  const taken = new Map<string, string>();
  if (feat === null || feat.repeat_requires_different !== choice.definition.id) return taken;
  for (const other of res.choices) {
    const otherFeat = other.source.feat ?? other.source.feature;
    if (
      other.key !== choice.key &&
      otherFeat?.id === feat.id &&
      other.definition.id === choice.definition.id
    ) {
      for (const value of res.selected(other)) taken.set(value, `your other ${feat.name}`);
    }
  }
  return taken;
}

function setDefault<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (!map.has(key)) map.set(key, value);
}
