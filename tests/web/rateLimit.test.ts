import { describe, it, expect } from 'vitest';
import { TokenBucket } from '../../src/web/rateLimit.js';

describe('TokenBucket', () => {
  it('allows up to capacity, then denies', () => {
    const tb = new TokenBucket(3, 0.1);
    expect(tb.allow('ip1', 0)).toBe(true);
    expect(tb.allow('ip1', 0)).toBe(true);
    expect(tb.allow('ip1', 0)).toBe(true);
    expect(tb.allow('ip1', 0)).toBe(false);
  });
  it('keys are independent', () => {
    const tb = new TokenBucket(1, 0.1);
    expect(tb.allow('ip1', 0)).toBe(true);
    expect(tb.allow('ip2', 0)).toBe(true);
  });
  it('caps tracked keys so attacker-rotated keys cannot grow state without bound', () => {
    const tb = new TokenBucket(3, 0.1);
    for (let i = 0; i < 10_001; i++) tb.allow(`ip${i}`, 0);
    expect(tb.size).toBe(10_000);
    expect(tb.allow('ip10000', 0)).toBe(true); // still functional after eviction
    expect(tb.size).toBe(10_000);
  });
  it('refills over time up to capacity', () => {
    const tb = new TokenBucket(2, 0.1); // one token per 10s
    tb.allow('ip1', 0); tb.allow('ip1', 0);
    expect(tb.allow('ip1', 5_000)).toBe(false);
    expect(tb.allow('ip1', 10_000)).toBe(true);
    expect(tb.allow('ip1', 1_000_000)).toBe(true); // capped at capacity, not unbounded
    expect(tb.allow('ip1', 1_000_000)).toBe(true);
    expect(tb.allow('ip1', 1_000_000)).toBe(false);
  });
});
