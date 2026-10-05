import { z } from "zod";

/**
 * The format version of saved documents (builds, play states, encounters). A document without
 * one is version 1; when the format changes, older versions are migrated on parse and newer
 * ones are refused.
 */
export const DOCUMENT_VERSION = 1;

export const DocumentVersionSchema = z
  .int()
  .min(1)
  .max(DOCUMENT_VERSION, {
    error: `this document was saved by a newer srd-rules-engine (format ${DOCUMENT_VERSION} is the newest this one reads)`,
  })
  .default(DOCUMENT_VERSION);
