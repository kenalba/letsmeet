import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import {
  enqueueOutbox, dueOutbox, markOutboxDone, markOutboxFailed, pendingOutboxCount, pruneOutbox,
} from '../../src/db/outbox.js';

const item = {
  hostDid: 'did:plc:host', pollUri: 'at://did:plc:host/lol.letsmeet.poll.schedule/3k',
  rkey: '3kresp1', record: { $type: 'lol.letsmeet.poll.response' },
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
  it('a new enqueue for the same (host, rkey) supersedes the old undone row', () => {
    const db = openDb(':memory:');
    enqueueOutbox(db, item, 1000);
    enqueueOutbox(db, { ...item, record: { $type: 'lol.letsmeet.poll.response', v: 2 } }, 2000);
    const due = dueOutbox(db, 999999);
    expect(due).toHaveLength(1);
    expect(due[0].record).toEqual({ $type: 'lol.letsmeet.poll.response', v: 2 });
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
  it('prunes delivered rows past the cutoff and never a pending one', () => {
    const db = openDb(':memory:');
    const old = enqueueOutbox(db, item, 1000);
    markOutboxDone(db, old);
    const recent = enqueueOutbox(db, { ...item, rkey: 'r2' }, 5000);
    markOutboxDone(db, recent);
    enqueueOutbox(db, { ...item, rkey: 'r3' }, 1000); // pending, old — must survive
    expect(pruneOutbox(db, 3000)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 2 });
    expect(pendingOutboxCount(db, 'did:plc:host')).toBe(1);
  });
});
