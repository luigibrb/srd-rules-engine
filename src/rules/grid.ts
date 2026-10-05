/**
 * Moving on a 5-foot grid (SRD "Playing on a Grid", "Difficult Terrain", "Moving around Other
 * Creatures"): distances, a creature's steps, what blocks them and what they cost, and the
 * cheapest path around obstacles. Pure: the encounter says where the walls, the terrain and the
 * creatures are.
 *
 * Coordinates: square `(x, y)` covers the unit box from corner `(x, y)` to `(x + 1, y + 1)`; a
 * wall is a segment between two corners (on grid lines, between squares), so it can stand
 * between two squares. The SRD doesn't say how walls sit on a grid; this module reads it this
 * way (flagged in ARCHITECTURE.md):
 *
 * - a step goes from the center of a square to the center of the next one (diagonals included);
 *   it's blocked when that segment touches a wall, so a diagonal can't cut a wall's corner
 *   (SRD "Corners");
 * - a blocked square can't be entered, and a diagonal step can't pass its corner;
 * - a creature larger than Medium moves all its squares by the same step: each must be free;
 *   the step costs double when any square it enters is Difficult Terrain.
 */

import type { GridPoint } from "./areas";

/** A wall between grid corners: `from` and `to` are corners, not squares. */
export interface Wall {
  readonly from: GridPoint;
  readonly to: GridPoint;
}

/** What moving through a square means for a given mover (another creature's space). */
export type Occupant = "pass" | "difficult" | "block";

/** Where a mover can go: walls, terrain and other creatures, as it sees them. */
export interface Terrain {
  readonly walls: readonly Wall[];
  /** Squares (`"x,y"`) that can't be entered. */
  readonly blocked: ReadonlySet<string>;
  /** Squares (`"x,y"`) of Difficult Terrain (the map's and zones'). */
  readonly difficult: ReadonlySet<string>;
  /** Other creatures' squares (`"x,y"`): pass through, pass as Difficult Terrain, or not. */
  readonly creatures?: ReadonlyMap<string, Occupant>;
}

export const key = (p: GridPoint): string => `${p.x},${p.y}`;

/**
 * Feet between two spaces on the grid: count squares from one space to the nearest square of
 * the other, diagonals like any other step (SRD "Playing on a Grid"); 5 feet when adjacent, 0
 * when they overlap.
 */
export function gridDistance(a: GridPoint, sizeA: number, b: GridPoint, sizeB: number): number {
  const gap = (from: number, sa: number, to: number, sb: number) =>
    Math.max(0, to - (from + sa - 1), from - (to + sb - 1));
  return Math.max(gap(a.x, sizeA, b.x, sizeB), gap(a.y, sizeA, b.y, sizeB)) * 5;
}

/** The squares of a straight move, one step (diagonal first) at a time, `to` included. */
export function straightPath(from: GridPoint, to: GridPoint): GridPoint[] {
  const path: GridPoint[] = [];
  let { x, y } = from;
  while (x !== to.x || y !== to.y) {
    x += Math.sign(to.x - x);
    y += Math.sign(to.y - y);
    path.push({ x, y });
  }
  return path;
}

/** The squares of a `size`-wide space at `p`. */
function spaceSquares(p: GridPoint, size: number): GridPoint[] {
  const out: GridPoint[] = [];
  for (let dx = 0; dx < size; dx++)
    for (let dy = 0; dy < size; dy++) {
      out.push({ x: p.x + dx, y: p.y + dy });
    }
  return out;
}

/** Whether segments ab and cd meet (touching and overlapping included). */
export function segmentsMeet(a: GridPoint, b: GridPoint, c: GridPoint, d: GridPoint): boolean {
  const cross = (o: GridPoint, p: GridPoint, q: GridPoint) =>
    (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const within = (o: GridPoint, p: GridPoint, q: GridPoint) =>
    Math.min(o.x, p.x) <= q.x &&
    q.x <= Math.max(o.x, p.x) &&
    Math.min(o.y, p.y) <= q.y &&
    q.y <= Math.max(o.y, p.y);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return (
    (d1 === 0 && within(c, d, a)) ||
    (d2 === 0 && within(c, d, b)) ||
    (d3 === 0 && within(a, b, c)) ||
    (d4 === 0 && within(a, b, d))
  );
}

/**
 * Why a `size`-wide creature at `from` can't step to the adjacent square `to` (a wall, a blocked
 * square, a creature in the way), or `null` when it can.
 */
export function stepBlocked(
  terrain: Terrain,
  from: GridPoint,
  to: GridPoint,
  size = 1,
): string | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const before = new Set(spaceSquares(from, size).map(key));
  for (const sq of spaceSquares(from, size)) {
    const next = { x: sq.x + dx, y: sq.y + dy };
    if (terrain.blocked.has(key(next))) return `${next.x},${next.y} is blocked`;
    if (dx !== 0 && dy !== 0) {
      // A diagonal passes the corner of the two squares beside it.
      const side = [
        { x: sq.x + dx, y: sq.y },
        { x: sq.x, y: sq.y + dy },
      ];
      if (side.some((s) => terrain.blocked.has(key(s)))) {
        return `the step from ${sq.x},${sq.y} to ${next.x},${next.y} cuts a blocked corner`;
      }
    }
    const a = { x: sq.x + 0.5, y: sq.y + 0.5 };
    const b = { x: next.x + 0.5, y: next.y + 0.5 };
    if (terrain.walls.some((w) => segmentsMeet(a, b, w.from, w.to))) {
      return `a wall stands between ${sq.x},${sq.y} and ${next.x},${next.y}`;
    }
    if (!before.has(key(next)) && terrain.creatures?.get(key(next)) === "block") {
      return `a creature is in the way at ${next.x},${next.y}`;
    }
  }
  return null;
}

