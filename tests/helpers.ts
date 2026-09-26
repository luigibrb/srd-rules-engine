import {
  type Catalog,
  type CharacterBuild,
  createBuild,
  srdCatalog,
  updateBuild,
} from "../src/index";
import * as svc from "../src/services/builder";

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
