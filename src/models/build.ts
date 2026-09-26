/** The character build: the player's choices, and nothing derived from them. */

import { z } from "zod";
import { ABILITIES, type Ability } from "./content";

export const ABILITY_METHODS = ["standard_array", "point_buy", "roll"] as const;
export type AbilityMethod = (typeof ABILITY_METHODS)[number];

export const ALIGNMENTS = ["LG", "NG", "CG", "LN", "N", "CN", "LE", "NE", "CE"] as const;
export type Alignment = (typeof ALIGNMENTS)[number];

export const ALIGNMENT_NAMES: Readonly<Record<Alignment, string>> = {
  LG: "Lawful Good",
  NG: "Neutral Good",
  CG: "Chaotic Good",
  LN: "Lawful Neutral",
  N: "Neutral",
  CN: "Chaotic Neutral",
  LE: "Lawful Evil",
  NE: "Neutral Evil",
  CE: "Chaotic Evil",
};

export type AbilityMap = Partial<Record<Ability, number>>;

/**
 * A (possibly incomplete) level 1 character build. Immutable: setters return a new build.
 *
 * `choices` maps an active choice key (see `rules/build-resolution`) to the ids selected for
 * it, e.g. `{"class:fighter#skills": ["athletics", "perception"]}`.
 */
export const CharacterBuildSchema = z.object({
  name: z.string().default(""),
  alignment: z.enum(ALIGNMENTS).nullable().default(null),
  class_id: z.string().nullable().default(null),
  species_id: z.string().nullable().default(null),
  background_id: z.string().nullable().default(null),
  ability_method: z.enum(ABILITY_METHODS).nullable().default(null),
  rolled_pool: z.array(z.int()).default([]),
  base_scores: z.partialRecord(z.enum(ABILITIES), z.int()).default({}),
  background_bonus: z.partialRecord(z.enum(ABILITIES), z.int()).default({}),
  choices: z.record(z.string(), z.array(z.string())).default({}),
});

type BuildShape = z.infer<typeof CharacterBuildSchema>;
export type CharacterBuild = DeepReadonly<BuildShape>;

type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** Parse and freeze a build, e.g. one loaded from JSON. Throws a `ZodError` if invalid. */
export function parseBuild(input: unknown): CharacterBuild {
  return freezeBuild(CharacterBuildSchema.parse(input));
}

/** An empty build, optionally with some fields already set. */
export function createBuild(fields: Partial<CharacterBuild> = {}): CharacterBuild {
  return parseBuild(fields);
}

/** Return a copy of `build` with `update` applied (the equivalent of `model_copy`). */
export function updateBuild(
  build: CharacterBuild,
  update: Partial<CharacterBuild>,
): CharacterBuild {
  return freezeBuild({ ...build, ...update } as BuildShape);
}

function freezeBuild(build: BuildShape): CharacterBuild {
  for (const value of Object.values(build.choices)) Object.freeze(value);
  Object.freeze(build.choices);
  Object.freeze(build.base_scores);
  Object.freeze(build.background_bonus);
  Object.freeze(build.rolled_pool);
  return Object.freeze(build);
}