/** Feet a step costs: 5, or 10 when a square it enters is Difficult Terrain. */
export function stepCost(terrain: Terrain, from: GridPoint, to: GridPoint, size = 1): number {
  const before = new Set(spaceSquares(from, size).map(key));
  const entered = spaceSquares(to, size).filter((s) => !before.has(key(s)));
  const difficult = entered.some(
    (s) => terrain.difficult.has(key(s)) || terrain.creatures?.get(key(s)) === "difficult",
  );
  return difficult ? 10 : 5;
}

/**
 * The cheapest path from `from` to `to` (each square after `from`, `to` included) and its cost
 * in feet, or `null` when there's none costing at most `maxCost`. Ties go to the path that
 * steps toward the target first, diagonals first, so the same map always gives the same path.
 */
export function findPath(
  terrain: Terrain,
  from: GridPoint,
  to: GridPoint,
  { size = 1, maxCost = Number.POSITIVE_INFINITY }: { size?: number; maxCost?: number } = {},
): { path: GridPoint[]; cost: number } | null {
  const goal = key(to);
  const start = key(from);
  const best = new Map<string, number>([[start, 0]]);
  const previous = new Map<string, string>();
  const points = new Map<string, GridPoint>([[start, from]]);
  // A binary heap of [cost + heuristic, order, key]: lowest first, then first pushed.
  type Entry = [number, number, string];
  const heap: Entry[] = [];
  let order = 0;
  const swap = (i: number, j: number) => {
    [heap[i], heap[j]] = [heap[j] as Entry, heap[i] as Entry];
  };
  const push = (item: Entry) => {
    heap.push(item);
    for (let i = heap.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (!less(heap[i] as Entry, heap[parent] as Entry)) break;
      swap(i, parent);
      i = parent;
    }
  };
  const pop = (): Entry => {
    const top = heap[0] as Entry;
    const last = heap.pop() as Entry;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l] as Entry, heap[m] as Entry)) m = l;
        if (r < heap.length && less(heap[r] as Entry, heap[m] as Entry)) m = r;
        if (m === i) break;
        swap(i, m);
        i = m;
      }
    }
    return top;
  };
  const h = (p: GridPoint) => Math.max(Math.abs(p.x - to.x), Math.abs(p.y - to.y)) * 5;
  push([h(from), order++, start]);
  while (heap.length) {
    const [, , k] = pop();
    const p = points.get(k) as GridPoint;
    const cost = best.get(k) as number;
    if (k === goal) {
      const path: GridPoint[] = [];
      for (let at: string | undefined = k; at && at !== start; at = previous.get(at)) {
        path.unshift(points.get(at) as GridPoint);
      }
      return { path, cost };
    }
    for (const [dx, dy] of directions(p, to)) {
      const next = { x: p.x + dx, y: p.y + dy };
      if (stepBlocked(terrain, p, next, size)) continue;
      const total = cost + stepCost(terrain, p, next, size);
      if (total > maxCost) continue;
      const nk = key(next);
      if (total >= (best.get(nk) ?? Number.POSITIVE_INFINITY)) continue;
      best.set(nk, total);
      previous.set(nk, k);
      points.set(nk, next);
      push([total + h(next), order++, nk]);
    }
  }
  return null;
}

function less(a: [number, number, string], b: [number, number, string]): boolean {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

/** The 8 steps, the one toward `to` first, then the others closest to it (diagonals first). */
function directions(p: GridPoint, to: GridPoint): [number, number][] {
  const all: [number, number][] = [];
  for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) if (dx || dy) all.push([dx, dy]);
  const sx = Math.sign(to.x - p.x);
  const sy = Math.sign(to.y - p.y);
  const score = ([dx, dy]: [number, number]) =>
    Math.abs(dx - sx) + Math.abs(dy - sy) - (dx && dy ? 0.5 : 0);
  return all.sort((a, b) => score(a) - score(b));
}
