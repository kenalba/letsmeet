import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import {
  enqueueOutbox, dueOutbox, markOutboxDone, markOutboxFailed, pendingOutboxCount,
} from '../../src/db/outbox.js';

const item = {
  hostDid: 'did:plc:host', pollUri: 'at://did:plc:host/cool.wzrdz.poll.schedule/3k',
  rkey: '3kresp1', record: { $type: 'cool.wzrdz.poll.response' },
};

describe('outbox', () => {
  it('enqueued items are due immediately and carry the record', () => {
    const db = openDb(':memory:');
    enqueueOutbox(db, item, 1000);
    const due = dueOutbox(db, 1000);
    expect(due).toHaveLength(1);
    expect(due[0].record).toEqual(item.record);
  });
  it('done items stop being due', () => {
    const db = openDb(':memory:');
    const id = enqueueOutbox(db, item, 1000);
    markOutboxDone(db, id);
    expect(dueOutbox(db, 999999)).toHaveLength(0);
    expect(pendingOutboxCount(db, 'did:plc:host')).toBe(0);
  });
  it('failures back off exponentially and cap at 6h', () => {
    const db = openDb(':memory:');
    const id = enqueueOutbox(db, item, 0);
    markOutboxFailed(db, id, 'boom', 0);           // attempts=1, next = 60s
    expect(dueOutbox(db, 59_000)).toHaveLength(0);
    expect(dueOutbox(db, 61_000)).toHaveLength(1);
    for (let i = 0; i < 20; i++) markOutboxFailed(db, id, 'boom', 0);
    expect(dueOutbox(db, 6 * 3600_000 - 1000)).toHaveLength(0);
    expect(dueOutbox(db, 6 * 3600_000 + 1000)).toHaveLength(1);
    expect(pendingOutboxCount(db, 'did:plc:host')).toBe(1);
  });
});
