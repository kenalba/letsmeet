import { describe, it, expect } from 'vitest';
import { buildGeom, applyPaint, type PaintMap } from '../../src/core/gridModel.js';
import { templateSlots } from '../../src/core/availability.js';
import { hourRows, hourState, hourStrokeOp, hourRectKeys } from '../../src/core/hourCells.js';

const geomIn = (zone: string) => buildGeom(templateSlots(zone), zone);

describe('hourRows', () => {
  it('pairs the template week\'s half hours into seventeen hour rows of seven cells', () => {
    const rows = hourRows(geomIn('America/New_York'), 'America/New_York');
    expect(rows.map((r) => r.hour)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
    expect(rows[0].label).toBe('7am');
    expect(rows[5].label).toBe('12pm');
    expect(rows[16].label).toBe('11pm');
    for (const r of rows) {
      expect(r.cells).toHaveLength(7);
      for (const c of r.cells) expect(c?.keys).toHaveLength(2);
    }
    // The first cell of the first row is Sunday 7:00 then 7:30, New York time.
    expect(rows[0].cells[0]!.keys).toEqual(['2026-01-04T12:00:00.000Z', '2026-01-04T12:30:00.000Z']);
  });
  it('is the same shape in utc', () => {
    const rows = hourRows(geomIn('UTC'), 'UTC');
    expect(rows).toHaveLength(17);
    expect(rows[0].cells[0]!.keys).toEqual(['2026-01-04T07:00:00.000Z', '2026-01-04T07:30:00.000Z']);
  });
  it('holds a null where a day has no slot at that hour', () => {
    // A hand-built geometry: Monday is missing its 8:00 and 8:30 slots.
    const zone = 'UTC';
    const slots = templateSlots(zone).filter((s) => !s.start.startsWith('2026-01-05T08:'));
    const rows = hourRows(buildGeom(slots, zone), zone);
    expect(rows[1].hour).toBe(8);
    expect(rows[1].cells[1]).toBeNull();
    expect(rows[1].cells[0]!.keys).toHaveLength(2);
  });
  it('keeps a lone half hour as a one-key cell', () => {
    const zone = 'UTC';
    const slots = templateSlots(zone).filter((s) => s.start !== '2026-01-05T08:30:00.000Z');
    const rows = hourRows(buildGeom(slots, zone), zone);
    expect(rows[1].cells[1]!.keys).toEqual(['2026-01-05T08:00:00.000Z']);
  });
});

describe('hourState and hourStrokeOp', () => {
  const cell = { keys: ['a', 'b'] };
  const paint = (...keys: string[]): PaintMap => new Map(keys.map((k) => [k, 'available' as const]));
  it('reads none, early, late and available', () => {
    expect(hourState(paint(), cell)).toBe('none');
    expect(hourState(paint('a'), cell)).toBe('early');
    expect(hourState(paint('b'), cell)).toBe('late');
    expect(hourState(paint('a', 'b'), cell)).toBe('available');
  });
  it('a one-key cell is available or none', () => {
    expect(hourState(paint('a'), { keys: ['a'] })).toBe('available');
    expect(hourState(paint(), { keys: ['a'] })).toBe('none');
  });
  it('removes only from a full hour; a half-filled anchor fills', () => {
    expect(hourStrokeOp(paint('a', 'b'), cell)).toBe('remove');
    expect(hourStrokeOp(paint('a'), cell)).toBe('add');
    expect(hourStrokeOp(paint(), cell)).toBe('add');
  });
});

describe('hourRectKeys', () => {
  const zone = 'UTC';
  const geom = geomIn(zone);
  const rows = hourRows(geom, zone);
  it('covers both halves of every hour in the rectangle, whichever corner is the anchor', () => {
    const sun7 = rows[0].cells[0]!; const tue9 = rows[2].cells[2]!;
    const down = hourRectKeys(geom, sun7, tue9);
    const up = hourRectKeys(geom, tue9, sun7);
    expect(down).toHaveLength(3 * 3 * 2);
    expect(new Set(up)).toEqual(new Set(down));
    expect(down).toContain('2026-01-04T07:00:00.000Z');
    expect(down).toContain('2026-01-06T09:30:00.000Z');
    expect(down).not.toContain('2026-01-06T10:00:00.000Z');
    expect(down).not.toContain('2026-01-07T07:00:00.000Z');
  });
  it('a single cell is its own two keys', () => {
    const c = rows[3].cells[4]!;
    expect(hourRectKeys(geom, c, c)).toEqual(c.keys);
  });
  it('applies through applyPaint like any key list', () => {
    const c = rows[0].cells[0]!;
    const next = applyPaint(new Map(), hourRectKeys(geom, c, c), 'add', 'available');
    expect(hourState(next, c)).toBe('available');
  });
});
