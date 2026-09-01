import { describe, it, expect } from 'vitest';
import { SCOPE } from '../../src/atproto/oauthClient.js';
import { SCHEDULE_NSID, RESPONSE_NSID, EVENT_NSID } from '../../src/atproto/records.js';

describe('OAuth scope', () => {
  it('asks for the record types the app writes, and never the catch-all', () => {
    const scopes = SCOPE.split(' ');
    expect(scopes[0]).toBe('atproto');
    expect(scopes.filter((s) => s.startsWith('transition:'))).toEqual([]);
    for (const nsid of [SCHEDULE_NSID, RESPONSE_NSID, EVENT_NSID]) {
      expect(scopes.some((s) => s === `repo:${nsid}` || s.startsWith(`repo:${nsid}?`))).toBe(true);
    }
    // Three collections, three grants: a new write path must show up here too.
    expect(scopes.filter((s) => s.startsWith('repo:'))).toHaveLength(3);
    // Nothing wildcarded.
    expect(SCOPE).not.toContain('repo:*');
  });
});
