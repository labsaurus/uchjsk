import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, State } from '../src/http/circuitBreaker.js';
import { Outcome } from '../src/http/outcomes.js';
import { testConfig, fakeClock } from './helpers.js';

function make() {
  const c = fakeClock();
  const cfg = testConfig({
    BREAKER_WINDOW_SIZE: '10', BREAKER_MIN_SAMPLES: '10', BREAKER_FAILURE_THRESHOLD: '0.5',
    BREAKER_COOLDOWN_MS: '60000', BREAKER_MAX_COOLDOWN_MS: '200000', BREAKER_HALF_OPEN_SUCCESSES: '2',
    BREAKER_MAX_TRIPS_PER_RUN: '2',
  });
  return { c, b: new CircuitBreaker(cfg, { now: c.now, sleepFn: c.sleep }) };
}

test('opens on high failure ratio and blocks requests for the cooldown', async () => {
  const { c, b } = make();
  for (let i = 0; i < 5; i++) b.record(Outcome.OK);
  for (let i = 0; i < 4; i++) b.record(Outcome.RATE_LIMITED);
  assert.equal(b.state, State.CLOSED, 'needs min samples');
  b.record(Outcome.SERVER_ERROR);
  assert.equal(b.state, State.OPEN);
  const t0 = c.t;
  const done = await b.acquire();
  assert.ok(c.t - t0 >= 60_000, 'waited out the cooldown');
  assert.equal(b.state, State.HALF_OPEN);
  done(Outcome.OK);
});

test('half-open: single probe; failure re-opens with longer cooldown; successes close', async () => {
  const { c, b } = make();
  b.trip();
  let done = await b.acquire();
  assert.equal(b.concurrencyCap(5), 1);
  done(Outcome.RATE_LIMITED);
  assert.equal(b.state, State.OPEN);
  assert.equal(b.openUntil - c.t, 120_000, 'cooldown doubled');
  done = await b.acquire(); done(Outcome.OK);
  done = await b.acquire(); done(Outcome.OK);
  assert.equal(b.state, State.CLOSED);
  assert.equal(b.nextCooldownMs, 60_000, 'cooldown reset after recovery');
});

test('exhausted after too many trips', () => {
  const { b } = make();
  b.trip(); b.trip();
  assert.equal(b.exhausted, false);
  b.trip();
  assert.equal(b.exhausted, true);
});

test('restore keeps an open circuit open across restarts', () => {
  const { c, b } = make();
  b.restore({ state: 'open', openUntil: c.t + 30_000, nextCooldownMs: 120_000, trips: 1 });
  assert.equal(b.state, State.OPEN);
  assert.equal(b.openUntil, c.t + 30_000);
});
