// Circuit breaker.
//
// CLOSED     normal operation; failures tracked in a sliding window.
// OPEN       failure ratio exceeded threshold. NO requests are sent until the
//            cooldown expires. Each consecutive trip doubles the cooldown (capped).
// HALF_OPEN  cooldown expired; exactly one probe request at a time. A few
//            consecutive successes close the circuit, any failure re-opens it.

import { sleep } from '../lib/sleep.js';
import { isFailure } from './outcomes.js';

export const State = Object.freeze({ CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' });

export class CircuitBreaker {
  constructor(cfg, { now = Date.now, sleepFn = sleep, onStateChange = () => {} } = {}) {
    this.windowSize = cfg.breakerWindowSize;
    this.minSamples = cfg.breakerMinSamples;
    this.threshold = cfg.breakerFailureThreshold;
    this.baseCooldownMs = cfg.breakerCooldownMs;
    this.maxCooldownMs = cfg.breakerMaxCooldownMs;
    this.halfOpenSuccesses = cfg.breakerHalfOpenSuccesses;
    this.maxTrips = cfg.breakerMaxTripsPerRun;
    this.now = now;
    this.sleep = sleepFn;
    this.onStateChange = onStateChange;

    this.state = State.CLOSED;
    this.window = [];
    this.openUntil = 0;
    this.nextCooldownMs = this.baseCooldownMs;
    this.trips = 0;
    this.probeInFlight = false;
    this.probeSuccesses = 0;
  }

  get exhausted() {
    return this.trips > this.maxTrips;
  }

  failureRate() {
    if (!this.window.length) return 0;
    return this.window.filter(isFailure).length / this.window.length;
  }

  _setState(s, extra = {}) {
    const from = this.state;
    this.state = s;
    this.onStateChange({ from, to: s, trips: this.trips, openUntil: this.openUntil, ...extra });
  }

  trip(reason = 'failure_threshold') {
    this.trips++;
    const cooldown = this.nextCooldownMs;
    this.openUntil = this.now() + cooldown;
    this.nextCooldownMs = Math.min(this.maxCooldownMs, this.nextCooldownMs * 2);
    this.window = [];
    this.probeInFlight = false;
    this.probeSuccesses = 0;
    this._setState(State.OPEN, { reason, cooldownMs: cooldown });
  }

  /**
   * Block until a request is allowed. Returns a `done(outcome)` callback that
   * MUST be called exactly once (use `done(null)` if the request was never
   * sent / was aborted).
   */
  async acquire(signal) {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      if (this.state === State.OPEN) {
        const wait = this.openUntil - this.now();
        if (wait > 0) {
          await this.sleep(Math.min(wait, 60_000), signal);
          continue;
        }
        this.probeSuccesses = 0;
        this._setState(State.HALF_OPEN);
      }
      if (this.state === State.HALF_OPEN) {
        if (this.probeInFlight) {
          await this.sleep(1000, signal);
          continue;
        }
        this.probeInFlight = true;
        return this._ticket(true);
      }
      return this._ticket(false);
    }
  }

  _ticket(isProbe) {
    let used = false;
    return (outcome) => {
      if (used) return;
      used = true;
      if (isProbe) this.probeInFlight = false;
      if (outcome != null) this.record(outcome, isProbe);
    };
  }

  record(outcome, isProbe = false) {
    if (this.state === State.OPEN) return; // late results from before the trip
    if (this.state === State.HALF_OPEN) {
      if (!isProbe) return;
      if (isFailure(outcome)) {
        this.trip('half_open_probe_failed');
      } else if (++this.probeSuccesses >= this.halfOpenSuccesses) {
        this.window = [];
        this.nextCooldownMs = this.baseCooldownMs;
        this._setState(State.CLOSED);
      }
      return;
    }
    this.window.push(outcome);
    if (this.window.length > this.windowSize) this.window.shift();
    if (this.window.length >= this.minSamples && this.failureRate() >= this.threshold) {
      this.trip();
    }
  }

  /** Effective concurrency cap imposed by the breaker. */
  concurrencyCap(desired) {
    return this.state === State.CLOSED ? desired : 1;
  }

  snapshot() {
    return { state: this.state, openUntil: this.openUntil, nextCooldownMs: this.nextCooldownMs, trips: this.trips };
  }

  /**
   * Restore after a restart: if we were OPEN, keep waiting out the cooldown and
   * keep the escalated cooldown length. The per-run trip budget starts fresh so
   * a paused run can make progress again on the next invocation.
   */
  restore(s) {
    if (!s) return;
    if (Number.isFinite(s.nextCooldownMs)) this.nextCooldownMs = Math.min(this.maxCooldownMs, Math.max(this.baseCooldownMs, s.nextCooldownMs));
    if ((s.state === State.OPEN || s.state === State.HALF_OPEN) && Number.isFinite(s.openUntil)) {
      this.openUntil = s.openUntil;
      this.state = State.OPEN; // a half-open probe restarts from OPEN
    }
  }
}
