/**
 * An encounter's history: where it started (the encounter and its characters' states) and every
 * action applied since, with the dice each drew. Replaying it gives the same encounter, so undo
 * is replaying all but the last action. Optional, a document of its own.
 */

import { z } from "zod";
import {
  EncounterActionSchema,
  EncounterSchema,
  EncounterSettingsSchema,
  legacyEncounterSettings,
} from "./encounter";
import { CharacterStateSchema } from "./state";
import { DocumentVersionSchema } from "./version";

export const EncounterHistorySchema = z
  .preprocess(
    migrateHistory,
    z.object({
      version: DocumentVersionSchema,
      start: z.object({
        encounter: EncounterSchema,
        /** The characters' states at the start, by key. */
        states: z.record(z.string(), CharacterStateSchema).default({}),
      }),
      steps: z
        .array(
          z.object({
            action: EncounterActionSchema,
            rolls: z.array(z.int()).default([]),
            /** The table's settings the action was applied with: a replay uses them again. */
            settings: EncounterSettingsSchema.optional(),
          }),
        )
        .default([]),
    }),
  )
  .meta({ id: "EncounterHistory" });
export type EncounterHistory = z.infer<typeof EncounterHistorySchema>;

type Raw = Record<string, unknown>;

/**
 * Format 1 → 2: the table settings an encounter kept (`decisions`, `auto_death_saves`,
 * `positions`, each combatant's `decisions`) and the actions that changed them
 * (`set_decisions`, `set_positions`, `add_monster`/`add_character` with `decisions`) become the
 * settings recorded on each step; `resume` and `set_exploration`'s `notice_stops` (the halt on a
 * noticed point, gone) are dropped. None of them rolled dice, so a replay stays the same.
 */
function migrateHistory(input: unknown): unknown {
  const raw = input as Raw | null;
  if (!raw || typeof raw !== "object" || (raw.version !== undefined && raw.version !== 1)) {
    return input;
  }
  const start = (raw.start ?? {}) as Raw;
  const settings = legacyEncounterSettings(start.encounter) as Raw & {
    decisions_by: Record<string, string>;
  };
  // Combatant ids as the engine gave them, for a monster added with `decisions` and no `id`.
  const ids = new Set(
    (((start.encounter as Raw | undefined)?.combatants ?? []) as Raw[]).map((c) => c.id as string),
  );
  const freeId = (base: string) => {
    if (!ids.has(base)) return base;
    let n = 2;
    while (ids.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  };
  const steps: Raw[] = [];
  for (const step of (Array.isArray(raw.steps) ? raw.steps : []) as Raw[]) {
    const action = { ...((step.action ?? {}) as Raw) };
    if (action.type === "set_decisions") {
      const mode = action.mode as string | null;
      if (typeof action.id === "string") {
        if (mode) settings.decisions_by[action.id] = mode;
        else delete settings.decisions_by[action.id];
      } else if (mode) settings.decisions = mode;
      continue;
    }
    if (action.type === "set_positions") {
      settings.positions = action.mode;
      continue;
    }
    if (action.type === "resume") continue;
    if (action.type === "set_exploration") {
      delete action.notice_stops;
      if (action.pace === undefined) continue; // only the halt's setting: nothing left to do
    }
    if (action.type === "add_monster" || action.type === "add_character") {
      const id =
        (action.id as string | undefined) ??
        (action.type === "add_monster" ? freeId(action.monster as string) : undefined);
      if (id) ids.add(id);
      const key = id ?? (action.character as string);
      if (action.decisions === "ask" || action.decisions === "auto") {
        settings.decisions_by[key] = action.decisions;
      }
      delete action.decisions;
    }
    if (action.type === "remove" && typeof action.id === "string") ids.delete(action.id);
    steps.push({ ...step, action, settings: structuredClone(settings) });
  }
  return { ...raw, version: 2, steps };
}
