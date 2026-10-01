import { buildConfig } from '../src/config.js';

export function testConfig(overrides = {}) {
  const env = {
    MIN_REQUEST_INTERVAL_MS: '0',
    REQUEST_JITTER_MS: '0',
    MAX_REQUESTS_PER_MINUTE: '600',
    BACKOFF_BASE_MS: '100',
    BACKOFF_MAX_MS: '1000',
    LOG_LEVEL: 'error',
    ...overrides,
  };
  return buildConfig(env);
}

/** Deterministic clock whose sleep() advances time instantly. */
export function fakeClock(start = 1_000_000) {
  const clock = {
    t: start,
    now: () => clock.t,
    slept: [],
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason;
      clock.slept.push(ms);
      clock.t += ms;
    },
  };
  return clock;
}
