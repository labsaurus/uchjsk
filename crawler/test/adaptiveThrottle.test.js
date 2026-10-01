import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveThrottle } from '../src/http/adaptiveThrottle.js';
import { Outcome } from '../src/http/outcomes.js';
import { testConfig, fakeClock } from './helpers.js';

function make(over = {}) {
  const c = fakeClock();
  const cfg = testConfig({
    CONCURRENCY: '5', MIN_CONCURRENCY: '1', MAX_CONCURRENCY: '8',
    ADAPTIVE_WINDOW_SIZE: '10', ADAPTIVE_INCREASE_INTERVAL_MS: '60000', ADAPTIVE_DECREASE_COOLDOWN_MS: '1000',
    ...over,
  });
  return { c, t: new AdaptiveThrottle(cfg, { now: c.now }) };
}

test('429 halves concurrency and doubles delay, never below min', () => {
  const { c, t } = make();
  t.record(Outcome.RATE_LIMITED);
  assert.equal(t.concurrency, 2);
  assert.equal(t.multiplier, 2);
  t.record(Outcome.RATE_LIMITED); // within cooldown: no double-penalty
  assert.equal(t.concurrency, 2);
  c.t += 2000;
  t.record(Outcome.RATE_LIMITED);
  assert.equal(t.concurrency, 1);
  c.t += 2000;
  t.record(Outcome.RATE_LIMITED);
  assert.equal(t.concurrency, 1);
  assert.equal(t.multiplier, 8);
});

test('repeated server errors progressively slow down', () => {
  const { c, t } = make();
  for (let i = 0; i < 3; i++) t.record(Outcome.SERVER_ERROR);
  assert.equal(t.concurrency, 4);
  assert.equal(t.multiplier, 1.5);
  c.t += 2000;
  t.record(Outcome.NETWORK);
  assert.equal(t.concurrency, 3);
});

test('recovers gradually only after a stable window and interval', () => {
  const { c, t } = make();
  t.record(Outcome.RATE_LIMITED); // conc 2, mult 2
  for (let i = 0; i < 20; i++) t.record(Outcome.OK);
  assert.equal(t.concurrency, 2, 'no increase before interval elapses');
  // The 429 is still in the 10-sample window until 10 OKs pass; then wait the interval.
  c.t += 61_000;
  t.record(Outcome.OK);
  assert.equal(t.multiplier, 1.33, 'delay recovers first');
  assert.equal(t.concurrency, 2);
  t.record(Outcome.OK);
  assert.equal(t.multiplier, 1.33, 'only one step per interval');
  c.t += 61_000; t.record(Outcome.OK);
  assert.equal(t.multiplier, 1);
  c.t += 61_000; t.record(Outcome.OK);
  assert.equal(t.concurrency, 3, 'then +1 concurrency');
});

test('never exceeds max concurrency', () => {
  const { c, t } = make({ CONCURRENCY: '8' });
  for (let i = 0; i < 50; i++) { c.t += 61_000; t.record(Outcome.OK); }
  assert.equal(t.concurrency, 8);
});
