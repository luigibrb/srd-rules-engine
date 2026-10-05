/**
 * Previews for a map UI: where a combatant can move, what a move would do, what an area would
 * cover. Computed results, not saved documents; nothing is applied.
 */

import { z } from "zod";
import { REFUSAL_CODES } from "./events";

const square = z.object({ x: z.int(), y: z.int() });

/** Every square a combatant can end a move on now, with its cost (`reachableSquares`). */
export const ReachableSchema = z
  .object({
    id: z.string(),
    /** Feet of movement left this turn. */
    movement: z.int().min(0),
    /** Squares it can end on (top-left square of its space), cheapest cost first. */
    squares: z.array(z.object({ x: z.int(), y: z.int(), cost: z.int().min(0) })),
  })
  .meta({ id: "Reachable" });
export type Reachable = z.infer<typeof ReachableSchema>;

/** What a `move` would do (`previewMove`). */
export const MovePreviewSchema = z
  .object({
    /** The engine would take the move now (a dry run), or why not. */
    ok: z.boolean(),
    reasons: z.array(z.string()),
    codes: z.array(z.enum(REFUSAL_CODES)),
    /** The squares it would go through, the destination last (empty without positions). */
    path: z.array(square),
    /** Feet it would cost, and the movement left after it. */
    cost: z.int().min(0),
    movement_left: z.int().min(0),
    /**
     * Zones on the way: a creature that would get into one (the mover, or others its Emanation
     * would reach) and save, or the feet the mover would move in a zone that deals damage for it.
     */
    zones: z.array(
      z.object({
        zone: z.string(),
        label: z.string(),
        creature: z.string(),
        at: square,
        kind: z.enum(["enters", "moves_in"]),
        feet: z.int().min(0).nullable(),
      }),
    ),
    /** Enemies whose reach it would leave, who could make an Opportunity Attack. */
    opportunity_attacks: z.array(z.string()),
  })
  .meta({ id: "MovePreview" });
export type MovePreview = z.infer<typeof MovePreviewSchema>;

/** What an area would cover if placed now (`previewArea`). */
export const AreaPreviewSchema = z
  .object({
    /** The placement is allowed (in range, a Cube next to its creator…), or why not. */
    ok: z.boolean(),
    reasons: z.array(z.string()),
    codes: z.array(z.enum(REFUSAL_CODES)),
    /** Its squares, with a clear line from its point of origin. */
    squares: z.array(square),
    /** The creatures in it, with their cover from the point of origin (Dexterity saves). */
    targets: z.array(
      z.object({
        id: z.string(),
        cover: z.enum(["none", "half", "three_quarters"]),
        /** The creature giving the cover, when that's what decided it. */
        by: z.string().nullable(),
      }),
    ),
    /** Creatures in its squares that Total Cover from the point of origin keeps out. */
    total_cover: z.array(z.string()),
  })
  .meta({ id: "AreaPreview" });
export type AreaPreview = z.infer<typeof AreaPreviewSchema>;
