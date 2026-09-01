export class TokenBucket {
  private state = new Map<string, { tokens: number; at: number }>();
  constructor(private capacity: number, private refillPerSecond: number) {}

  allow(key: string, nowMs: number): boolean {
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
