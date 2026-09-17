import { DateTime } from 'luxon';
import { rectKeys, type GridGeom, type PaintMap } from './gridModel.js';

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

/**
 * Every slot key in the rectangle of hours between two cells. `rectKeys` spans rows by slot,
 * so the two diagonals — first half of one corner to last half of the other, and back —
 * together cover both halves of every hour whichever corner the anchor is.
 */
export function hourRectKeys(geom: GridGeom, a: HourCell, b: HourCell): string[] {
  const first = (c: HourCell) => c.keys[0];
  const last = (c: HourCell) => c.keys[c.keys.length - 1];
  return [...new Set([...rectKeys(geom, first(a), last(b)), ...rectKeys(geom, last(a), first(b))])];
}
