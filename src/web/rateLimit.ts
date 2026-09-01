/** Bucket keys are attacker-influenced, so the map is capped and evicts oldest-first. */
const MAX_KEYS = 10_000;

export class TokenBucket {
  private state = new Map<string, { tokens: number; at: number }>();
  constructor(private capacity: number, private refillPerSecond: number) {}

  /** Number of tracked keys; bounded by MAX_KEYS. */
  get size(): number {
    return this.state.size;
  }

  allow(key: string, nowMs: number): boolean {
    if (this.state.size >= MAX_KEYS && !this.state.has(key)) {
      const oldest = this.state.keys().next().value;
      if (oldest !== undefined) this.state.delete(oldest);
    }
    const cur = this.state.get(key) ?? { tokens: this.capacity, at: nowMs };
    const refilled = Math.min(
      this.capacity,
      cur.tokens + ((nowMs - cur.at) / 1000) * this.refillPerSecond,
    );
    if (refilled < 1) {
      this.state.set(key, { tokens: refilled, at: nowMs });
      return false;
    }
    this.state.set(key, { tokens: refilled - 1, at: nowMs });
    return true;
  }
}
