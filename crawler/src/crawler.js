// Crawl orchestration: run selection/resume, a dynamically sized worker pool,
// checkpointing, and graceful shutdown.

import { acquireInstanceLock } from './db.js';
import { Store } from './store.js';
import { RateLimiter } from './http/rateLimiter.js';
import { AdaptiveThrottle } from './http/adaptiveThrottle.js';
import { CircuitBreaker, State } from './http/circuitBreaker.js';
import { HttpClient } from './http/client.js';
import { BlockedError, DisallowedError, ResponseTooLargeError, RetryExhaustedError } from './http/errors.js';
import { detailsUrl, extractLinkedPackages, parseAppPage } from './parser.js';
import { sleep } from './lib/sleep.js';

const INT_MAX = 2_147_483_647;

export class Crawler {
  constructor({ cfg, pool, log, fetchImpl, sleepFn = sleep }) {
    this.cfg = cfg;
    this.pool = pool;
    this.log = log;
    this.store = new Store(pool, cfg);
    this.sleep = sleepFn;

    this.softStop = new AbortController(); // stop scheduling + abort waits
    this.hardStop = new AbortController(); // abort in-flight HTTP requests
    this.stopReason = null;

    this.limiter = new RateLimiter({
      minIntervalMs: cfg.minRequestIntervalMs,
      jitterMs: cfg.requestJitterMs,
      maxPerMinute: cfg.maxRequestsPerMinute,
      sleepFn,
    });
    this.throttle = new AdaptiveThrottle(cfg, {
      onChange: (e) => {
        this.limiter.setMultiplier(e.to.multiplier);
        this.log.warn('adaptive throttle adjusted', e);
      },
    });
    this.breaker = new CircuitBreaker(cfg, {
      sleepFn,
      onStateChange: (e) => this.log.warn('circuit breaker state change', e),
    });
    this.client = new HttpClient({
      cfg,
      limiter: this.limiter,
      breaker: this.breaker,
      throttle: this.throttle,
      logger: log,
      fetchImpl,
      sleepFn,
    });

    this.buffer = [];
    this.inflight = new Map(); // package_name -> promise
    this.dispatched = 0;
    this.discovered = 0;
    this.totalApps = 0;
    this.lastEmptyClaimAt = 0;
  }

  /** Request a graceful stop (signal handler, time budget, breaker exhaustion...). */
  stop(reason, { hard = false } = {}) {
    if (!this.stopReason) {
      this.stopReason = reason;
      this.log.info('stopping crawler', { reason, inflight: this.inflight.size });
    }
    if (!this.softStop.signal.aborted) this.softStop.abort(new Error(`stopped: ${reason}`));
    if (hard && !this.hardStop.signal.aborted) this.hardStop.abort(new Error(`hard stop: ${reason}`));
  }

  /**
   * @param {{mode?: 'incremental'|'full', force?: boolean}} opts
   * @returns {Promise<{status: string, runId?: number, message?: string}>}
   */
  async run({ mode = 'incremental', force = false } = {}) {
    const unlock = await acquireInstanceLock(this.pool);
    if (!unlock) {
      this.log.warn('another crawler instance holds the lock; exiting');
      return { status: 'locked' };
    }
    try {
      return await this._run(mode, force);
    } finally {
      await unlock().catch(() => {});
    }
  }

  async _run(requestedMode, force) {
    const blockedUntil = await this.store.getBlockedUntil();
    if (blockedUntil && blockedUntil > new Date()) {
      this.log.warn('crawler is in hard-block cooldown; not sending any requests', { blockedUntil });
      return { status: 'blocked_cooldown', message: `blocked until ${blockedUntil.toISOString()}` };
    }

    const run = await this._selectRun(requestedMode, force);
    if (!run) return { status: 'already_completed' };
    this.run_ = run;
    const log = (this.log = this.log.child({ runId: run.id, mode: run.mode }));
    this.client.log = log;

    const released = await this.store.releaseAllLeases();
    if (released) log.info('released stale leases from a previous process', { released });
    this.totalApps = await this.store.countApps();
    this.dispatched = run.processed;
    this.discovered = run.discovered;

    // Resume throttling state so a restart does not reset to full speed.
    this.throttle.restore(run.throttle_state);
    this.limiter.setMultiplier(this.throttle.multiplier);
    this.breaker.restore(run.breaker_state);

    log.info('crawl run starting', {
      resumed: run.processed > 0,
      processed: run.processed,
      budget: run.budget,
      concurrency: this.throttle.concurrency,
      multiplier: this.throttle.multiplier,
      breaker: this.breaker.state,
    });

    const deadline = setTimeout(() => this.stop('max_run_duration'), this.cfg.maxRunDurationMinutes * 60_000);
    deadline.unref();
    const checkpointTimer = setInterval(() => this._checkpoint().catch((err) => log.error('checkpoint failed', { err })), this.cfg.checkpointIntervalMs);
    checkpointTimer.unref();

    let final;
    try {
      await this.client.loadRobots(this.softStop.signal);
      await this._loop();
      final = this._finalStatus();
    } catch (err) {
      final = this._statusForError(err);
    } finally {
      clearTimeout(deadline);
      clearInterval(checkpointTimer);
    }

    await this._drain();
    await this.store.releaseLeases(run.id, this.buffer.map((i) => i.package_name)).catch(() => {});
    this.buffer = [];
    await this._checkpoint().catch((err) => log.error('final checkpoint failed', { err }));
    await this.store.finishRun(run.id, final.status, final.message ?? null);
    log.info('crawl run finished', { ...final, http: this.client.stats });
    return { ...final, runId: run.id };
  }

