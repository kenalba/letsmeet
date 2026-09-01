import { describe, it, expect } from 'vitest';
import {
  buildGeom, strokeOp, rectKeys, applyPaint, paintToIntervals, intervalsToPaint,
  type PaintMap,
} from '../../src/core/gridModel.js';
import { materializeSlots } from '../../src/core/slots.js';

const slots = materializeSlots({
  dates: ['2026-09-02', '2026-09-03'], window: { start: '17:00', end: '18:00' },
  slotMinutes: 30, timezone: 'UTC',
});
// 4 slots: two per date
const [a1, a2, b1, b2] = slots.map((s) => s.start);
const geom = buildGeom(slots, 'UTC');

describe('buildGeom', () => {
  it('groups slot keys into viewer-local date columns, ordered', () => {
    expect(geom.dates).toEqual(['2026-09-02', '2026-09-03']);
    expect(geom.columns.get('2026-09-02')).toEqual([a1, a2]);
    expect(geom.columns.get('2026-09-03')).toEqual([b1, b2]);
  });
});

describe('strokeOp', () => {
  it('adds when the cell is unpainted or painted in the other mode', () => {
    const p: PaintMap = new Map([[a1, 'ifNeedBe']]);
    expect(strokeOp(p, a2, 'available')).toBe('add');
    expect(strokeOp(p, a1, 'available')).toBe('add');
  });
  it('removes when the cell already has this mode', () => {
    const p: PaintMap = new Map([[a1, 'available']]);
    expect(strokeOp(p, a1, 'available')).toBe('remove');
  });
});

describe('rectKeys', () => {
  it('spans the rectangle across date columns', () => {
    expect(new Set(rectKeys(geom, a1, b2))).toEqual(new Set([a1, a2, b1, b2]));
  });
  it('a single cell is its own rectangle', () => {
    expect(rectKeys(geom, a2, a2)).toEqual([a2]);
  });
});

describe('applyPaint + paintToIntervals', () => {
  it('round-trips contiguous paint into one merged interval', () => {
    let p: PaintMap = new Map();
    p = applyPaint(p, [a1, a2], 'add', 'available');
    expect(paintToIntervals(p, slots, 'available'))
      .toEqual([{ start: a1, end: slots[1].end }]);
  });
  it('remove erases regardless of mode', () => {
    let p: PaintMap = new Map([[a1, 'ifNeedBe']]);
    p = applyPaint(p, [a1], 'remove', 'available');
    expect(p.size).toBe(0);
  });
});

describe('intervalsToPaint', () => {
  it('rebuilds a PaintMap from record intervals (edit prefill)', () => {
    const p = intervalsToPaint([{ start: a1, end: slots[1].end }], [{ start: b1, end: slots[2].end }], slots);
    expect(p.get(a1)).toBe('available');
    expect(p.get(a2)).toBe('available');
    expect(p.get(b1)).toBe('ifNeedBe');
    expect(p.get(b2)).toBeUndefined();
  });
});
