import type { Agent } from '@atproto/api';
import type { FoundRecord, RecordRef, RepoReader, RepoWriter } from './types.js';
import { assertPublicHttpsUrl, systemLookup, type LookupFn } from './safeUrl.js';

export interface DidDoc {
  alsoKnownAs?: string[];
  service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
}

/** No outbound read may hang a request forever; a PDS that is this slow is down to us. */
const TIMEOUT_MS = 5_000;
/** A poll's response collection is capped far below this; more pages means a runaway repo. */
const MAX_PAGES = 20;
/** Resolved DID → PDS entries live this long, and the map never exceeds this many. */
const PDS_CACHE_TTL_MS = 60 * 60_000;
const PDS_CACHE_MAX = 2_000;

export interface NetOpts {
  fetch?: typeof fetch;
  lookup?: LookupFn;
}

/**
 * Every outbound request goes through here: the destination is vetted (https, public
 * host — see safeUrl.ts), the read is bounded, and redirects are refused rather than
 * followed, since a vetted host could otherwise bounce us to an unvetted one.
 */
async function safeFetch(url: string | URL, opts: NetOpts): Promise<Response> {
  const u = await assertPublicHttpsUrl(String(url), opts.lookup ?? systemLookup);
  const res = await (opts.fetch ?? fetch)(u, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'manual',
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`refusing to follow redirect from ${u.host}: ${res.status}`);
  }
  return res;
}

export async function resolveDidDoc(did: string, opts: NetOpts = {}): Promise<DidDoc> {
  let url: string;
  if (did.startsWith('did:plc:')) {
    if (!/^did:plc:[a-z0-9]+$/i.test(did)) throw new Error(`malformed did:plc: ${did}`);
    url = `https://plc.directory/${did}`;
  } else if (did.startsWith('did:web:')) {
    // did:web encodes a port as %3A; a path as further colons. Only bare hosts are
    // accepted here — the vetting below sees exactly the host that will be dialed.
    const host = did.slice('did:web:'.length);
    if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error(`unsupported did:web form: ${did}`);
    url = `https://${host}/.well-known/did.json`;
  } else {
    throw new Error(`unsupported DID method: ${did}`);
  }
  const res = await safeFetch(url, opts);
  if (!res.ok) throw new Error(`DID resolution failed for ${did}: ${res.status}`);
  return (await res.json()) as DidDoc;
}

/** The handle a DID document declares (`at://alice.example`), or null if it has none. */
export function handleOf(doc: DidDoc): string | null {
  const aka = doc.alsoKnownAs?.find((s) => s.startsWith('at://'));
  const handle = aka?.slice('at://'.length);
  return handle && /^[a-zA-Z0-9.-]{1,253}$/.test(handle) ? handle : null;
}

export async function resolvePds(did: string, opts: NetOpts = {}): Promise<string> {
  const doc = await resolveDidDoc(did, opts);
  const svc = doc.service?.find((s) => s.type === 'AtprotoPersonalDataServer');
  if (!svc || typeof svc.serviceEndpoint !== 'string') {
    throw new Error(`no PDS service in DID document for ${did}`);
  }
  // Vetted now, at resolution, so a poisonous endpoint never even enters the cache; and
  // again at every fetch, since the DNS answer can change under a cached name.
  const u = await assertPublicHttpsUrl(svc.serviceEndpoint, opts.lookup ?? systemLookup);
  return u.origin + u.pathname.replace(/\/$/, '');
}

/**
 * The declared handle for an authenticated DID, for display. Resolution failure is not an
 * error here: the caller falls back to showing the DID.
 */
export async function resolveHandle(did: string, opts: NetOpts = {}): Promise<string | null> {
  try {
    return handleOf(await resolveDidDoc(did, opts));
  } catch {
    return null;
  }
}

/** Unauthenticated reads straight from each participant's PDS. No firehose, no appview. */
export class PublicPdsReader implements RepoReader {
  private pdsCache = new Map<string, { pds: string; at: number }>();
  private opts: NetOpts;
  constructor(fetchImpl?: typeof fetch, lookup?: LookupFn) {
    this.opts = { fetch: fetchImpl, lookup };
  }

  private async pdsFor(did: string): Promise<string> {
    const hit = this.pdsCache.get(did);
    const now = Date.now();
    if (hit && now - hit.at < PDS_CACHE_TTL_MS) return hit.pds;
    const pds = await resolvePds(did, this.opts);
    if (this.pdsCache.size >= PDS_CACHE_MAX && !this.pdsCache.has(did)) {
      const oldest = this.pdsCache.keys().next().value;
      if (oldest !== undefined) this.pdsCache.delete(oldest);
    }
    this.pdsCache.set(did, { pds, at: now });
    return pds;
  }

  async getRecord(did: string, collection: string, rkey: string): Promise<FoundRecord | null> {
    const pds = await this.pdsFor(did);
    const u = new URL(`${pds}/xrpc/com.atproto.repo.getRecord`);
    u.searchParams.set('repo', did);
    u.searchParams.set('collection', collection);
    u.searchParams.set('rkey', rkey);
    const res = await safeFetch(u, this.opts);
    // Only a real 404 means "the host withdrew this record" — anything else is our problem,
    // and must not be mistaken for a deletion by the tombstoning caller.
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`getRecord failed for ${did}: ${res.status}`);
    const body = (await res.json()) as { uri: string; cid: string; value: Record<string, unknown> };
    return { uri: body.uri, cid: body.cid, value: body.value };
  }

  async listRecords(did: string, collection: string): Promise<FoundRecord[]> {
    const pds = await this.pdsFor(did);
    const out: FoundRecord[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      if (++pages > MAX_PAGES) throw new Error(`listRecords exceeded page cap for ${did}`);
      const u = new URL(`${pds}/xrpc/com.atproto.repo.listRecords`);
      u.searchParams.set('repo', did);
      u.searchParams.set('collection', collection);
      u.searchParams.set('limit', '100');
      if (cursor) u.searchParams.set('cursor', cursor);
      const res = await safeFetch(u, this.opts);
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
    async deleteRecord(repo, collection, rkey): Promise<void> {
      await agent.com.atproto.repo.deleteRecord({ repo, collection, rkey });
    },
  };
}
