// Central configuration. Every tunable is read from environment variables so
// limits can be changed without touching source code. Values are validated and
// clamped to sane ranges so a typo cannot turn the crawler into a flood.

import fs from 'node:fs';
import path from 'node:path';

/** Minimal .env loader (no dependency). Real env vars always win. */
export function loadDotEnv(file = path.resolve(process.cwd(), '.env')) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function num(env, name, def, { min = -Infinity, max = Infinity, int = false } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`Config ${name} must be a number, got "${raw}"`);
  if (int && !Number.isInteger(v)) throw new Error(`Config ${name} must be an integer, got "${raw}"`);
  if (v < min || v > max) throw new Error(`Config ${name}=${v} out of range [${min}, ${max}]`);
  return v;
}

function bool(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  return /^(1|true|yes|on)$/i.test(raw);
}

function str(env, name, def) {
  const raw = env[name];
  return raw === undefined || raw === '' ? def : raw;
}

export function buildConfig(env = process.env) {
  const cfg = {
    databaseUrl: str(env, 'DATABASE_URL', 'postgres://crawler:crawler@localhost:5432/playstore'),
    dbPoolMax: num(env, 'DB_POOL_MAX', 4, { min: 1, max: 20, int: true }),

    baseUrl: str(env, 'PLAY_BASE_URL', 'https://play.google.com'),
    lang: str(env, 'PLAY_LANG', 'en'),
    country: str(env, 'PLAY_COUNTRY', 'us'),
    userAgent: str(
      env,
      'USER_AGENT',
      'PlayStoreResearchCrawler/1.0 (+contact: set USER_AGENT in .env)',
    ),
    robotsUserAgentToken: str(env, 'ROBOTS_USER_AGENT_TOKEN', 'PlayStoreResearchCrawler'),

    // --- concurrency ---------------------------------------------------------
    concurrency: num(env, 'CONCURRENCY', 5, { min: 1, max: 50, int: true }),
    minConcurrency: num(env, 'MIN_CONCURRENCY', 1, { min: 1, max: 50, int: true }),
    maxConcurrency: num(env, 'MAX_CONCURRENCY', 8, { min: 1, max: 50, int: true }),

    // --- global rate limiter -------------------------------------------------
    maxRequestsPerMinute: num(env, 'MAX_REQUESTS_PER_MINUTE', 30, { min: 1, max: 600 }),
    minRequestIntervalMs: num(env, 'MIN_REQUEST_INTERVAL_MS', 1500, { min: 0, max: 600_000 }),
    requestJitterMs: num(env, 'REQUEST_JITTER_MS', 750, { min: 0, max: 60_000 }),
    maxSlowdownMultiplier: num(env, 'MAX_SLOWDOWN_MULTIPLIER', 16, { min: 1, max: 1000 }),

    // --- HTTP / retries ------------------------------------------------------
    requestTimeoutMs: num(env, 'REQUEST_TIMEOUT_MS', 20_000, { min: 1000, max: 120_000 }),
    maxResponseBytes: num(env, 'MAX_RESPONSE_BYTES', 4 * 1024 * 1024, { min: 64 * 1024, max: 32 * 1024 * 1024 }),
    maxRetries: num(env, 'MAX_RETRIES', 4, { min: 0, max: 10, int: true }),
    backoffBaseMs: num(env, 'BACKOFF_BASE_MS', 2000, { min: 100, max: 60_000 }),
    backoffMaxMs: num(env, 'BACKOFF_MAX_MS', 120_000, { min: 1000, max: 3_600_000 }),
    retryAfterMaxMs: num(env, 'RETRY_AFTER_MAX_MS', 600_000, { min: 1000, max: 86_400_000 }),

    // --- adaptive throttling -------------------------------------------------
    adaptiveWindowSize: num(env, 'ADAPTIVE_WINDOW_SIZE', 50, { min: 5, max: 1000, int: true }),
    adaptiveErrorRateThreshold: num(env, 'ADAPTIVE_ERROR_RATE_THRESHOLD', 0.1, { min: 0, max: 1 }),
    adaptiveStableErrorRate: num(env, 'ADAPTIVE_STABLE_ERROR_RATE', 0.02, { min: 0, max: 1 }),
    adaptiveIncreaseIntervalMs: num(env, 'ADAPTIVE_INCREASE_INTERVAL_MS', 120_000, { min: 1000, max: 86_400_000 }),
    adaptiveDecreaseCooldownMs: num(env, 'ADAPTIVE_DECREASE_COOLDOWN_MS', 10_000, { min: 0, max: 3_600_000 }),

    // --- circuit breaker -----------------------------------------------------
    breakerWindowSize: num(env, 'BREAKER_WINDOW_SIZE', 30, { min: 5, max: 1000, int: true }),
    breakerMinSamples: num(env, 'BREAKER_MIN_SAMPLES', 10, { min: 1, max: 1000, int: true }),
    breakerFailureThreshold: num(env, 'BREAKER_FAILURE_THRESHOLD', 0.5, { min: 0.05, max: 1 }),
    breakerCooldownMs: num(env, 'BREAKER_COOLDOWN_MS', 300_000, { min: 1000, max: 86_400_000 }),
    breakerMaxCooldownMs: num(env, 'BREAKER_MAX_COOLDOWN_MS', 3_600_000, { min: 1000, max: 86_400_000 }),
    breakerHalfOpenSuccesses: num(env, 'BREAKER_HALF_OPEN_SUCCESSES', 3, { min: 1, max: 100, int: true }),
    breakerMaxTripsPerRun: num(env, 'BREAKER_MAX_TRIPS_PER_RUN', 5, { min: 1, max: 100, int: true }),

    // --- hard block (CAPTCHA / "unusual traffic" / 403) ----------------------
    blockCooldownHours: num(env, 'BLOCK_COOLDOWN_HOURS', 24, { min: 1, max: 24 * 30 }),

    // --- scheduling ----------------------------------------------------------
    maxAppsPerRun: num(env, 'MAX_APPS_PER_RUN', 5000, { min: 1, max: 10_000_000, int: true }),
    claimBatchSize: num(env, 'CLAIM_BATCH_SIZE', 25, { min: 1, max: 1000, int: true }),
    leaseMs: num(env, 'LEASE_MS', 15 * 60_000, { min: 60_000, max: 86_400_000 }),
    minRecrawlHours: num(env, 'MIN_RECRAWL_HOURS', 24, { min: 1, max: 24 * 365 }),
    maxRecrawlHours: num(env, 'MAX_RECRAWL_HOURS', 24 * 14, { min: 1, max: 24 * 365 }),
    notFoundRecrawlHours: num(env, 'NOT_FOUND_RECRAWL_HOURS', 24 * 30, { min: 1, max: 24 * 365 }),
    notFoundMaxStrikes: num(env, 'NOT_FOUND_MAX_STRIKES', 3, { min: 1, max: 100, int: true }),
    failedRecrawlHours: num(env, 'FAILED_RECRAWL_HOURS', 6, { min: 1, max: 24 * 30 }),
    maxRunDurationMinutes: num(env, 'MAX_RUN_DURATION_MINUTES', 20 * 60, { min: 1, max: 7 * 24 * 60 }),

    // --- discovery -----------------------------------------------------------
    discoveryEnabled: bool(env, 'DISCOVERY_ENABLED', true),
    maxDiscoveredPerRun: num(env, 'MAX_DISCOVERED_PER_RUN', 2000, { min: 0, max: 10_000_000, int: true }),
    maxTotalApps: num(env, 'MAX_TOTAL_APPS', 200_000, { min: 1, max: 100_000_000, int: true }),

    // --- process -------------------------------------------------------------
    shutdownGraceMs: num(env, 'SHUTDOWN_GRACE_MS', 30_000, { min: 1000, max: 600_000 }),
    checkpointIntervalMs: num(env, 'CHECKPOINT_INTERVAL_MS', 15_000, { min: 1000, max: 600_000 }),
    logLevel: str(env, 'LOG_LEVEL', 'info'),
  };

  if (cfg.minConcurrency > cfg.maxConcurrency) {
    throw new Error('MIN_CONCURRENCY must be <= MAX_CONCURRENCY');
  }
  cfg.concurrency = Math.min(Math.max(cfg.concurrency, cfg.minConcurrency), cfg.maxConcurrency);
  if (cfg.minRecrawlHours > cfg.maxRecrawlHours) {
    throw new Error('MIN_RECRAWL_HOURS must be <= MAX_RECRAWL_HOURS');
  }
  if (cfg.breakerMinSamples > cfg.breakerWindowSize) {
    throw new Error('BREAKER_MIN_SAMPLES must be <= BREAKER_WINDOW_SIZE');
  }
  if (cfg.backoffBaseMs > cfg.backoffMaxMs) {
    throw new Error('BACKOFF_BASE_MS must be <= BACKOFF_MAX_MS');
  }
  return Object.freeze(cfg);
}
