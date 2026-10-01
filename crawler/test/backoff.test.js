import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBackoff, parseRetryAfter, retryDelay } from '../src/http/backoff.js';

const opts = { baseMs: 1000, maxMs: 30_000, retryAfterMaxMs: 60_000 };

test('exponential backoff grows and is capped, with jitter in [exp/2, exp]', () => {
  assert.equal(computeBackoff(0, opts, () => 0), 500);
  assert.equal(computeBackoff(0, opts, () => 1), 1000);
  assert.equal(computeBackoff(3, opts, () => 1), 8000);
  assert.equal(computeBackoff(20, opts, () => 1), 30_000);
  for (let i = 0; i < 100; i++) {
    const d = computeBackoff(2, opts);
    assert.ok(d >= 2000 && d <= 4000);
  }
});

test('Retry-After: seconds and HTTP-date', () => {
  assert.equal(parseRetryAfter('120'), 120_000);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now), 30_000);
  assert.equal(parseRetryAfter('garbage'), null);
  assert.equal(parseRetryAfter(null), null);
});

test('Retry-After wins when longer; too-long Retry-After gives up', () => {
  assert.equal(retryDelay(0, 20_000, opts, () => 1), 20_000);
  assert.equal(retryDelay(3, 1000, opts, () => 1), 8000);
  assert.equal(retryDelay(0, 120_000, opts), null);
});
