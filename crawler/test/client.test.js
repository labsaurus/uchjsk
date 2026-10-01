import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../src/http/client.js';
import { RateLimiter } from '../src/http/rateLimiter.js';
import { AdaptiveThrottle } from '../src/http/adaptiveThrottle.js';
import { CircuitBreaker } from '../src/http/circuitBreaker.js';
import { BlockedError, DisallowedError, RetryExhaustedError } from '../src/http/errors.js';
import { silentLogger } from '../src/lib/logger.js';
import { testConfig, fakeClock } from './helpers.js';
import { fakeFetch, ROBOTS } from './fixtures.js';

function makeClient(handler, over = {}) {
  const cfg = testConfig({ MAX_RETRIES: '3', ...over });
  const c = fakeClock();
  const limiter = new RateLimiter({ minIntervalMs: 0, jitterMs: 0, maxPerMinute: 6000, now: c.now, sleepFn: c.sleep });
  const throttle = new AdaptiveThrottle(cfg, { now: c.now });
  const breaker = new CircuitBreaker(cfg, { now: c.now, sleepFn: c.sleep });
  const fetchImpl = fakeFetch((url, n) => (url.endsWith('/robots.txt') ? { body: ROBOTS } : handler(url, n)));
  const client = new HttpClient({ cfg, limiter, breaker, throttle, logger: silentLogger, fetchImpl, sleepFn: c.sleep });
  return { client, fetchImpl, c, throttle, limiter };
}

const URL_OK = 'https://play.google.com/store/apps/details?id=com.a.b';

test('retries 503 then succeeds', async () => {
  let n = 0;
  const { client, fetchImpl } = makeClient(() => (++n < 3 ? { status: 503 } : { status: 200, body: 'ok' }));
  await client.loadRobots();
  const res = await client.get(URL_OK);
  assert.equal(res.status, 200);
  assert.equal(res.attempts, 3);
  assert.equal(fetchImpl.calls.length, 4); // robots + 3
});

test('gives up after max retries (never infinite)', async () => {
  const { client, fetchImpl } = makeClient(() => ({ status: 500 }));
  await client.loadRobots();
  await assert.rejects(client.get(URL_OK), RetryExhaustedError);
  assert.equal(fetchImpl.calls.length, 1 + 4);
});

test('respects Retry-After on 429 and slows down globally', async () => {
  let n = 0;
  const { client, c, throttle } = makeClient(() => (++n === 1 ? { status: 429, headers: { 'retry-after': '30' } } : { status: 200, body: 'ok' }));
  await client.loadRobots();
  const t0 = c.t;
  const res = await client.get(URL_OK);
  assert.equal(res.status, 200);
  assert.ok(c.t - t0 >= 30_000, 'waited at least Retry-After');
  assert.ok(throttle.multiplier > 1);
});

test('Retry-After beyond the configured max gives up instead of waiting', async () => {
  const { client } = makeClient(() => ({ status: 429, headers: { 'retry-after': '99999' } }), { RETRY_AFTER_MAX_MS: '60000' });
  await client.loadRobots();
  await assert.rejects(client.get(URL_OK), /exceeds RETRY_AFTER_MAX_MS/);
});

test('404 is returned, not retried', async () => {
  const { client, fetchImpl } = makeClient(() => ({ status: 404 }));
  await client.loadRobots();
  const res = await client.get(URL_OK);
  assert.equal(res.status, 404);
  assert.equal(fetchImpl.calls.length, 2);
});

test('CAPTCHA / anti-bot page stops immediately without retry', async () => {
  const { client, fetchImpl } = makeClient(() => ({ status: 429, body: '<div>Our systems have detected unusual traffic from your computer network</div>' }));
  await client.loadRobots();
  await assert.rejects(client.get(URL_OK), BlockedError);
  assert.equal(fetchImpl.calls.length, 2);
});

test('403 is treated as a block', async () => {
  const { client } = makeClient(() => ({ status: 403 }));
  await client.loadRobots();
  await assert.rejects(client.get(URL_OK), BlockedError);
});

test('robots.txt disallow is enforced before any request', async () => {
  const { client, fetchImpl } = makeClient(() => ({ status: 200 }));
  await client.loadRobots();
  await assert.rejects(client.get('https://play.google.com/store/search?q=x'), DisallowedError);
  assert.equal(fetchImpl.calls.length, 1);
});

test('robots.txt unreachable (5xx) means disallow all', async () => {
  const cfg = testConfig({ MAX_RETRIES: '0' });
  const c = fakeClock();
  const client = new HttpClient({
    cfg,
    limiter: new RateLimiter({ minIntervalMs: 0, jitterMs: 0, maxPerMinute: 6000, now: c.now, sleepFn: c.sleep }),
    breaker: new CircuitBreaker(cfg, { now: c.now, sleepFn: c.sleep }),
    throttle: new AdaptiveThrottle(cfg, { now: c.now }),
    logger: silentLogger,
    fetchImpl: fakeFetch(() => ({ status: 503 })),
    sleepFn: c.sleep,
  });
  await client.loadRobots();
  assert.equal(client.isAllowed(URL_OK), false);
});

test('oversized responses are rejected', async () => {
  const { client } = makeClient(() => ({ status: 200, body: 'x'.repeat(70 * 1024) }), { MAX_RESPONSE_BYTES: String(64 * 1024) });
  await client.loadRobots();
  await assert.rejects(client.get(URL_OK), /exceeded|too large/);
});
