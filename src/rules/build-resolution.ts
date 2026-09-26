/**
 * Resolve a build into its active content sources and the choices they ask for.
 *
 * A *source* is anything that grants something: the base creation rules, the class, the
 * species, a chosen species option (e.g. Wood Elf), the background, a feat, an equipment
 * package. Sources declare *choices*; answering a choice can activate new sources (choosing
 * the Skilled feat adds a source that asks for three proficiencies).
 *
 * Keys are stable strings so a build can store answers without nesting:
 *
 * - source: `class:fighter`, `species:elf`, `background:soldier`, `creation`
 * - choice: `<source key>#<choice id>`, e.g. `species:elf#lineage`
 * - option source: `<choice key>=<option id>`, e.g. `species:elf#lineage=wood-elf`
 * - feat source: `feat:<feat id>@<granting source or choice key>`
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
  SKILL_ABILITY,
  SKILLS,
  type Skill,
  type Step,
  skillName,
} from "../models/content";
import { isWeaponProficient } from "./weapons";

export interface ActiveSource {
  readonly key: string;
  readonly name: string;
  readonly grants: Grants;
  readonly params: Readonly<Record<string, string>>;
  readonly feat: FeatDef | null;
  readonly description: string;
  /** Name of the source that granted this one (feats). */
  readonly granted_by: string;
}

export interface ActiveChoice {
  readonly key: string;
  readonly source: ActiveSource;
  readonly definition: ChoiceDef;
  readonly label: string;
  readonly step: Step;
  /** Answer pre-filled by the granting source (e.g. Acolyte's Magic Initiate list). */
  readonly fixed: readonly string[] | null;
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
  return { key, name, grants, params: {}, feat: null, description: "", granted_by: "", ...extra };
}

function activeChoice(src: ActiveSource, definition: ChoiceDef): ActiveChoice {
  const value = Object.hasOwn(src.params, definition.id) ? src.params[definition.id] : undefined;
  return {
    key: `${src.key}#${definition.id}`,
    source: src,
    definition,
    label: definition.label,
    step: choiceStep(definition),
    fixed: value !== undefined ? [value] : null,
  };
}

function view(id: string, name: string, description = "", unavailable: string | null = null) {
  return { id, name, description, unavailable } satisfies OptionView;
}

export class Resolution {
  constructor(
    readonly build: CharacterBuild,
    readonly catalog: Catalog,
    readonly sources: readonly ActiveSource[],
    readonly choices: readonly ActiveChoice[],
  ) {}

  // --- choice access ----------------------------------------------------------------------

  selected(choice: ActiveChoice): readonly string[] {
    return choice.fixed ?? answers(this.build, choice.key);
  }

  choice(key: string): ActiveChoice | undefined {
    return this.choices.find((c) => c.key === key);
  }

