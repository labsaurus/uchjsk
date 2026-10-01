// End-to-end crawler tests against a real PostgreSQL database with a fake
// network. Skipped unless TEST_DATABASE_URL is set, e.g.
//   TEST_DATABASE_URL=postgres://postgres@localhost:5432/crawler_test npm test
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, migrate } from '../src/db.js';
import { Store } from '../src/store.js';
import { Crawler } from '../src/crawler.js';
import { silentLogger } from '../src/lib/logger.js';
import { testConfig } from './helpers.js';
import { appPage, fakeFetch, ROBOTS } from './fixtures.js';

const DB = process.env.TEST_DATABASE_URL;
const opts = { skip: !DB && 'TEST_DATABASE_URL not set' };

let pool;
function cfgFor(over = {}) {
  return testConfig({ DATABASE_URL: DB, CONCURRENCY: '3', MAX_RETRIES: '1', ...over });
}

if (DB) {
  pool = createPool(cfgFor());
  beforeEach(async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
  });
  after(() => pool.end());
}

function site(handler) {
  return fakeFetch((url, n) => {
    if (url.endsWith('/robots.txt')) return { body: ROBOTS };
    const pkg = new URL(url).searchParams.get('id');
    return handler(pkg, n);
  });
}

async function apps() {
  const { rows } = await pool.query('SELECT * FROM apps ORDER BY package_name');
  return Object.fromEntries(rows.map((r) => [r.package_name, r]));
}

test('incremental crawl: success, 404, robots disallow, discovery, snapshots, daily idempotence', opts, async () => {
  const cfg = cfgFor();
  const store = new Store(pool, cfg);
  await store.addApps(['com.good.app', 'com.gone.app', 'com.disallowed.app'], { from: 'seed', priority: 200 });
  const fetchImpl = site((pkg) => {
    if (pkg === 'com.gone.app') return { status: 404 };
    if (pkg === 'com.good.app') return { body: appPage(pkg, { links: ['com.new.one', 'com.new.two'] }) };
    return { body: appPage(pkg) };
  });
  const res = await new Crawler({ cfg, pool, log: silentLogger, fetchImpl }).run();
  assert.equal(res.status, 'completed');

  const a = await apps();
  assert.equal(a['com.good.app'].status, 'active');
  assert.equal(a['com.good.app'].title, 'App com.good.app');
  assert.equal(a['com.gone.app'].status, 'not_found');
  assert.equal(a['com.disallowed.app'].status, 'disallowed');
  assert.equal(a['com.new.one'].status, 'active', 'discovered apps crawled in the same run');
  assert.equal(a['com.new.two'].discovered_from, 'com.good.app');
  assert.ok(a['com.good.app'].next_crawl_at > new Date(Date.now() + 20 * 3_600_000));
  assert.ok(!fetchImpl.calls.some((u) => u.includes('com.disallowed')), 'disallowed URL never fetched');

  const snaps = await pool.query('SELECT count(*)::int AS n FROM app_snapshots');
  assert.equal(snaps.rows[0].n, 3);
  const run = (await pool.query('SELECT * FROM crawl_runs')).rows[0];
  assert.equal(run.processed, 5);
  assert.equal(run.discovered, 2);

  // Same day again: nothing to do.
  const again = await new Crawler({ cfg, pool, log: silentLogger, fetchImpl }).run();
  assert.equal(again.status, 'already_completed');
  // Forced: nothing is due, so nothing is fetched.
  const before = fetchImpl.calls.length;
  const forced = await new Crawler({ cfg, pool, log: silentLogger, fetchImpl }).run({ force: true });
  assert.equal(forced.status, 'completed');
  assert.equal(fetchImpl.calls.length - before, 1, 'only robots.txt');
});

test('graceful interruption persists progress and the next run resumes the same run', opts, async () => {
  const cfg = cfgFor({ DISCOVERY_ENABLED: 'false' });
  const store = new Store(pool, cfg);
  const pkgs = Array.from({ length: 20 }, (_, i) => `com.app.n${i}`);
  await store.addApps(pkgs);

  let crawler;
  const fetch1 = site((pkg, n) => {
    if (n === 6) crawler.stop('signal:SIGTERM');
    return { body: appPage(pkg) };
  });
  crawler = new Crawler({ cfg, pool, log: silentLogger, fetchImpl: fetch1 });
  const r1 = await crawler.run();
  assert.equal(r1.status, 'interrupted');
  const leased = await pool.query('SELECT count(*)::int AS n FROM apps WHERE lease_owner IS NOT NULL');
  assert.equal(leased.rows[0].n, 0, 'no leases left behind');
  const done1 = (await pool.query("SELECT count(*)::int AS n FROM apps WHERE status = 'active'")).rows[0].n;
  assert.ok(done1 >= 4 && done1 < 20, `partial progress (${done1})`);

  const fetch2 = site((pkg) => ({ body: appPage(pkg) }));
  const r2 = await new Crawler({ cfg, pool, log: silentLogger, fetchImpl: fetch2 }).run();
  assert.equal(r2.status, 'completed');
  assert.equal(r2.runId, r1.runId, 'resumed the same run');
  const fetched2 = fetch2.calls.filter((u) => !u.endsWith('robots.txt'));
  assert.equal(fetched2.length, 20 - done1, 'already-crawled apps are not fetched again');
  const run = (await pool.query('SELECT * FROM crawl_runs WHERE id = $1', [r1.runId])).rows[0];
  assert.equal(run.processed, 20);
});

