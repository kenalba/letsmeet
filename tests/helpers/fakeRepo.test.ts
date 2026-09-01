import { describe, it, expect } from 'vitest';
import { FakeRepo } from './fakeRepo.js';

describe('FakeRepo', () => {
  it('createRecord assigns a TID rkey and real CID; getRecord round-trips', async () => {
    const repo = new FakeRepo();
    const ref = await repo.createRecord('did:plc:host', 'cool.wzrdz.poll.schedule', { a: 1 });
    expect(ref.uri).toMatch(/^at:\/\/did:plc:host\/cool\.wzrdz\.poll\.schedule\/[a-z2-7]+$/);
    expect(ref.cid).toMatch(/^bafy/);
    const rkey = ref.uri.split('/').pop()!;
    const found = await repo.getRecord('did:plc:host', 'cool.wzrdz.poll.schedule', rkey);
    expect(found?.value).toEqual({ a: 1 });
  });
  it('putRecord upserts at a fixed rkey and changes the CID on new content', async () => {
    const repo = new FakeRepo();
    const r1 = await repo.putRecord('did:plc:x', 'c', 'rk', { v: 1 });
    const r2 = await repo.putRecord('did:plc:x', 'c', 'rk', { v: 2 });
    expect(r1.cid).not.toBe(r2.cid);
    expect(await repo.listRecords('did:plc:x', 'c')).toHaveLength(1);
  });
  it('failWrites makes writes throw; delete removes records', async () => {
    const repo = new FakeRepo();
    const ref = await repo.createRecord('did:plc:x', 'c', {});
    const rkey = ref.uri.split('/').pop()!;
    repo.failWrites = true;
    await expect(repo.putRecord('did:plc:x', 'c', 'rk', {})).rejects.toThrow();
    repo.failWrites = false;
    repo.delete('did:plc:x', 'c', rkey);
    expect(await repo.getRecord('did:plc:x', 'c', rkey)).toBeNull();
  });
});