  async _selectRun(requestedMode, force) {
    // An unfinished full rescan takes precedence: it spans several days and
    // resumes exactly where it stopped.
    const full = await this.store.unfinishedFullRun();
    if (full) {
      this.log.info('resuming unfinished full rescan', { runId: full.id, processed: full.processed });
      return this.store.markRunRunning(full.id);
    }
    if (requestedMode === 'full') {
      const budget = Math.min(INT_MAX, Math.max(1, await this.store.countApps()) * 2);
      return this.store.createRun('full', budget);
    }

    const latest = await this.store.latestRun({ mode: 'incremental', today: true });
    if (latest && latest.status !== 'completed' && latest.status !== 'failed') {
      this.log.info('resuming today\'s incremental run', { runId: latest.id, processed: latest.processed, status: latest.status });
      return this.store.markRunRunning(latest.id);
    }
    if (latest && latest.status === 'completed' && !force) {
      this.log.info('today\'s incremental crawl already completed; use --force to run again', { runId: latest.id });
      return null;
    }
    return this.store.createRun('incremental', this.cfg.maxAppsPerRun);
  }

  _finalStatus() {
    switch (this.stopReason) {
      case null:
        return { status: 'completed' };
      case 'blocked':
        return { status: 'blocked', message: this.blockMessage };
      case 'breaker_exhausted':
        return { status: 'paused', message: 'circuit breaker tripped too often; will resume on next run' };
      case 'max_run_duration':
        return { status: 'paused', message: 'MAX_RUN_DURATION_MINUTES reached; will resume on next run' };
      case 'budget':
        return { status: 'completed', message: 'per-run budget reached' };
      default:
        return { status: 'interrupted', message: this.stopReason };
    }
  }

  _statusForError(err) {
    if (err instanceof BlockedError) {
      this._onBlocked(err);
      return { status: 'blocked', message: err.message };
    }
    if (this.softStop.signal.aborted) return this._finalStatus();
    this.log.error('crawl run failed', { err, stack: err?.stack });
    return { status: 'interrupted', message: `error: ${err?.message}` };
  }

  // ------------------------------------------------------------- worker pool
  async _loop() {
    const signal = this.softStop.signal;
    const budget = this.run_.budget;
    while (!signal.aborted) {
      if (this.breaker.exhausted) {
        this.stop('breaker_exhausted');
        break;
      }
      const cap = this.breaker.concurrencyCap(this.throttle.concurrency);
      let noWork = false;
      while (this.inflight.size < cap && !signal.aborted) {
        if (this.dispatched >= budget) {
          if (this.inflight.size === 0) this.stop('budget');
          break;
        }
        const item = await this._nextItem();
        if (!item) {
          noWork = true;
          break;
        }
        this.dispatched++;
        const p = this._process(item).finally(() => this.inflight.delete(item.package_name));
        this.inflight.set(item.package_name, p);
      }
      if (signal.aborted) break;
      if (noWork && this.inflight.size === 0) {
        // Nothing due and nothing in flight: the run is complete.
        return;
      }
      // Wake when a worker finishes, or every second to re-evaluate the cap.
      await Promise.race([...this.inflight.values(), this.sleep(1000).catch(() => {})]);
    }
  }

  async _nextItem() {
    if (this.buffer.length) return this.buffer.shift();
    // Avoid hammering the DB when the queue is empty but workers are still busy
    // (they may discover new apps).
    if (this.inflight.size > 0 && Date.now() - this.lastEmptyClaimAt < 5000) return null;
    const remaining = this.run_.budget - this.dispatched;
    const size = Math.max(1, Math.min(this.cfg.claimBatchSize, remaining));
    this.buffer = await this.store.claimBatch(this.run_, size);
    if (!this.buffer.length) {
      this.lastEmptyClaimAt = Date.now();
      return null;
    }
    return this.buffer.shift();
  }

