import { DateTime } from 'luxon';
import type { GridGeom, PaintMap } from './gridModel.js';

/**
 * The availability editor marks by the hour while the record stays half-hour aligned: each
 * visible cell is one hour of one day, made of the half-hour slot keys underneath it. Two
 * keys as a rule; one where a DST edge leaves a day with a lone half hour; none (null in
 * the row) where a day has no slot at that hour at all.
 */
export interface HourCell { keys: string[] }
export interface HourRow { hour: number; label: string; cells: (HourCell | null)[] }
export type HourState = 'none' | 'early' | 'late' | 'available';

/** `7am`, `12pm`, `11pm`. */
function label(hour: number): string {
  return hour === 0 ? '12am' : hour === 12 ? '12pm' : hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}

/** The grid's rows: every wall-clock hour any column has a slot in, in order, with one cell per column. */
export function hourRows(geom: GridGeom, zone: string): HourRow[] {
  // column index -> hour -> keys in time order (columns are already sorted by start)
  const byCol = geom.dates.map((d) => {
    const m = new Map<number, string[]>();
    for (const k of geom.columns.get(d)!) {
      const h = DateTime.fromISO(k, { zone: 'utc' }).setZone(zone).hour;
      if (!m.has(h)) m.set(h, []);
      m.get(h)!.push(k);
    }
    return m;
  });
  const hours = [...new Set(byCol.flatMap((m) => [...m.keys()]))].sort((a, b) => a - b);
  return hours.map((hour) => ({
    hour, label: label(hour),
    cells: byCol.map((m) => (m.has(hour) ? { keys: m.get(hour)! } : null)),
  }));
}

/** Full when every half is marked; early/late when only the first/second is; none otherwise. */
export function hourState(painted: PaintMap, cell: HourCell): HourState {
  const on = cell.keys.map((k) => painted.has(k));
  if (on.every(Boolean)) return 'available';
  if (!on.some(Boolean)) return 'none';
  return on[0] ? 'early' : 'late';
}

/** A stroke clears only a full hour; a half-filled anchor fills, which is the safe direction. */
export function hourStrokeOp(painted: PaintMap, cell: HourCell): 'add' | 'remove' {
  return hourState(painted, cell) === 'available' ? 'remove' : 'add';
}

/** The row/column position of `cell` in `rows`, by identity or by its first key. */
function locate(rows: HourRow[], cell: HourCell): { ri: number; ci: number } | undefined {
  for (let ri = 0; ri < rows.length; ri++) {
    const cells = rows[ri].cells;
    for (let ci = 0; ci < cells.length; ci++) {
      const c = cells[ci];
      if (c && (c === cell || c.keys[0] === cell.keys[0])) return { ri, ci };
    }
  }
  return undefined;
}

/**
 * Every slot key in the rectangle of hours between two cells. `gridModel`'s `rectKeys` is
 * index-based per column: a gap in one column (a missing hour, or a DST-thinned one) shifts
 * every later row in that column relative to the other columns, so a slot-index rectangle
 * can leak keys in or out. Hour rows are already aligned by wall-clock hour across every
 * column, so the box is taken over `rows` position instead — every non-null cell whose row
 * is between a's and b's row (inclusive) and whose column is between their columns
 * (inclusive) contributes its keys, in row-major order. That stays exact across gaps.
 */
export function hourRectKeys(rows: HourRow[], a: HourCell, b: HourCell): string[] {
  const pa = locate(rows, a);
  const pb = locate(rows, b);
  if (!pa || !pb) return [];
  const [ri0, ri1] = [Math.min(pa.ri, pb.ri), Math.max(pa.ri, pb.ri)];
  const [ci0, ci1] = [Math.min(pa.ci, pb.ci), Math.max(pa.ci, pb.ci)];
  const out: string[] = [];
  for (let ri = ri0; ri <= ri1; ri++) {
    for (let ci = ci0; ci <= ci1; ci++) {
      const cell = rows[ri].cells[ci];
      if (cell) out.push(...cell.keys);
    }
  }
  return out;
}
