import { describe, it, expect } from 'vitest';
import {
  buildScheduleRecord, validateScheduleRecord,
  buildResponseRecord, validateResponseRecord,
  SCHEDULE_NSID, RESPONSE_NSID,
} from '../../src/atproto/records.js';

const time = {
  dates: ['2026-09-02'], window: { start: '17:00', end: '19:00' },
  slotMinutes: 30 as const, timezone: 'America/New_York',
};
// any syntactically valid CID works for validation tests
const CID = 'bafyreidfayvfuwqa2qskciqhtcc73ipe2f2wgib3fmyk6ssqrlkln5dcvy';
const SUBJECT = { uri: 'at://did:plc:host123/lol.letsmeet.poll.schedule/3kabc', cid: CID };

describe('schedule records', () => {
  it('builds a valid active record', () => {
    const rec = buildScheduleRecord({ title: 'DnD night', time });
    expect(rec.$type).toBe(SCHEDULE_NSID);
    expect(rec.status).toBe('active');
    expect(rec.time.$type).toBe(`${SCHEDULE_NSID}#specificDates`);
    expect(() => validateScheduleRecord(rec)).not.toThrow();
  });
  it('rejects a title over 200 graphemes', () => {
    expect(() => buildScheduleRecord({ title: 'x'.repeat(201), time })).toThrow();
  });
  it('rejects an invalid status on validate', () => {
    const rec = buildScheduleRecord({ title: 'ok', time });
    expect(() => validateScheduleRecord({ ...rec, status: 'meh' })).toThrow();
  });
  it('accepts every slot granularity the create form offers', () => {
    for (const slotMinutes of [10, 15, 20, 30, 45, 60, 90, 120] as const) {
      expect(() => buildScheduleRecord({ title: 'ok', time: { ...time, slotMinutes } }))
        .not.toThrow();
    }
  });
  it('rejects a slotMinutes outside the lexicon enum', () => {
    // The form can only submit legal values; this guards the lexicon itself, so the cast
    // in routes/polls.ts stays backed by a real check on the record-build path.
    const bogus = { ...time, slotMinutes: 25 as unknown as typeof time.slotMinutes };
    expect(() => buildScheduleRecord({ title: 'ok', time: bogus })).toThrow();
  });
  it('rejects more than 31 dates', () => {
    const many = Array.from({ length: 32 }, (_, i) => `2026-10-${String((i % 28) + 1).padStart(2, '0')}`);
    expect(() => buildScheduleRecord({ title: 'ok', time: { ...time, dates: many } })).toThrow();
  });
});

describe('response records', () => {
  const available = [{ start: '2026-09-02T21:00:00.000Z', end: '2026-09-02T22:00:00.000Z' }];
  it('builds a valid guest response', () => {
    const rec = buildResponseRecord({ subject: SUBJECT, available, guestName: 'Sam L.' });
    expect(rec.$type).toBe(RESPONSE_NSID);
    expect(rec.guest?.name).toBe('Sam L.');
    expect(() => validateResponseRecord(rec)).not.toThrow();
  });
  it('builds a valid account response (no guest field)', () => {
    const rec = buildResponseRecord({ subject: SUBJECT, available });
    expect(rec.guest).toBeUndefined();
  });
  it('merges overlapping paint on build', () => {
    const rec = buildResponseRecord({
      subject: SUBJECT,
      available: [
        { start: '2026-09-02T21:00:00.000Z', end: '2026-09-02T21:30:00.000Z' },
        { start: '2026-09-02T21:30:00.000Z', end: '2026-09-02T22:00:00.000Z' },
      ],
    });
    expect(rec.available).toHaveLength(1);
  });
  it('rejects a guest name over 64 graphemes', () => {
    expect(() => buildResponseRecord({ subject: SUBJECT, available, guestName: 'x'.repeat(65) })).toThrow();
  });
  it('rejects a missing subject on validate', () => {
    const rec = buildResponseRecord({ subject: SUBJECT, available });
    const { subject: _drop, ...rest } = rec as unknown as Record<string, unknown> & { subject: unknown };
    expect(() => validateResponseRecord(rest)).toThrow();
  });
});
