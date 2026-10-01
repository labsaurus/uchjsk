// Polite HTTP client. Every single attempt (including retries) goes through:
//   robots.txt check -> circuit breaker -> global rate limiter -> fetch
// and its outcome is fed back to the adaptive throttle and circuit breaker.

import { sleep } from '../lib/sleep.js';
import { RETRYABLE_STATUSES, parseRetryAfter, retryDelay } from './backoff.js';
import { Outcome, classifyStatus } from './outcomes.js';
import { BlockedError, DisallowedError, ResponseTooLargeError, RetryExhaustedError } from './errors.js';
import { RobotsPolicy } from '../robots.js';

// Markers of an anti-bot interstitial. We detect these only to STOP; we never
// try to solve or evade them.
const BLOCK_URL_RE = /\/sorry\/|\/recaptcha\//i;
const BLOCK_BODY_RE = /unusual traffic from your computer network|g-recaptcha|id="captcha-form"/i;

export class HttpClient {
  constructor({ cfg, limiter, breaker, throttle, logger, fetchImpl = globalThis.fetch, sleepFn = sleep }) {
    this.cfg = cfg;
    this.limiter = limiter;
    this.breaker = breaker;
    this.throttle = throttle;
    this.log = logger;
    this.fetch = fetchImpl;
    this.sleep = sleepFn;
    this.robots = null;
    this.stats = { requests: 0, retries: 0, status: {} };
  }

  async loadRobots(signal) {
    const url = new URL('/robots.txt', this.cfg.baseUrl).toString();
    try {
      const res = await this.get(url, { signal, skipRobots: true });
      if (res.status >= 200 && res.status < 300) {
        this.robots = RobotsPolicy.parse(res.body, this.cfg.robotsUserAgentToken);
      } else if (res.status >= 400 && res.status < 500) {
        this.robots = RobotsPolicy.allowAll(); // RFC 9309: unavailable -> allowed
      } else {
        this.robots = RobotsPolicy.disallowAll();
      }
    } catch (err) {
      if (err instanceof BlockedError || signal?.aborted) throw err;
      // RFC 9309: unreachable -> assume complete disallow.
      this.log.warn('robots.txt unreachable; treating as disallow-all', { err });
      this.robots = RobotsPolicy.disallowAll();
    }
    if (this.robots.crawlDelayMs) {
      this.limiter.enforceMinInterval(this.robots.crawlDelayMs);
      this.log.info('honouring robots.txt Crawl-delay', { crawlDelayMs: this.robots.crawlDelayMs });
    }
    return this.robots;
  }

  isAllowed(url) {
    if (!this.robots) throw new Error('robots.txt not loaded');
    const u = new URL(url);
    return this.robots.isAllowed(u.pathname + u.search);
  }

  /**
   * GET a URL politely. Resolves with { status, body, finalUrl, attempts } for
   * any final status (including 404). Throws BlockedError, DisallowedError,
   * RetryExhaustedError, or an AbortError on shutdown.
   *
   * `signal` aborts waiting (breaker, rate limiter, backoff); `fetchSignal`
   * (defaults to `signal`) aborts a request already on the wire. Splitting them
   * lets a graceful shutdown finish in-flight requests.
   */
  async get(url, { signal, fetchSignal, skipRobots = false } = {}) {
    if (!skipRobots && !this.isAllowed(url)) {
      throw new DisallowedError(`robots.txt disallows ${url}`, { url });
    }
    const { maxRetries } = this.cfg;
    let lastErr = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const done = await this.breaker.acquire(signal);
      let outcome = null;
      let res;
      try {
        await this.limiter.acquire(signal);
        if (this.breaker.state === 'open') {
          // Circuit opened while we were queued in the rate limiter: don't send.
          done(null);
          attempt--;
          continue;
        }
        this.stats.requests++;
        res = await this._fetchOnce(url, fetchSignal ?? signal);
      } catch (err) {
        if (signal?.aborted || fetchSignal?.aborted) {
          done(null);
          throw err;
        }
        if (err instanceof ResponseTooLargeError) {
          done(Outcome.OK);
          throw err;
        }
        outcome = Outcome.NETWORK;
        done(outcome);
        this.throttle.record(outcome);
        lastErr = err;
        this.log.debug('network error', { url, attempt, err });
        if (attempt < maxRetries) {
          await this._backoff(attempt, null, signal);
          continue;
        }
        break;
      }

      this.stats.status[res.status] = (this.stats.status[res.status] ?? 0) + 1;

      if (this._looksBlocked(res)) {
        done(null);
        throw new BlockedError(`anti-bot challenge or access denial (HTTP ${res.status}) at ${url}`, {
          status: res.status,
          url,
        });
      }

      outcome = classifyStatus(res.status);
      done(outcome);
      this.throttle.record(outcome);

      if (!RETRYABLE_STATUSES.has(res.status)) {
        return { ...res, attempts: attempt + 1 };
      }

      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      if (retryAfterMs != null && res.status === 429) {
        // Server told us to back off: apply it globally, not just to this worker.
        this.limiter.pauseFor(Math.min(retryAfterMs, this.cfg.retryAfterMaxMs));
      }
      lastErr = new RetryExhaustedError(`HTTP ${res.status} for ${url}`, { status: res.status, url });
      if (attempt >= maxRetries) break;
      const ok = await this._backoff(attempt, retryAfterMs, signal);
      if (!ok) {
        throw new RetryExhaustedError(`Retry-After (${retryAfterMs}ms) exceeds RETRY_AFTER_MAX_MS for ${url}`, {
          status: res.status,
          url,
          retryAfterMs,
        });
      }
    }
    if (lastErr instanceof RetryExhaustedError) throw lastErr;
    throw new RetryExhaustedError(`network failure after ${maxRetries + 1} attempts for ${url}: ${lastErr?.message}`, {
      url,
      cause: lastErr,
    });
  }

  async _backoff(attempt, retryAfterMs, signal) {
    const delay = retryDelay(attempt, retryAfterMs, {
      baseMs: this.cfg.backoffBaseMs,
      maxMs: this.cfg.backoffMaxMs,
      retryAfterMaxMs: this.cfg.retryAfterMaxMs,
    });
    if (delay == null) return false;
    this.stats.retries++;
    this.log.debug('backing off', { attempt, delayMs: delay, retryAfterMs });
    await this.sleep(delay, signal);
    return true;
  }

  _looksBlocked(res) {
    if (BLOCK_URL_RE.test(res.finalUrl)) return true;
    if (res.status === 403) return true;
    if ((res.status === 429 || res.status === 200 || res.status === 503) && BLOCK_BODY_RE.test(res.body.slice(0, 20_000))) {
      return true;
    }
    return false;
  }

  async _fetchOnce(url, signal) {
    const timeout = AbortSignal.timeout(this.cfg.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await this.fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: combined,
      headers: {
        'User-Agent': this.cfg.userAgent,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        'Accept-Language': `${this.cfg.lang},en;q=0.8`,
      },
    });
    const body = await readCapped(response, this.cfg.maxResponseBytes, url);
    return { status: response.status, headers: response.headers, body, finalUrl: response.url || url };
  }
}

async function readCapped(response, maxBytes, url) {
  if (!response.body) return '';
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel().catch(() => {});
    throw new ResponseTooLargeError(`response too large (${declared} bytes) for ${url}`, { url });
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError(`response exceeded ${maxBytes} bytes for ${url}`, { url });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}
