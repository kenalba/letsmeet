import { UserError } from './errors.js';

export const SEZ_NAME_MAX = 32;
/** A label with more hyphens than this allows readings for is not decoded at all. */
export const MAX_FALLBACK_CANDIDATES = 16;

/** Names nobody may claim: infrastructure, our own sites, our own paths. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'www', 'api', 'app', 'admin', 'mail', 'smtp', 'imap', 'ftp', 'ns1', 'ns2', 'sez', 'letsmeet',
  'letssuite', 'letseat', 'letsyeet', 'status', 'docs', 'dev', 'test', 'internal', 'internal-tls',
  'u', 'p', 'availability',
]);

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/** One LDH label of a hostname, as a certificate reads it. */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const SEZ_NAME_RULE =
  'an address is 1 to 32 lowercase letters, digits or hyphens, with no hyphen at either end and no double hyphen.';

/** `--` is refused so a hyphenated handle can never collide with a chosen name. */
export function isValidSezName(name: string): boolean {
  return NAME_RE.test(name) && !name.includes('--');
}

/** What the editor posted as a name: null for "none" (a release), or the lowercase name. */
export function normalizeSezName(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new UserError('your address must be text.');
  const name = raw.trim().toLowerCase();
  if (!name) return null;
  if (!isValidSezName(name)) throw new UserError(SEZ_NAME_RULE);
  return name;
}

export function isReservedSezName(name: string): boolean {
  return RESERVED_NAMES.has(name);
}

/** `ken.wzrdz.cool` → `ken-wzrdz-cool`: the label anyone has without claiming one. */
export function hyphenateHandle(handle: string): string {
  return handle.toLowerCase().replace(/\.$/, '').replaceAll('.', '-');
}

/**
 * Every handle that hyphenates to `label`, most dots first (the all-dots reading is the
 * usual one), ties in enumeration order. A handle that itself has a hyphen
 * (`foo-bar.bsky.social`) is why more than one reading exists. Empty when there is no
 * hyphen (a handle has at least two labels) or too many (2ⁿ readings past the cap).
 */
export function fallbackHandles(label: string): string[] {
  const positions: number[] = [];
  for (let i = 0; i < label.length; i++) if (label[i] === '-') positions.push(i);
  const n = positions.length;
  if (n === 0 || 2 ** n > MAX_FALLBACK_CANDIDATES) return [];
  const readings: Array<{ handle: string; dots: number }> = [];
  for (let mask = 1; mask < 2 ** n; mask++) {
    const chars = label.split('');
    let dots = 0;
    for (let b = 0; b < n; b++) {
      if (mask & (1 << b)) { chars[positions[b]] = '.'; dots++; }
    }
    const handle = chars.join('');
    if (handle.split('.').every((l) => LABEL_RE.test(l))) readings.push({ handle, dots });
  }
  return readings.sort((a, b) => b.dots - a.dots).map((r) => r.handle);
}
