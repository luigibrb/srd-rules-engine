/**
 * An encounter's history: where it started (the encounter and its characters' states) and every
 * action applied since, with the dice each drew. Replaying it gives the same encounter, so undo
 * is replaying all but the last action. Optional, a document of its own.
 */

import { z } from "zod";
import { EncounterActionSchema, EncounterSchema } from "./encounter";
import { CharacterStateSchema } from "./state";
import { DocumentVersionSchema } from "./version";

export const EncounterHistorySchema = z
  .object({
    version: DocumentVersionSchema,
    start: z.object({
      encounter: EncounterSchema,
      /** The characters' states at the start, by key. */
      states: z.record(z.string(), CharacterStateSchema).default({}),
    }),
    steps: z
      .array(z.object({ action: EncounterActionSchema, rolls: z.array(z.int()).default([]) }))
      .default([]),
  })
  .meta({ id: "EncounterHistory" });
export type EncounterHistory = z.infer<typeof EncounterHistorySchema>;
