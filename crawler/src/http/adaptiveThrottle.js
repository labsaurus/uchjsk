// Adaptive throttling (AIMD-style).
//
//  * 429s           -> halve concurrency, double the delay multiplier.
//  * repeated errors -> drop concurrency by one, grow the delay multiplier.
//  * stable period   -> first shrink the delay multiplier, then add +1 worker,
//                       at most once per ADAPTIVE_INCREASE_INTERVAL_MS.
// Concurrency always stays within [MIN_CONCURRENCY, MAX_CONCURRENCY].

import { Outcome, isFailure } from './outcomes.js';

export class AdaptiveThrottle {
  constructor(cfg, { now = Date.now, onChange = () => {} } = {}) {
    this.min = cfg.minConcurrency;
    this.max = cfg.maxConcurrency;
    this.maxMultiplier = cfg.maxSlowdownMultiplier;
    this.windowSize = cfg.adaptiveWindowSize;
    this.errorThreshold = cfg.adaptiveErrorRateThreshold;
    this.stableRate = cfg.adaptiveStableErrorRate;
    this.increaseIntervalMs = cfg.adaptiveIncreaseIntervalMs;
    this.decreaseCooldownMs = cfg.adaptiveDecreaseCooldownMs;
    this.now = now;
    this.onChange = onChange;

    this.concurrency = cfg.concurrency;
    this.multiplier = 1;
    this.window = [];
    const t = now();
    this.lastDecreaseAt = -Infinity;
    this.lastIncreaseAt = t; // require a stable period before the first increase
    this.consecutiveErrors = 0;
  }

  stats() {
    const n = this.window.length;
    let rl = 0, err = 0;
    for (const o of this.window) {
      if (o === Outcome.RATE_LIMITED) rl++;
      if (isFailure(o)) err++;
    }
    return { samples: n, rateLimited: rl, errors: err, errorRate: n ? err / n : 0, rateLimitRate: n ? rl / n : 0 };
  }

  record(outcome) {
    this.window.push(outcome);
    if (this.window.length > this.windowSize) this.window.shift();
    const t = this.now();
    const before = { concurrency: this.concurrency, multiplier: this.multiplier };
    const canDecrease = t - this.lastDecreaseAt >= this.decreaseCooldownMs;

    if (outcome === Outcome.RATE_LIMITED) {
      this.consecutiveErrors++;
      if (canDecrease) {
        this.concurrency = Math.max(this.min, Math.floor(this.concurrency / 2));
        this.multiplier = Math.min(this.maxMultiplier, this.multiplier * 2);
        this._markDecrease(t);
      }
    } else if (isFailure(outcome)) {
      this.consecutiveErrors++;
      const { errorRate, samples } = this.stats();
      const highRate = samples >= Math.min(10, this.windowSize) && errorRate > this.errorThreshold;
      if (canDecrease && (highRate || this.consecutiveErrors >= 3)) {
        this.concurrency = Math.max(this.min, this.concurrency - 1);
        this.multiplier = Math.min(this.maxMultiplier, this.multiplier * 1.5);
        this._markDecrease(t);
      }
    } else {
      this.consecutiveErrors = 0;
      this._maybeIncrease(t);
    }

    if (before.concurrency !== this.concurrency || before.multiplier !== this.multiplier) {
      this.onChange({ from: before, to: { concurrency: this.concurrency, multiplier: this.multiplier }, outcome, ...this.stats() });
    }
  }

  _markDecrease(t) {
    this.lastDecreaseAt = t;
    this.lastIncreaseAt = t; // restart the stability clock
  }

  _maybeIncrease(t) {
    if (this.window.length < this.windowSize) return;
    if (t - this.lastIncreaseAt < this.increaseIntervalMs) return;
    const { errorRate, rateLimited } = this.stats();
    if (rateLimited > 0 || errorRate > this.stableRate) return;
    if (this.multiplier > 1) {
      this.multiplier = Math.max(1, Math.round((this.multiplier / 1.5) * 100) / 100);
    } else if (this.concurrency < this.max) {
      this.concurrency += 1;
    } else {
      return;
    }
    this.lastIncreaseAt = t;
  }

  snapshot() {
    return { concurrency: this.concurrency, multiplier: this.multiplier };
  }

  restore(s) {
    if (!s) return;
    if (Number.isFinite(s.concurrency)) this.concurrency = Math.min(this.max, Math.max(this.min, s.concurrency));
    if (Number.isFinite(s.multiplier)) this.multiplier = Math.min(this.maxMultiplier, Math.max(1, s.multiplier));
  }
}
