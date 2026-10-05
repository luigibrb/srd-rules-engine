import {
  type AbilityMap,
  type Catalog,
  type CharacterBuild,
  createBuild,
  resolve,
  updateBuild,
} from "../src/index";
import * as svc from "../src/services/builder";
import { srdCatalog } from "../src/srd";

export const catalog: Catalog = srdCatalog();

type Setter<A extends unknown[]> = (
  build: CharacterBuild,
  catalog: Catalog,
  ...args: A
) => svc.BuildResult;

export function apply<A extends unknown[]>(
  build: CharacterBuild,
  setter: Setter<A>,
  ...args: A
): CharacterBuild {
  return setter(build, catalog, ...args).build;
}

/** A complete Human Fighter / Soldier: Str 17, Chain Mail, Defense. */
export function fighterBuild(overrides: Partial<CharacterBuild> = {}): CharacterBuild {
  let b = createBuild();
  b = apply(b, svc.setClass, "fighter");
  b = apply(b, svc.setSpecies, "human");
  b = apply(b, svc.setChoice, "species:human#size", ["medium"]);
  b = apply(b, svc.setChoice, "species:human#skillful", ["perception"]);
  b = apply(b, svc.setChoice, "species:human#versatile", ["skilled"]);
  b = apply(b, svc.setBackground, "soldier");
  b = apply(b, svc.setAbilityMethod, "standard_array");
  b = apply(b, svc.setBaseScores, { str: 15, dex: 14, con: 13, int: 8, wis: 10, cha: 12 });
  b = apply(b, svc.setBackgroundBonus, { str: 2, con: 1 });
  b = apply(b, svc.setChoice, "class:fighter#equipment", ["a"]);
  b = apply(b, svc.setChoice, "background:soldier#equipment", ["b"]);
  b = apply(b, svc.setChoice, "class:fighter#fighting_style", ["defense"]);
  b = apply(b, svc.setChoice, "class:fighter#weapon_mastery", ["greatsword", "flail", "javelin"]);
  b = apply(b, svc.setChoice, "class:fighter#skills", ["acrobatics", "survival"]);
  b = apply(b, svc.setChoice, "background:soldier#tool", ["dice-set"]);
  const skilled = "feat:skilled@species:human#versatile#proficiencies";
  b = apply(b, svc.setChoice, skilled, ["stealth", "insight", "lute"]);
  b = apply(b, svc.setChoice, "creation#languages", ["dwarvish", "giant"]);
  b = apply(b, svc.setName, "Brakka");
  b = apply(b, svc.setAlignment, "NG");
  return updateBuild(b, overrides);
}

/**
 * Answer every open choice with the first legal option(s), re-resolving after each pick (a pick
 * can open new choices). Throws if a choice runs out of legal options.
 */
export function autocomplete(build: CharacterBuild, cat: Catalog = catalog): CharacterBuild {
  let b = build;
  for (let i = 0; i < 500; i++) {
    const res = resolve(b, cat);
    const pending = res.choices.find(
      (c) => c.fixed === null && res.selected(c).length < res.required(c),
    );
    if (!pending) return b;
    const current = res.selected(pending);
    const free = res.options(pending).filter((o) => !o.unavailable && !current.includes(o.id));
    // Like a player would, take the highest-level spells a leveled spell choice allows.
    if (pending.definition.kind === "spell" && pending.definition.max_spell_level !== null) {
      free.sort((a, b) => (cat.spells[b.id]?.level ?? 0) - (cat.spells[a.id]?.level ?? 0));
    }
    const next = free[0];
    if (!next) throw new Error(`No legal option left for ${pending.key}`);
    b = svc.setChoice(b, cat, pending.key, [...current, next.id]).build;
  }
  throw new Error("autocomplete didn't converge");
}

/** A level 1 character of any class with the class's recommended standard array. */
export function classBuild(
  classId: string,
  {
    species = "human",
    background = "soldier",
    name = "Tester",
    bonus,
  }: { species?: string; background?: string; name?: string; bonus?: AbilityMap } = {},
): CharacterBuild {
  const cls = catalog.classes[classId];
  if (!cls) throw new Error(`no class ${classId}`);
  const bg = catalog.backgrounds[background];
  if (!bg) throw new Error(`no background ${background}`);
  let b = createBuild();
  b = apply(b, svc.setClass, classId);
  b = apply(b, svc.setSpecies, species);
  b = apply(b, svc.setBackground, background);
  b = apply(b, svc.setAbilityMethod, "standard_array");
  b = apply(b, svc.setBaseScores, { ...cls.standard_array });
  // Default: +2 to the background's first ability, +1 to its second.
  const [first, second] = bg.ability_scores;
  b = apply(b, svc.setBackgroundBonus, bonus ?? { [first as string]: 2, [second as string]: 1 });
  b = apply(b, svc.setName, name);
  b = apply(b, svc.setAlignment, "N");
  return b;
}

/** Level up `times` times in a class, answering every new choice with the first legal option. */
export function levelUpIn(
  build: CharacterBuild,
  classId: string,
  times = 1,
  hp: number | null = null,
  cat: Catalog = catalog,
): CharacterBuild {
  let b = build;
  for (let i = 0; i < times; i++) {
    b = autocomplete(svc.levelUp(b, cat, classId, hp).build, cat);
  }
  return b;
}
