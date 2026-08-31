/**
 * Rate limiters for the two patterns most APIs use.
 *
 * Tune every limiter to the documented per-plan maximum minus a buffer
 * (5-10%), so the tool gets full throughput without triggering 429s. When
 * an API key is shared with other consumers (an accounting integration, a
 * coworker's scripts), leave a much larger share of the budget free; a
 * throttled agent is annoying, a throttled coworker is an incident.
 *
 * Examples:
 *
 *   // documented: 60 requests per minute -> 57 leaves 3 slots for retries
 *   export const billingLimiter = new WindowLimiter(57, 60_000);
 *
 *   // documented: leaky bucket of 80 with 4 per second refill
 *   export const shopLimiter = new TokenBucketLimiter(80, 4);
 *
 * Keep one exported instance per source, next to a comment naming the plan
 * and the date you verified the limit. When the plan changes, bump it in
 * one place.
 */

export class TokenBucketLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private maxTokens: number,
    private refillRate: number, // tokens per second
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      const waitMs = ((1 - this.tokens) / this.refillRate) * 1000;
      await sleep(waitMs + 50);
      this.refill();
    }
    this.tokens -= 1;
  }

  private refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

export class WindowLimiter {
  private timestamps: number[] = [];

  constructor(
    private maxRequests: number,
    private windowMs: number,
  ) {}

  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length >= this.maxRequests) {
      const oldest = this.timestamps[0];
      const waitMs = this.windowMs - (now - oldest) + 100;
      await sleep(waitMs);
      this.timestamps = this.timestamps.filter((t) => Date.now() - t < this.windowMs);
    }
    this.timestamps.push(Date.now());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
