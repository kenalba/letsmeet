import { TID, cidForCbor } from '@atproto/common';
import type { FoundRecord, RecordRef, RepoReader, RepoWriter } from '../../src/atproto/types.js';

export class FakeRepo implements RepoReader, RepoWriter {
  failWrites = false;
  private repos = new Map<string, Map<string, { cid: string; value: Record<string, unknown> }>>();

  private bucket(did: string, collection: string) {
    const key = `${did} ${collection}`;
    if (!this.repos.has(key)) this.repos.set(key, new Map());
    return this.repos.get(key)!;
  }

  async createRecord(repo: string, collection: string, record: object): Promise<RecordRef> {
    return this.putRecord(repo, collection, TID.nextStr(), record);
  }

  async putRecord(repo: string, collection: string, rkey: string, record: object): Promise<RecordRef> {
    if (this.failWrites) throw new Error('FakeRepo: writes disabled');
    const cid = (await cidForCbor(record)).toString();
    this.bucket(repo, collection).set(rkey, { cid, value: record as Record<string, unknown> });
    return { uri: `at://${repo}/${collection}/${rkey}`, cid };
  }

  async getRecord(did: string, collection: string, rkey: string): Promise<FoundRecord | null> {
    const hit = this.bucket(did, collection).get(rkey);
    return hit ? { uri: `at://${did}/${collection}/${rkey}`, cid: hit.cid, value: hit.value } : null;
  }

  async listRecords(did: string, collection: string): Promise<FoundRecord[]> {
    return [...this.bucket(did, collection).entries()].map(([rkey, r]) => ({
      uri: `at://${did}/${collection}/${rkey}`, cid: r.cid, value: r.value,
    }));
  }

  delete(did: string, collection: string, rkey: string): void {
    this.bucket(did, collection).delete(rkey);
  }
}
