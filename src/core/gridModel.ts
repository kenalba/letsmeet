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
