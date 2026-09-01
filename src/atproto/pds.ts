import type { Agent } from '@atproto/api';
import type { FoundRecord, RecordRef, RepoReader, RepoWriter } from './types.js';

interface DidDoc {
  service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
}

export async function resolvePds(did: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let url: string;
  if (did.startsWith('did:plc:')) {
    url = `https://plc.directory/${did}`;
  } else if (did.startsWith('did:web:')) {
    url = `https://${did.slice('did:web:'.length)}/.well-known/did.json`;
  } else {
    throw new Error(`unsupported DID method: ${did}`);
  }
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`DID resolution failed for ${did}: ${res.status}`);
  const doc = (await res.json()) as DidDoc;
  const svc = doc.service?.find((s) => s.type === 'AtprotoPersonalDataServer');
  if (!svc) throw new Error(`no PDS service in DID document for ${did}`);
  return svc.serviceEndpoint.replace(/\/$/, '');
}

/** Unauthenticated reads straight from each participant's PDS. No firehose, no appview. */
export class PublicPdsReader implements RepoReader {
  private pdsCache = new Map<string, string>();
  constructor(private fetchImpl: typeof fetch = fetch) {}

  private async pdsFor(did: string): Promise<string> {
    if (!this.pdsCache.has(did)) this.pdsCache.set(did, await resolvePds(did, this.fetchImpl));
    return this.pdsCache.get(did)!;
  }

  async getRecord(did: string, collection: string, rkey: string): Promise<FoundRecord | null> {
    const pds = await this.pdsFor(did);
    const u = new URL(`${pds}/xrpc/com.atproto.repo.getRecord`);
    u.searchParams.set('repo', did);
    u.searchParams.set('collection', collection);
    u.searchParams.set('rkey', rkey);
    const res = await this.fetchImpl(u);
    if (!res.ok) return null;
    const body = (await res.json()) as { uri: string; cid: string; value: Record<string, unknown> };
    return { uri: body.uri, cid: body.cid, value: body.value };
  }

  async listRecords(did: string, collection: string): Promise<FoundRecord[]> {
    const pds = await this.pdsFor(did);
    const out: FoundRecord[] = [];
    let cursor: string | undefined;
    do {
      const u = new URL(`${pds}/xrpc/com.atproto.repo.listRecords`);
      u.searchParams.set('repo', did);
      u.searchParams.set('collection', collection);
      u.searchParams.set('limit', '100');
      if (cursor) u.searchParams.set('cursor', cursor);
      const res = await this.fetchImpl(u);
      if (!res.ok) throw new Error(`listRecords failed for ${did}: ${res.status}`);
      const body = (await res.json()) as { records: FoundRecord[]; cursor?: string };
      out.push(...body.records);
      cursor = body.cursor;
    } while (cursor);
    return out;
  }
}

/** Authenticated writes through an OAuth-restored Agent. */
export function writerForAgent(agent: Agent): RepoWriter {
  return {
    async createRecord(repo, collection, record): Promise<RecordRef> {
      const res = await agent.com.atproto.repo.createRecord({
        repo,
        collection,
        record: record as Record<string, unknown>,
      });
      return { uri: res.data.uri, cid: res.data.cid };
    },
    async putRecord(repo, collection, rkey, record): Promise<RecordRef> {
      const res = await agent.com.atproto.repo.putRecord({
        repo,
        collection,
        rkey,
        record: record as Record<string, unknown>,
      });
      return { uri: res.data.uri, cid: res.data.cid };
    },
  };
}
