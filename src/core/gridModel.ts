import { DateTime } from 'luxon';
import { mergeIntervals, type Interval } from './intervals.js';

export type PaintMode = 'available' | 'ifNeedBe';
export type PaintMap = Map<string, PaintMode>;

export interface GridGeom {
  dates: string[];                  // viewer-local ISO dates, ordered
  columns: Map<string, string[]>;   // date -> ordered slot keys (slot.start)
}

export function buildGeom(slots: Interval[], timezone: string): GridGeom {
  const columns = new Map<string, string[]>();
  for (const s of slots) {
    const d = DateTime.fromISO(s.start, { zone: 'utc' }).setZone(timezone).toISODate()!;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d)!.push(s.start);
  }
  return { dates: [...columns.keys()].sort(), columns };
}

export function strokeOp(painted: PaintMap, key: string, mode: PaintMode): 'add' | 'remove' {
  return painted.get(key) === mode ? 'remove' : 'add';
}

/** All keys in the rectangle between anchor cell a and current cell b. */
export function rectKeys(geom: GridGeom, a: string, b: string): string[] {
  const pos = new Map<string, { c: number; r: number }>();
  geom.dates.forEach((d, c) =>
    geom.columns.get(d)!.forEach((k, r) => pos.set(k, { c, r })),
  );
  const pa = pos.get(a); const pb = pos.get(b);
  if (!pa || !pb) return [];
  const [c0, c1] = [Math.min(pa.c, pb.c), Math.max(pa.c, pb.c)];
  const [r0, r1] = [Math.min(pa.r, pb.r), Math.max(pa.r, pb.r)];
  const out: string[] = [];
  for (const [k, p] of pos) {
    if (p.c >= c0 && p.c <= c1 && p.r >= r0 && p.r <= r1) out.push(k);
  }
  return out;
}

export function applyPaint(
  painted: PaintMap, keys: string[], op: 'add' | 'remove', mode: PaintMode,
): PaintMap {
  const next = new Map(painted);
  for (const k of keys) {
    if (op === 'add') next.set(k, mode);
    else next.delete(k);
  }
  return next;
}

export function paintToIntervals(painted: PaintMap, slots: Interval[], mode: PaintMode): Interval[] {
  const chosen = slots.filter((s) => painted.get(s.start) === mode);
  return chosen.length ? mergeIntervals(chosen) : [];
}

export function intervalsToPaint(
  available: Interval[], ifNeedBe: Interval[], slots: Interval[],
): PaintMap {
  const covers = (ivs: Interval[], s: Interval) =>
    ivs.some((iv) => iv.start <= s.start && iv.end >= s.end);
  const p: PaintMap = new Map();
  for (const s of slots) {
    if (covers(available, s)) p.set(s.start, 'available');
    else if (covers(ifNeedBe, s)) p.set(s.start, 'ifNeedBe');
  }
  return p;
}

/** True when both maps paint exactly the same cells in the same modes. */
export function paintEquals(a: PaintMap, b: PaintMap): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** Names, per slot, of who can make it — the shape the server ships as `counts`. */
export interface SlotCount {
  available: string[];
  ifNeedBe: string[];
}

/**
 * A slot's tally as the viewer paints: everyone else's saved answers plus the viewer's
 * current, unsaved paint (listed as "you"). `self` is the viewer's own name in the saved
 * counts, if they have answered before; it is dropped so a repaint replaces that answer
 * rather than doubling it.
 */
export function liveTally(
  count: SlotCount, self: string | undefined, mine: PaintMode | undefined,
): SlotCount {
  // Always a copy: the caller's saved counts must survive the push below.
  const others = (names: string[]) => names.filter((n) => n !== self);
  const available = others(count.available);
  const ifNeedBe = others(count.ifNeedBe);
  if (mine === 'available') available.push('you');
  if (mine === 'ifNeedBe') ifNeedBe.push('you');
  return { available, ifNeedBe };
}

export type Side = 'top' | 'bottom' | 'left' | 'right';

/**
 * Which sides of a painted cell face something painted differently — nothing, the other
 * mode, or no cell at all. Those are the edges of the region the cell belongs to, and the
 * only place the viewer's paint is drawn: an outline around each run of cells, leaving the
 * heat tint and tally inside untouched. Unpainted cells have no edges.
 */
export function paintEdges(
  painted: PaintMap, key: string,
  neighbors: { top?: string; bottom?: string; left?: string; right?: string },
): Side[] {
  const mine = painted.get(key);
  if (!mine) return [];
  const sides: Side[] = ['top', 'bottom', 'left', 'right'];
  return sides.filter((side) => {
    const k = neighbors[side];
    return !k || painted.get(k) !== mine;
  });
}