  async _drain() {
    if (!this.inflight.size) return;
    this.log.info('waiting for in-flight requests', { inflight: this.inflight.size });
    const all = Promise.allSettled([...this.inflight.values()]);
    const timer = setTimeout(() => this.stop(this.stopReason ?? 'shutdown', { hard: true }), this.cfg.shutdownGraceMs);
    await all;
    clearTimeout(timer);
  }

  async _process(item) {
    const pkg = item.package_name;
    const url = detailsUrl(this.cfg.baseUrl, pkg, this.cfg.lang, this.cfg.country);
    const log = this.log;
    try {
      if (!this.client.isAllowed(url)) {
        await this.store.recordDisallowed(this.run_.id, item);
        return;
      }
      const res = await this.client.get(url, { signal: this.softStop.signal, fetchSignal: this.hardStop.signal });

      if (res.status === 404) {
        const { removed } = await this.store.recordNotFound(this.run_.id, item);
        log.debug('app not found', { pkg, removed });
        return;
      }
      if (res.status !== 200) {
        await this.store.recordFailure(this.run_.id, item, `HTTP ${res.status}`);
        log.warn('unexpected status', { pkg, status: res.status });
        return;
      }
      const app = parseAppPage(res.body, pkg);
      if (!app) {
        await this.store.recordFailure(this.run_.id, item, 'parse_error: no app data found');
        log.warn('could not parse app page', { pkg });
        return;
      }
      const { changed } = await this.store.recordSuccess(this.run_.id, item, app);
      log.debug('crawled app', { pkg, changed, attempts: res.attempts });
      await this._discover(res.body, pkg);
    } catch (err) {
      await this._handleItemError(item, err);
    }
  }

  async _handleItemError(item, err) {
    const pkg = item.package_name;
    if (err instanceof BlockedError) {
      // Never retry, never try to get around it: stop the whole crawl.
      this._onBlocked(err);
      await this.store.releaseLeases(this.run_.id, [pkg]).catch(() => {});
      return;
    }
    if (this.softStop.signal.aborted && !(err instanceof RetryExhaustedError)) {
      // Shutdown interrupted this item: leave it due so the next run picks it up.
      await this.store.releaseLeases(this.run_.id, [pkg]).catch(() => {});
      return;
    }
    if (err instanceof DisallowedError) {
      await this.store.recordDisallowed(this.run_.id, item).catch((e) => this.log.error('db error', { err: e }));
      return;
    }
    const message =
      err instanceof RetryExhaustedError || err instanceof ResponseTooLargeError ? err.message : `error: ${err?.message}`;
    this.log.warn('item failed', { pkg, err });
    try {
      await this.store.recordFailure(this.run_.id, item, message);
    } catch (dbErr) {
      // Can't persist results: stop rather than keep sending requests whose
      // outcome would be lost. Leases are reclaimed on the next start.
      this.log.error('database write failed; stopping crawl', { pkg, err: dbErr });
      await this.store.releaseLeases(this.run_.id, [pkg]).catch(() => {});
      this.stop('database_error');
    }
  }

  _onBlocked(err) {
    if (this.stopReason === 'blocked') return;
    const until = new Date(Date.now() + this.cfg.blockCooldownHours * 3_600_000);
    this.blockMessage = `${err.message}; cooling down until ${until.toISOString()}`;
    this.log.error('access blocked by server (CAPTCHA / anti-bot / 403). Stopping all requests.', {
      status: err.status,
      url: err.url,
      cooldownUntil: until,
    });
    this.store.setBlockedUntil(until, err.message).catch((e) => this.log.error('failed to persist block', { err: e }));
    this.stop('blocked', { hard: true });
  }

  async _discover(html, fromPkg) {
    if (!this.cfg.discoveryEnabled) return;
    const room = Math.min(this.cfg.maxDiscoveredPerRun - this.discovered, this.cfg.maxTotalApps - this.totalApps);
    if (room <= 0) return;
    const linked = extractLinkedPackages(html, fromPkg).slice(0, room);
    if (!linked.length) return;
    const added = await this.store.addApps(linked, { from: fromPkg, priority: 100 });
    if (added) {
      this.discovered += added;
      this.totalApps += added;
      await this.store.incrementDiscovered(this.run_.id, added);
      this.log.debug('discovered apps', { from: fromPkg, added });
    }
  }

  async _checkpoint() {
    if (!this.run_) return;
    await this.store.checkpointRun(this.run_.id, {
      throttle: this.throttle.snapshot(),
      breaker: this.breaker.snapshot(),
      http: { ...this.client.stats, breakerState: this.breaker.state === State.CLOSED ? 'closed' : this.breaker.state },
    });
  }
}