test('crash recovery: stale leases from a dead process are reclaimed', opts, async () => {
  const cfg = cfgFor();
  const store = new Store(pool, cfg);
  await store.addApps(['com.a.one', 'com.a.two']);
  const run = await store.createRun('incremental', 100);
  await store.claimBatch(run, 10); // simulate a process that died holding leases
  const res = await new Crawler({ cfg, pool, log: silentLogger, fetchImpl: site((p) => ({ body: appPage(p) })) }).run();
  assert.equal(res.status, 'completed');
  assert.equal(res.runId, run.id);
  const a = await apps();
  assert.equal(a['com.a.one'].status, 'active');
  assert.equal(a['com.a.two'].status, 'active');
});

test('anti-bot block stops the crawl and enforces a cooldown with zero requests', opts, async () => {
  const cfg = cfgFor();
  const store = new Store(pool, cfg);
  await store.addApps(Array.from({ length: 10 }, (_, i) => `com.blk.n${i}`));
  const fetch1 = site(() => ({ status: 403 }));
  const r1 = await new Crawler({ cfg, pool, log: silentLogger, fetchImpl: fetch1 }).run();
  assert.equal(r1.status, 'blocked');
  assert.ok(fetch1.calls.length <= 1 + cfg.concurrency, 'stopped immediately');
  const leased = await pool.query('SELECT count(*)::int AS n FROM apps WHERE lease_owner IS NOT NULL');
  assert.equal(leased.rows[0].n, 0);
  assert.ok((await store.getBlockedUntil()) > new Date());

  const fetch2 = site(() => ({ body: 'x' }));
  const r2 = await new Crawler({ cfg, pool, log: silentLogger, fetchImpl: fetch2 }).run();
  assert.equal(r2.status, 'blocked_cooldown');
  assert.equal(fetch2.calls.length, 0);
});

test('circuit breaker pauses the run when the server keeps failing', opts, async () => {
  const cfg = cfgFor({
    MAX_RETRIES: '0', CONCURRENCY: '1', BREAKER_WINDOW_SIZE: '5', BREAKER_MIN_SAMPLES: '5',
    BREAKER_COOLDOWN_MS: '1000', BREAKER_MAX_TRIPS_PER_RUN: '1', BREAKER_HALF_OPEN_SUCCESSES: '1',
  });
  const store = new Store(pool, cfg);
  await store.addApps(Array.from({ length: 30 }, (_, i) => `com.cb.n${i}`));
  const fetchImpl = site(() => ({ status: 503 }));
  const res = await new Crawler({ cfg, pool, log: silentLogger, fetchImpl }).run();
  assert.equal(res.status, 'paused');
  const sent = fetchImpl.calls.length - 1;
  assert.ok(sent < 15, `stopped sending requests early (sent ${sent})`);
  const run = (await pool.query('SELECT * FROM crawl_runs')).rows[0];
  assert.equal(run.breaker_state.state, 'open');
  const untouched = (await pool.query('SELECT count(*)::int AS n FROM apps WHERE last_attempt_at IS NULL')).rows[0].n;
  assert.ok(untouched > 10, 'remaining apps still due for the next run');
});

test('full rescan revisits every app and is resumable', opts, async () => {
  const cfg = cfgFor({ DISCOVERY_ENABLED: 'false' });
  const store = new Store(pool, cfg);
  await store.addApps(['com.f.one', 'com.f.two', 'com.f.three']);
  const ok = site((p) => ({ body: appPage(p) }));
  assert.equal((await new Crawler({ cfg, pool, log: silentLogger, fetchImpl: ok }).run()).status, 'completed');

  let crawler;
  const fetch2 = site((p, n) => {
    if (n === 2) crawler.stop('signal:SIGINT');
    return { body: appPage(p, { version: '2.0' }) };
  });
  crawler = new Crawler({ cfg, pool, log: silentLogger, fetchImpl: fetch2 });
  const r1 = await crawler.run({ mode: 'full' });
  assert.equal(r1.status, 'interrupted');

  // A plain `crawl` resumes the unfinished full rescan.
  const r2 = await new Crawler({ cfg, pool, log: silentLogger, fetchImpl: site((p) => ({ body: appPage(p, { version: '2.0' }) })) }).run();
  assert.equal(r2.runId, r1.runId);
  assert.equal(r2.status, 'completed');
  const a = await apps();
  for (const p of ['com.f.one', 'com.f.two', 'com.f.three']) assert.equal(a[p].version, '2.0');
  const snaps = (await pool.query('SELECT count(*)::int AS n FROM app_snapshots')).rows[0].n;
  assert.equal(snaps, 6, 'changed apps get a new snapshot');
});

test('only one instance may run at a time', opts, async () => {
  const cfg = cfgFor();
  const holder = await pool.connect();
  await holder.query('SELECT pg_advisory_lock(815337001)');
  try {
    const res = await new Crawler({ cfg, pool, log: silentLogger, fetchImpl: site(() => ({ body: '' })) }).run();
    assert.equal(res.status, 'locked');
  } finally {
    await holder.query('SELECT pg_advisory_unlock(815337001)');
    holder.release();
  }
});
