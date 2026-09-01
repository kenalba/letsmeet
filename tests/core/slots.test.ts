import { describe, it, expect } from 'vitest';
import { materializeSlots } from '../../src/core/slots.js';

describe('materializeSlots', () => {
  it('materializes a plain evening window to UTC', () => {
    const slots = materializeSlots({
      dates: ['2026-09-02'], window: { start: '17:00', end: '19:00' },
      slotMinutes: 60, timezone: 'America/New_York',
    });
    // EDT is UTC-4 in September
    expect(slots).toEqual([
      { start: '2026-09-02T21:00:00.000Z', end: '2026-09-02T22:00:00.000Z' },
      { start: '2026-09-02T22:00:00.000Z', end: '2026-09-02T23:00:00.000Z' },
    ]);
  });

  it('US spring-forward: nominal 3h window yields 2 real hours', () => {
    // 2026-03-08 America/New_York, clocks jump 02:00 -> 03:00
    const slots = materializeSlots({
      dates: ['2026-03-08'], window: { start: '01:00', end: '04:00' },
      slotMinutes: 60, timezone: 'America/New_York',
    });
    expect(slots).toEqual([
      { start: '2026-03-08T06:00:00.000Z', end: '2026-03-08T07:00:00.000Z' },
      { start: '2026-03-08T07:00:00.000Z', end: '2026-03-08T08:00:00.000Z' },
    ]);
  });

  it('EU fall-back: nominal 3h window yields 4 real hours', () => {
    // 2026-10-25 Europe/Berlin, clocks fall back 03:00 -> 02:00
    const slots = materializeSlots({
      dates: ['2026-10-25'], window: { start: '01:00', end: '04:00' },
      slotMinutes: 60, timezone: 'Europe/Berlin',
    });
    expect(slots).toHaveLength(4);
    expect(slots[0].start).toBe('2026-10-24T23:00:00.000Z');
    expect(slots[3].end).toBe('2026-10-25T03:00:00.000Z');
  });

  it('window crossing midnight extends into the next day', () => {
    const slots = materializeSlots({
      dates: ['2026-09-02'], window: { start: '22:00', end: '01:00' },
      slotMinutes: 60, timezone: 'UTC',
    });
    expect(slots).toHaveLength(3);
    expect(slots[2].end).toBe('2026-09-03T01:00:00.000Z');
  });

  it('handles non-contiguous date lists', () => {
    const slots = materializeSlots({
      dates: ['2026-09-02', '2026-09-04'], window: { start: '10:00', end: '11:00' },
      slotMinutes: 30, timezone: 'UTC',
    });
    expect(slots).toHaveLength(4);
  });

  it('rejects an unknown timezone', () => {
    expect(() => materializeSlots({
      dates: ['2026-09-02'], window: { start: '10:00', end: '11:00' },
      slotMinutes: 30, timezone: 'Mars/Olympus_Mons',
    })).toThrow();
  });

  it('clamps a 45-minute grain that divides the window unevenly', () => {
    // 10:00-12:00 is 120 minutes: two 45s fit, a third would end at 12:15, past the window.
    const slots = materializeSlots({
      dates: ['2026-09-02'], window: { start: '10:00', end: '12:00' },
      slotMinutes: 45, timezone: 'UTC',
    });
    expect(slots).toEqual([
      { start: '2026-09-02T10:00:00.000Z', end: '2026-09-02T10:45:00.000Z' },
      { start: '2026-09-02T10:45:00.000Z', end: '2026-09-02T11:30:00.000Z' },
    ]);
  });

  it('clamps a 90-minute grain that divides the window unevenly', () => {
    // 09:00-13:00 is 240 minutes: two 90s fit, a third would end at 13:30.
    const slots = materializeSlots({
      dates: ['2026-09-02'], window: { start: '09:00', end: '13:00' },
      slotMinutes: 90, timezone: 'UTC',
    });
    expect(slots).toHaveLength(2);
    expect(slots[1].end).toBe('2026-09-02T12:00:00.000Z');
  });

  it('drops a trailing partial slot rather than overrunning the window', () => {
    expect(materializeSlots({
      dates: ['2026-09-02'], window: { start: '10:00', end: '10:50' },
      slotMinutes: 60, timezone: 'UTC',
    })).toEqual([]);
    expect(materializeSlots({
      dates: ['2026-09-02'], window: { start: '10:00', end: '11:20' },
      slotMinutes: 30, timezone: 'UTC',
    })).toHaveLength(2);
  });
});
