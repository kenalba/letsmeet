import type { Deps } from '../atproto/types.js';
import { UserError } from '../core/errors.js';
import { fallbackHandles, hyphenateHandle, isReservedSezName, isValidSezName } from '../core/sezName.js';
import {
  claimSezName, claimedSezNameFor, forgetSezName, getSezName, rememberFallback, releaseSezName,
} from '../db/sezNames.js';
import { freshnessFor } from './freshness.js';

/** A handle is dot-separated LDH labels; anything else (a `did:` literal) has no hyphenated form. */
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** `sez.letsmeet.lol`: what every address ends in. */
export const sezSuffixFor = (publicUrl: string): string => `sez.${new URL(publicUrl).host}`;

export const sezHost = (name: string, publicUrl: string): string => `${name}.${sezSuffixFor(publicUrl)}`;

/** The address anyone with a handle has without claiming anything. */
export function fallbackAddressFor(handle: string | null | undefined, publicUrl: string): string | null {
  if (!handle || !HANDLE_RE.test(handle)) return null;
  const label = hyphenateHandle(handle);
  // Everything before `.sez.<site>` is one DNS label: past 63 characters the host cannot
  // exist, and `aliasLabelOf` would not accept it back. Better no address than a dead one.
  return label.length > 63 ? null : sezHost(label, publicUrl);
}

/** Where this person's page is shared: their claimed name, else their hyphenated handle. */
export function sezAddressFor(
  deps: Deps, did: string, handle: string | null | undefined, publicUrl: string,
): string | null {
  const claimed = claimedSezNameFor(deps.db, did);
  return claimed ? sezHost(claimed, publicUrl) : fallbackAddressFor(handle, publicUrl);
}

/**
 * What the editor's address field opens with: the claimed name; else the name the record
 * says (the table was rebuilt) if it is still free; else the handle's first label if free;
 * else the hyphenated handle. Free means valid, unreserved, and not another DID's claim —
 * an implicit row is free, a claim overwrites it. Nothing for a nameless session.
 */
export function suggestedSezName(
  deps: Deps, did: string, handle: string | null | undefined, recordAlias: string | null,
): string {
  const claimed = claimedSezNameFor(deps.db, did);
  if (claimed) return claimed;
  const free = (name: string): boolean => {
    if (!isValidSezName(name) || isReservedSezName(name)) return false;
    const holder = getSezName(deps.db, name);
    return holder === null || !holder.claimed || holder.did === did;
  };
  if (recordAlias && free(recordAlias)) return recordAlias;
  if (!handle || !HANDLE_RE.test(handle)) return '';
  const first = handle.toLowerCase().split('.')[0];
  if (free(first)) return first;
  const hyphenated = hyphenateHandle(handle);
  return isValidSezName(hyphenated) ? hyphenated : '';
}

/** The DID the first resolving reading of `label` belongs to. Null with no resolver (fake mode). */
async function decodeFallback(deps: Deps, label: string): Promise<string | null> {
  if (!deps.resolveDid) return null;
  for (const handle of fallbackHandles(label)) {
    const did = await deps.resolveDid(handle);
    if (did) return did;
  }
  return null;
}

/**
 * Who `<label>.sez.<site>` belongs to. A claimed row answers outright. Otherwise the label
 * is read as a hyphenated handle: a decode is trusted for one freshness window — the row
 * it found, or the fact that it found nothing — and re-checked after it (a handle can
 * move, or stop resolving). A resolver that is down serves the row it has; with none it
 * throws, and the route says "try again" rather than "nobody here".
 */
export async function resolveSezName(deps: Deps, label: string): Promise<string | null> {
  const row = getSezName(deps.db, label);
  if (row?.claimed) return row.did;
  const fresh = freshnessFor(deps);
  const nowMs = deps.now().getTime();
  const key = `sez:${label}`;
  // A miss costs as many resolver calls as the label has readings, and an unclaimed label
  // is exactly what a crawler walks: the window gates both answers, not just the row's.
  if (fresh.isFresh(key, nowMs)) return row?.did ?? null;
  let did: string | null;
  try {
    did = await decodeFallback(deps, label);
  } catch (err) {
    if (!row) throw err;
    console.warn(`sez fallback re-check failed for ${label}; serving the row:`, err);
    return row.did;
  }
  fresh.mark(key, nowMs);
  if (row && row.did !== did) forgetSezName(deps.db, label);
  if (did && row?.did !== did) rememberFallback(deps.db, label, did, nowMs);
  return did;
}

/** Reserved outright, or readable as a handle that is somebody else's. */
async function isReservedFor(deps: Deps, name: string, did: string): Promise<boolean> {
  if (isReservedSezName(name)) return true;
  if (!deps.resolveDid) return false;
  for (const handle of fallbackHandles(name)) {
    const owner = await deps.resolveDid(handle);
    if (owner && owner !== did) return true;
  }
  return false;
}

/**
 * Make `name` this DID's claim (null: release whatever it holds). "Taken" and "reserved"
 * are decided here, in words. Nothing about the record: `saveAvailability` writes that
 * next, and calls `undoSezClaim` if the PDS refuses.
 */
export async function applySezClaim(deps: Deps, did: string, name: string | null): Promise<void> {
  if (name === null) { releaseSezName(deps.db, did); return; }
  const holder = getSezName(deps.db, name);
  if (holder?.claimed && holder.did !== did) throw new UserError('that name is taken.');
  let reserved: boolean;
  try {
    reserved = await isReservedFor(deps, name, did);
  } catch (err) {
    // Granting a hyphenated name without knowing whose handle it reads as would let a
    // resolver blip hand someone else's address over. Refuse for now, not for good.
    console.warn(`could not check sez name ${name} for ${did}:`, err);
    throw new UserError("couldn't check that name right now. try again in a minute.");
  }
  if (reserved) throw new UserError('that name is reserved.');
  try {
    claimSezName(deps.db, name, did, deps.now().getTime());
  } catch (err) {
    // The check above and this write are not one transaction — nothing can hold a sqlite
    // transaction open across the resolver await. A claim that landed in that window is
    // refused by the transaction's own guard; say it the same way the check would have.
    const holder = getSezName(deps.db, name);
    if (holder?.claimed && holder.did !== did) throw new UserError('that name is taken.');
    throw err;
  }
}

/** Put the table back the way it was before `applySezClaim`. Loses gracefully to a race. */
export function undoSezClaim(deps: Deps, did: string, previous: string | null): void {
  try {
    if (previous === null) releaseSezName(deps.db, did);
    else claimSezName(deps.db, previous, did, deps.now().getTime());
  } catch (err) {
    console.error(`could not restore sez name ${previous ?? '(none)'} for ${did}:`, err);
  }
}
