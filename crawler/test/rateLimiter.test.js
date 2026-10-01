import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/http/rateLimiter.js';
import { fakeClock } from './helpers.js';

test('enforces minimum spacing between requests', async () => {
  const c = fakeClock();
  const rl = new RateLimiter({ minIntervalMs: 1000, jitterMs: 0, maxPerMinute: 600, now: c.now, sleepFn: c.sleep, jitterFn: () => 0 });
  const starts = [];
  for (let i = 0; i < 5; i++) {
    await rl.acquire();
    starts.push(c.t);
  }
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 1000);
});

test('token bucket caps requests per minute', async () => {
  const c = fakeClock();
  const rl = new RateLimiter({ minIntervalMs: 0, jitterMs: 0, maxPerMinute: 30, now: c.now, sleepFn: c.sleep, jitterFn: () => 0 });
  const t0 = c.t;
  for (let i = 0; i < 61; i++) await rl.acquire();
  // 61 requests at 30/min need ~2 minutes (minus the 1 initial token).
  assert.ok(c.t - t0 >= 119_000, `elapsed ${c.t - t0}`);
});

test('slowdown multiplier and pauseFor delay requests', async () => {
  const c = fakeClock();
  const rl = new RateLimiter({ minIntervalMs: 1000, jitterMs: 0, maxPerMinute: 6000, now: c.now, sleepFn: c.sleep, jitterFn: () => 0 });
  rl.setMultiplier(4);
  await rl.acquire();
  const t1 = c.t;
  await rl.acquire();
  assert.ok(c.t - t1 >= 4000);
  rl.pauseFor(60_000);
  const t2 = c.t;
  await rl.acquire();
  assert.ok(c.t - t2 >= 60_000);
});

test('concurrent waiters are serialized (no burst)', async () => {
  const c = fakeClock();
  const rl = new RateLimiter({ minIntervalMs: 500, jitterMs: 0, maxPerMinute: 6000, now: c.now, sleepFn: c.sleep, jitterFn: () => 0 });
  const starts = [];
  await Promise.all(Array.from({ length: 6 }, () => rl.acquire().then(() => starts.push(c.t))));
  starts.sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 500);
});

test('acquire is abortable', async () => {
  const rl = new RateLimiter({ minIntervalMs: 60_000, jitterMs: 0, maxPerMinute: 1 });
  await rl.acquire();
  const ac = new AbortController();
  const p = rl.acquire(ac.signal);
  ac.abort(new Error('stop'));
  await assert.rejects(p, /stop/);
});
