// Global request rate limiter.
//
// Combines three constraints, all of which must be satisfied before a request
// may start:
//   1. a minimum spacing between consecutive request starts (+ random jitter),
//   2. a requests-per-minute token bucket,
//   3. a dynamic slowdown multiplier driven by the adaptive throttle.
// Requests are granted strictly one at a time (FIFO), so no matter how many
// workers are waiting there are never synchronized bursts.

import { sleep, jitter as randJitter } from '../lib/sleep.js';

export class RateLimiter {
  constructor({ minIntervalMs, jitterMs, maxPerMinute, now = Date.now, sleepFn = sleep, jitterFn = randJitter }) {
    this.minIntervalMs = minIntervalMs;
    this.jitterMs = jitterMs;
    this.capacity = Math.max(1, Math.min(maxPerMinute, Math.ceil(maxPerMinute / 6))); // small burst cap
    this.refillPerMs = maxPerMinute / 60_000;
    this.tokens = 1; // start nearly empty: no burst on startup
    this.lastRefill = now();
    this.nextAllowedAt = 0;
    this.multiplier = 1;
    this.now = now;
    this.sleep = sleepFn;
    this.jitter = jitterFn;
    this.chain = Promise.resolve();
  }

  setMultiplier(m) {
    this.multiplier = Math.max(1, m);
  }

  /** Raise the minimum spacing (e.g. robots.txt Crawl-delay). Never lowers it. */
  enforceMinInterval(ms) {
    if (ms > this.minIntervalMs) this.minIntervalMs = ms;
  }

  /** Push the next allowed request start further into the future. */
  pauseFor(ms) {
    this.nextAllowedAt = Math.max(this.nextAllowedAt, this.now() + ms);
  }

  _refill() {
    const t = this.now();
    const elapsed = t - this.lastRefill;
    this.lastRefill = t;
    // Slowdown multiplier also slows token refill.
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.refillPerMs) / this.multiplier);
  }

  /** Wait for permission to send one request. */
  acquire(signal) {
    const p = this.chain.then(() => this._acquireOne(signal));
    // Keep the chain alive even if this waiter is aborted.
    this.chain = p.catch(() => {});
    return p;
  }

  async _acquireOne(signal) {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      this._refill();
      const t = this.now();
      const spacingWait = this.nextAllowedAt - t;
      const tokenWait = this.tokens >= 1 ? 0 : ((1 - this.tokens) / this.refillPerMs) * this.multiplier;
      const wait = Math.max(spacingWait, tokenWait);
      if (wait <= 0) break;
      await this.sleep(Math.ceil(wait), signal);
    }
    this.tokens -= 1;
    const interval = this.minIntervalMs * this.multiplier + this.jitter(this.jitterMs);
    this.nextAllowedAt = this.now() + interval;
  }
}
