import { z } from "zod";

/**
 * The format version of saved documents (builds, play states, encounters, histories). A document
 * without one is version 1; when the format changes, older versions are migrated on parse (and
 * come out as the current version) and newer ones are refused.
 *
 * 2: an encounter's table settings (`decisions`, `auto_death_saves`, `positions`) are given with
 * each call, not stored (`EncounterSettings`); a history records them on each step.
 */
export const DOCUMENT_VERSION = 2;

export const DocumentVersionSchema = z
  .int()
  .min(1)
  .max(DOCUMENT_VERSION, {
    error: `this document was saved by a newer srd-rules-engine (format ${DOCUMENT_VERSION} is the newest this one reads)`,
  })
  .default(DOCUMENT_VERSION)
  // Migrated documents come out in the current format.
  .transform(() => DOCUMENT_VERSION);
