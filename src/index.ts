/**
 * srd-rules-engine — a 5th-edition (SRD 5.2.1) rules engine and character builder.
 *
 * Runs anywhere JavaScript does (Node, Deno, Bun, browsers, workers). Loading YAML content
 * from disk is in `srd-rules-engine/node`; the HTTP handler is in `srd-rules-engine/http`.
 */

// Content
export * from "./content/catalog";
export { SRD_PACK_ID, srdCatalog, srdPack } from "./content/srd";
// Models
export * from "./models/build";
export * from "./models/character";
export type * from "./models/combat";
export * from "./models/content";
export * from "./models/pack";
export * from "./models/spell";
export * from "./models/state";
// Rules
export * from "./rules/ability-scores";
export * from "./rules/build-resolution";
export * from "./rules/build-validation";
export * from "./rules/combat";
export * from "./rules/damage";
export * from "./rules/dice";
export * from "./rules/rng";
export * from "./rules/sheet";
export * from "./rules/spells";
// Workflows
export * as builder from "./services/builder";
export {
  BuildError,
  type BuildResult,
  type Evaluation,
  evaluate,
  STEP_TITLES,
} from "./services/builder";
export * from "./services/combat";
export {
  applyAction,
  computePlaySheet,
  createState,
  PlayError,
  type PlaySheet,
  reconcileState,
  validateState,
} from "./services/play";
