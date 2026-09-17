import { describe, it, expect } from 'vitest';
import { isOver } from '../../src/core/archive.js';
import { SCHEDULE_NSID, type ScheduleRecord } from '../../src/atproto/records.js';

const poll = (over: Partial<ScheduleRecord> & { dates: string[]; timezone?: string }): ScheduleRecord => ({
  $type: SCHEDULE_NSID,
  title: 't',
  status: 'active',
  createdAt: '2026-08-01T00:00:00.000Z',
  time: {
    $type: `${SCHEDULE_NSID}#specificDates`,
    dates: over.dates,
    window: { start: '17:00', end: '19:00' },
    slotMinutes: 30,
    timezone: over.timezone ?? 'UTC',
  },
  ...(over.finalized ? { finalized: over.finalized, status: 'finalized' } : {}),
  ...(over.status ? { status: over.status } : {}),
});

describe('isOver', () => {
  it('a decided poll is over once its chosen time has ended', () => {
    const p = poll({ dates: ['2026-09-02'], finalized: { start: '2026-09-02T17:00:00.000Z', end: '2026-09-02T17:30:00.000Z' } });
    expect(isOver(p, new Date('2026-09-02T17:29:00Z'))).toBe(false);
    expect(isOver(p, new Date('2026-09-02T17:30:00Z'))).toBe(true);
  });
  it('a decided poll with a future time stays, even when every offered day has passed', () => {
    const p = poll({ dates: ['2026-08-01'], finalized: { start: '2026-09-02T17:00:00.000Z', end: '2026-09-02T17:30:00.000Z' } });
    expect(isOver(p, new Date('2026-08-31T12:00:00Z'))).toBe(false);
  });
  it('an undecided poll is over once its last day has ended in its own zone', () => {
    const p = poll({ dates: ['2026-09-02', '2026-08-20'], timezone: 'America/Los_Angeles' });
    // 2026-09-03T05:00Z is still 22:00 on the 2nd in Los Angeles.
    expect(isOver(p, new Date('2026-09-03T05:00:00Z'))).toBe(false);
    // 2026-09-03T07:00Z is 00:00 on the 3rd there.
    expect(isOver(p, new Date('2026-09-03T07:00:00Z'))).toBe(true);
  });
  it('status alone does not archive: a closed or cancelled poll waits for its day', () => {
    expect(isOver(poll({ dates: ['2026-09-02'], status: 'closed' }), new Date('2026-08-31T12:00:00Z'))).toBe(false);
    expect(isOver(poll({ dates: ['2026-09-02'], status: 'cancelled' }), new Date('2026-08-31T12:00:00Z'))).toBe(false);
    expect(isOver(poll({ dates: ['2026-08-02'], status: 'cancelled' }), new Date('2026-08-31T12:00:00Z'))).toBe(true);
  });
  it('never archives what it cannot read: no dates, or a zone luxon does not know', () => {
    expect(isOver(poll({ dates: [] }), new Date('2026-08-31T12:00:00Z'))).toBe(false);
    expect(isOver(poll({ dates: ['2026-08-02'], timezone: 'Mars/Olympus' }), new Date('2026-08-31T12:00:00Z'))).toBe(false);
  });
});
