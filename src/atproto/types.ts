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
   * The handle a DID's document declares, or null if it has none or cannot be read. Used
   * to name a responder whose handle was not captured when they answered; absent in fake
   * mode, where responders are shown by DID.
   */
  resolveHandle?(did: string): Promise<string | null>;
}