  /** Choices asked in a step, in order. Expertise comes last: it needs every skill pick. */
  choicesForStep(step: Step): ActiveChoice[] {
    const inStep = this.choices.filter((c) => c.step === step && c.fixed === null);
    const last = (c: ActiveChoice) => (c.definition.kind === "expertise" ? 1 : 0);
    return inStep.sort((a, b) => last(a) - last(b));
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
      for (const id of [...src.grants.cantrips, ...src.grants.spells])
        setDefault(owned, id, src.name);
    }
    for (const c of this.choices) {
      if (c.definition.kind !== "spell" || excludeChoices.has(c.key)) continue;
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

  weaponMasteries(): string[] {
    return [...this.selections(["weapon_mastery"])].map(([v]) => v);
  }

  savingThrows(): Set<Ability> {
    return new Set(this.sources.flatMap((s) => s.grants.saving_throws));
  }

  effects(): [Effect, string][] {
    return this.sources.flatMap((s) => s.grants.effects.map((e): [Effect, string] => [e, s.name]));
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

export function resolve(build: CharacterBuild, catalog: Catalog): Resolution {
  const sources: ActiveSource[] = [];
  const choices: ActiveChoice[] = [];

  const addFeat = (
    featId: string,
    key: string,
    params: Readonly<Record<string, string>>,
    grantedBy: string,
  ) => {
    const feat = lookup(catalog.feats, featId);
    if (feat)
      addSource(source(key, feat.name, feat.grants, { params, feat, granted_by: grantedBy }));
  };

  const addSource = (src: ActiveSource): void => {
    if (sources.some((s) => s.key === src.key)) return;
    sources.push(src);
    for (const grant of src.grants.feats) {
      addFeat(grant.feat, `feat:${grant.feat}@${src.key}`, grant.params, src.name);
    }
    for (const definition of src.grants.choices) {
      const choice = activeChoice(src, definition);
      choices.push(choice);
      const picked = choice.fixed ?? answers(build, choice.key);
      if (definition.kind === "option") {
        for (const optId of picked) {
          const opt = definition.options.find((o) => o.id === optId);
          if (opt) {
            addSource(
              source(`${choice.key}=${optId}`, `${opt.name} (${src.name})`, opt.grants, {
                description: opt.description,
              }),
            );
          }
        }
      } else if (definition.kind === "feat") {
        for (const featId of picked) addFeat(featId, `feat:${featId}@${choice.key}`, {}, src.name);
      }
    }
  };

  addSource(source("creation", "Character creation", catalog.creation.base_grants));
  const cls = lookup(catalog.classes, build.class_id);
  if (cls) addSource(source(`class:${cls.id}`, cls.name, cls.grants));
  const species = lookup(catalog.species, build.species_id);
  if (species) addSource(source(`species:${species.id}`, species.name, species.grants));
  const background = lookup(catalog.backgrounds, build.background_id);
  if (background) {
    addSource(source(`background:${background.id}`, background.name, background.grants));
  }

  return new Resolution(build, catalog, sources, choices);
}

// --- options ------------------------------------------------------------------------------

function optionViews(res: Resolution, choice: ActiveChoice): OptionView[] {
  const d = choice.definition;
  const cat = res.catalog;
  const ok = (id: string) => d.allowed === null || d.allowed.includes(id);
  const inCategory = (category: string) => d.category === null || d.category.includes(category);

  switch (d.kind) {
    case "option": {
      const taken = takenByOtherFeatInstances(res, choice);
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
    case "feat": {
      const owned = new Map(
        res
          .featSources()
          .filter((s) => !s.key.endsWith(choice.key))
          .map((s) => [s.feat.id, s.name]),
      );
      return Object.values(cat.feats)
        .filter((feat) => ok(feat.id) && inCategory(feat.category))
        .map((feat) =>
          view(
            feat.id,
            feat.name,
            feat.description,
            owned.has(feat.id) && !feat.repeatable ? "you already have this feat" : null,
          ),
        );
    }
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
  const list = d.spell_list === null ? null : res.resolveRef(choice.source, d.spell_list);
  if (d.spell_list !== null && list === null) return []; // the list isn't chosen yet
  let spells = Object.values(res.catalog.spells).filter(
    (s) =>
      ok(s.id) &&
      (d.spell_level === null || s.level === d.spell_level) &&
      (list === null || s.lists.includes(list)) &&
      (!d.ritual || s.ritual),
  );
  // Choices tied by subset_of (spellbook ⊇ prepared) share spells by design.
  const linked = new Set([choice.key]);
  if (d.subset_of !== null) {
    const pool = res.sibling(choice, d.subset_of);
    if (pool) {
      linked.add(pool.key);
      const picked = res.selected(pool);
      spells = spells.filter((s) => picked.includes(s.id));
    }
  }
  for (const other of res.choices) {
    if (other.source === choice.source && other.definition.subset_of === d.id)
      linked.add(other.key);
  }
  const known = res.spells(linked);
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

/** For a repeatable feat whose repeats must differ (Magic Initiate spell list). */
function takenByOtherFeatInstances(res: Resolution, choice: ActiveChoice): Map<string, string> {
  const feat = choice.source.feat;
  const taken = new Map<string, string>();
  if (feat === null || feat.repeat_requires_different !== choice.definition.id) return taken;
  for (const other of res.choices) {
    if (
      other.key !== choice.key &&
      other.source.feat?.id === feat.id &&
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
