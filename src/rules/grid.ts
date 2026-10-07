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
  /** Squares where each foot of movement costs this many feet (Wall of Thorns: 4). */
  readonly costs?: ReadonlyMap<string, number>;
}

export const key = (p: GridPoint): string => `${p.x},${p.y}`;

const SPACE: Readonly<Record<string, number>> = { large: 2, huge: 3, gargantuan: 4 };

/**
 * Squares on a side of a creature's space (SRD "Creature Size and Space"): Large 2, Huge 3,
 * Gargantuan 4; Tiny, Small, Medium and an unknown size 1 (a Tiny creature takes one square,
 * flagged).
 */
export function spaceForSize(size: string | null | undefined): number {
  return SPACE[size?.toLowerCase() ?? ""] ?? 1;
}

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
  // A square that costs more per foot (Wall of Thorns) replaces Difficult Terrain's doubling.
  const times = Math.max(1, ...entered.map((s) => terrain.costs?.get(key(s)) ?? 1));
  if (times > 1) return 5 * Math.max(times, difficult ? 2 : 1);
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

// --- line of effect and cover -------------------------------------------------------------------
//
// The SRD gives cover's degrees but no way to work them out on a grid; this reads them the way
// the DMG's grid variant does (flagged in ARCHITECTURE.md): from the corner of the attacker's
// space (or an area's point of origin) that sees best, lines to the four corners of the target's
// square that's least covered; walls and blocked squares block lines: none blocked, no cover; 1–2,
// Half; 3, Three-Quarters; 4, Total. A line that only grazes an obstacle (along its face, past a
// free end or a single corner) isn't blocked. Another creature a clear line passes through gives
// Half Cover.

export type CoverDegree = "none" | "half" | "three_quarters" | "total";

/** Walls plus the four edges of every blocked square: everything that blocks a line. */
export function obstacles(walls: readonly Wall[], blocked: Iterable<string>): Wall[] {
  const out = [...walls];
  for (const k of blocked) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    out.push(
      { from: { x, y }, to: { x: x + 1, y } },
      { from: { x: x + 1, y }, to: { x: x + 1, y: y + 1 } },
      { from: { x: x + 1, y: y + 1 }, to: { x, y: y + 1 } },
      { from: { x, y: y + 1 }, to: { x, y } },
    );
  }
  return out;
}

const EPS = 1e-9;
const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;

/**
 * Whether the line from `a` to `b` gets past every obstacle. It's blocked where obstacles meet it
 * at a point between its ends with parts on both of its sides (it crosses a wall, or goes through
 * the corner where two walls meet); a line that only touches one side isn't.
 */
export function lineClear(a: GridPoint, b: GridPoint, walls: readonly Wall[]): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return true;
  // Points along the line (by t in (0, 1)) and the sides obstacles reach from them.
  const sides = new Map<string, { left: boolean; right: boolean }>();
  const mark = (t: number, ox: number, oy: number) => {
    const side = cross(dx, dy, ox, oy);
    if (Math.abs(side) < EPS) return;
    const k = t.toFixed(9);
    const s = sides.get(k) ?? { left: false, right: false };
    if (side > 0) s.left = true;
    else s.right = true;
    sides.set(k, s);
  };
  for (const w of walls) {
    const ex = w.to.x - w.from.x;
    const ey = w.to.y - w.from.y;
    const denom = cross(dx, dy, ex, ey);
    if (Math.abs(denom) < EPS) continue; // parallel or along it: it doesn't cross
    const fx = w.from.x - a.x;
    const fy = w.from.y - a.y;
    const t = cross(fx, fy, ex, ey) / denom; // along the line
    const u = cross(fx, fy, dx, dy) / denom; // along the wall
    if (t <= EPS || t >= 1 - EPS || u < -EPS || u > 1 + EPS) continue;
    // From the meeting point, the wall goes toward its ends that aren't the point itself.
    if (u > EPS) mark(t, -ex * u, -ey * u);
    if (u < 1 - EPS) mark(t, ex * (1 - u), ey * (1 - u));
  }
  for (const s of sides.values()) if (s.left && s.right) return false;
  return true;
}

