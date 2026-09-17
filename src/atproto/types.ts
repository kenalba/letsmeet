export interface RecordRef { uri: string; cid: string }
export interface FoundRecord extends RecordRef { value: Record<string, unknown> }
export interface RepoReader {
  getRecord(did: string, collection: string, rkey: string): Promise<FoundRecord | null>;
  listRecords(did: string, collection: string): Promise<FoundRecord[]>;
}
export interface RepoWriter {
  createRecord(repo: string, collection: string, record: object): Promise<RecordRef>;
  putRecord(repo: string, collection: string, rkey: string, record: object): Promise<RecordRef>;
  deleteRecord(repo: string, collection: string, rkey: string): Promise<void>;
}
export interface Deps {
  db: import('../db/db.js').Database.Database;
  reader: RepoReader;
  writerFor(did: string): Promise<RepoWriter>;
  now(): Date;
  /** Override the PDS revalidation window (ms); tests set 0 to force live reads. */
  revalidateTtlMs?: number;
  /**
   * The handle a DID's document declares, or null if it has none or cannot be read. It
   * names a responder whose handle was not captured when they answered, and heads the
   * public page on `<name>.sez.<site>` — there it is only trusted once `resolveDid` takes
   * it back to the same DID. Absent in fake mode, where people are shown by DID.
   */
  resolveHandle?(did: string): Promise<string | null>;
  /**
   * The DID a handle points at, for the public `/u/<handle>` pages. Absent in fake mode,
   * where the routes accept a `did:` literal in the handle's place.
   */
  resolveDid?(handle: string): Promise<string | null>;
}
