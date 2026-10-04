/**
 * Areas of effect on a 5-foot grid (SRD "Area of Effect"). The SRD defines the shapes but not
 * how they cover grid squares, so this module reads them this way (flagged in ARCHITECTURE.md):
 *
 * - a square is in an area when its center is inside the shape;
 * - a Sphere or Cylinder spreads from a grid intersection `point` (the top-left corner of square
 *   `point`), with the grid's distance rule (diagonals count like any other step), so a 20-foot
 *   radius covers 8×8 squares; an Emanation spreads the same way from a creature's space;
 * - a Cone or Line starts at the center of its origin's space and goes toward the center of the
 *   square `toward`: a Cone's width at any point equals its distance from the origin, a Line has
 *   its `width`; their origin isn't included;
 * - a Cube is placed by its top-left square `point`.
 */

import type { SpellArea } from "../models/content";

export interface GridPoint {
  readonly x: number;
  readonly y: number;
}

/** A creature's space: its top-left square and its width in squares. */
export interface GridSpace {
  readonly position: GridPoint;
  readonly size: number;
}

/** Where an area is: its point (Sphere, Cylinder, Cube) or direction (Cone, Line). */
export interface AreaPlacement {
  readonly point?: GridPoint;
  readonly toward?: GridPoint;
}

/** The squares (`"x,y"`) an area covers, from its origin (the caster or monster) and placement. */
export function areaSquares(
  area: SpellArea,
  origin: GridSpace,
  placement: AreaPlacement,
): Set<string> {
  const out = new Set<string>();
  const add = (x: number, y: number) => out.add(`${x},${y}`);
  const reach = Math.ceil(area.size / 5) + origin.size + 1;
  const { position: o, size: s } = origin;
  switch (area.shape) {
    case "sphere":
    case "cylinder": {
      const p = placement.point ?? fail(`A ${area.shape} needs a point`);
      const r = area.size / 5;
      // Squares whose center (x + 0.5) is within r of the corner p, on each axis.
      for (let x = Math.floor(p.x - r); x <= Math.ceil(p.x + r); x++) {
        for (let y = Math.floor(p.y - r); y <= Math.ceil(p.y + r); y++) {
          if (Math.abs(x + 0.5 - p.x) <= r && Math.abs(y + 0.5 - p.y) <= r) add(x, y);
        }
      }
      break;
    }
    case "emanation": {
      const r = area.size / 5;
      for (let x = o.x - r; x < o.x + s + r; x++) {
        for (let y = o.y - r; y < o.y + s + r; y++) {
          const inside = x >= o.x && x < o.x + s && y >= o.y && y < o.y + s;
          if (!inside) add(x, y);
        }
      }
      break;
    }
    case "cube": {
      const p = placement.point ?? fail("A cube needs a point (its top-left square)");
      const n = area.size / 5;
      for (let x = p.x; x < p.x + n; x++) for (let y = p.y; y < p.y + n; y++) add(x, y);
      break;
    }
    case "cone":
    case "line": {
      const t = placement.toward ?? fail(`A ${area.shape} needs a direction (a square toward)`);
      const cx = o.x + s / 2;
      const cy = o.y + s / 2;
      const dx = t.x + 0.5 - cx;
      const dy = t.y + 0.5 - cy;
      const length = Math.hypot(dx, dy);
      if (length === 0) fail(`A ${area.shape} needs a direction away from its origin`);
      const [ux, uy] = [dx / length, dy / length];
      const limit = area.size / 5;
      for (let x = o.x - reach; x <= o.x + s + reach; x++) {
        for (let y = o.y - reach; y <= o.y + s + reach; y++) {
          const inOrigin = x >= o.x && x < o.x + s && y >= o.y && y < o.y + s;
          if (inOrigin) continue;
          const vx = x + 0.5 - cx;
          const vy = y + 0.5 - cy;
          const along = vx * ux + vy * uy;
          const across = Math.abs(vx * uy - vy * ux);
          const halfWidth = area.shape === "cone" ? along / 2 : area.width / 10;
          if (along > 0 && along <= limit + s / 2 && across <= halfWidth + 1e-9) add(x, y);
        }
      }
      break;
    }
  }
  return out;
}

/** Whether any square of a space is in the area. */
export function inArea(squares: ReadonlySet<string>, space: GridSpace): boolean {
  for (let dx = 0; dx < space.size; dx++) {
    for (let dy = 0; dy < space.size; dy++) {
      if (squares.has(`${space.position.x + dx},${space.position.y + dy}`)) return true;
    }
  }
  return false;
}

/** Feet from a creature's space to a grid intersection (a Sphere's point), by the grid rule. */
export function distanceToPoint(space: GridSpace, point: GridPoint): number {
  const gap = (p: number, from: number) => Math.max(0, p - (from + space.size), from - p);
  return Math.max(gap(point.x, space.position.x), gap(point.y, space.position.y)) * 5;
}

function fail(message: string): never {
  throw new RangeError(message);
}