/** Whether the line from `a` to `b` passes through the inside of a space (its edges don't count). */
export function throughSpace(
  a: GridPoint,
  b: GridPoint,
  space: { position: GridPoint; size: number },
): boolean {
  const [x0, y0] = [space.position.x, space.position.y];
  const [x1, y1] = [x0 + space.size, y0 + space.size];
  let lo = 0;
  let hi = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [
    [-dx, a.x - x0],
    [dx, x1 - a.x],
    [-dy, a.y - y0],
    [dy, y1 - a.y],
  ] as const) {
    if (Math.abs(p) < EPS) {
      if (q <= EPS) return false; // along an edge or outside
      continue;
    }
    const r = q / p;
    if (p < 0) lo = Math.max(lo, r);
    else hi = Math.min(hi, r);
  }
  if (hi - lo <= EPS) return false;
  const mx = a.x + dx * ((lo + hi) / 2);
  const my = a.y + dy * ((lo + hi) / 2);
  return mx > x0 + EPS && mx < x1 - EPS && my > y0 + EPS && my < y1 - EPS;
}

/** The four corners of a space (its outer corners, for a creature larger than Medium). */
export function spaceCorners(space: { position: GridPoint; size: number }): GridPoint[] {
  const { x, y } = space.position;
  const s = space.size;
  return [
    { x, y },
    { x: x + s, y },
    { x, y: y + s },
    { x: x + s, y: y + s },
  ];
}

const DEGREES: readonly CoverDegree[] = ["none", "half", "three_quarters", "total"];

/**
 * A target's cover from `origins` (the corners of an attacker's space, or an area's point of
 * origin): the least covered of its squares, seen from the origin that sees best. `creatures`
 * are the other creatures' spaces; `by` is the index of the one giving Half Cover, if that's
 * what decided it.
 */
export function coverDegree(
  origins: readonly GridPoint[],
  target: { position: GridPoint; size: number },
  walls: readonly Wall[],
  creatures: readonly { position: GridPoint; size: number }[] = [],
  /** Squares that give at least this cover to lines through them (Blade Barrier). */
  screens: readonly { position: GridPoint; size: number; degree: CoverDegree }[] = [],
): { degree: CoverDegree; by: number | null } {
  let best: { degree: CoverDegree; by: number | null } = { degree: "total", by: null };
  const squares: GridPoint[] = [];
  for (let dx = 0; dx < target.size; dx++)
    for (let dy = 0; dy < target.size; dy++) {
      squares.push({ x: target.position.x + dx, y: target.position.y + dy });
    }
  for (const a of origins) {
    for (const sq of squares) {
      const corners = spaceCorners({ position: sq, size: 1 });
      const clear = corners.filter((c) => lineClear(a, c, walls));
      const blocked = 4 - clear.length;
      let degree: CoverDegree =
        blocked === 0 ? "none" : blocked <= 2 ? "half" : blocked === 3 ? "three_quarters" : "total";
      let by: number | null = null;
      for (const screen of screens) {
        if (DEGREES.indexOf(screen.degree) <= DEGREES.indexOf(degree)) continue;
        if (clear.some((c) => throughSpace(a, c, screen))) degree = screen.degree;
      }
      if (degree === "none") {
        const i = creatures.findIndex((space) => clear.some((c) => throughSpace(a, c, space)));
        if (i >= 0) {
          degree = "half";
          by = i;
        }
      }
      if (DEGREES.indexOf(degree) < DEGREES.indexOf(best.degree)) best = { degree, by };
      if (best.degree === "none") return best;
    }
  }
  return best;
}

/**
 * Every square a `size`-wide creature at `from` can reach for at most `maxCost` feet, with the
 * cheapest cost (`from` itself excluded). Squares it can only pass through are included: the
 * caller leaves out those it can't end in.
 */
export function reachable(
  terrain: Terrain,
  from: GridPoint,
  { size = 1, maxCost }: { size?: number; maxCost: number },
): Map<string, { point: GridPoint; cost: number }> {
  const best = new Map<string, { point: GridPoint; cost: number }>([
    [key(from), { point: from, cost: 0 }],
  ]);
  // Costs are 5 or 10: a queue per cost level is enough.
  const levels = new Map<number, GridPoint[]>([[0, [from]]]);
  for (let cost = 0; cost <= maxCost; cost += 5) {
    for (const p of levels.get(cost) ?? []) {
      if ((best.get(key(p))?.cost ?? -1) !== cost) continue;
      for (const [dx, dy] of directions(p, p)) {
        const next = { x: p.x + dx, y: p.y + dy };
        if (stepBlocked(terrain, p, next, size)) continue;
        const total = cost + stepCost(terrain, p, next, size);
        if (total > maxCost || total >= (best.get(key(next))?.cost ?? Number.POSITIVE_INFINITY)) {
          continue;
        }
        best.set(key(next), { point: next, cost: total });
        levels.set(total, [...(levels.get(total) ?? []), next]);
      }
    }
  }
  best.delete(key(from));
  return best;
}
