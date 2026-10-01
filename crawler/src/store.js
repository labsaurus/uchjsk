// Data access layer. Every per-app result is written in a single transaction
// together with the run's progress counters, so the database is always an
// exact checkpoint of what has been done.


export class Store {
  constructor(pool, cfg) {
    this.pool = pool;
    this.cfg = cfg;
  }

  // ---------------------------------------------------------------- global state
  async getState(key) {
    const { rows } = await this.pool.query('SELECT value FROM crawler_state WHERE key = $1', [key]);
    return rows[0]?.value ?? null;
  }

  async setState(key, value) {
    await this.pool.query(
      `INSERT INTO crawler_state (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  async getBlockedUntil() {
    const v = await this.getState('blocked_until');
    return v?.until ? new Date(v.until) : null;
  }

  async setBlockedUntil(date, reason) {
    await this.setState('blocked_until', { until: date.toISOString(), reason });
  }

  // ---------------------------------------------------------------------- runs
  /** `today` uses the database's CURRENT_DATE, matching the run_date default. */
  async latestRun({ mode, today = false } = {}) {
    const conds = [];
    const params = [];
    if (mode) conds.push(`mode = $${params.push(mode)}`);
    if (today) conds.push('run_date = CURRENT_DATE');
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await this.pool.query(`SELECT * FROM crawl_runs ${where} ORDER BY id DESC LIMIT 1`, params);
    return rows[0] ?? null;
  }

  async unfinishedFullRun() {
    const { rows } = await this.pool.query(
      `SELECT * FROM crawl_runs WHERE mode = 'full' AND status NOT IN ('completed', 'failed')
       ORDER BY id DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  async createRun(mode, budget) {
    const { rows } = await this.pool.query(
      `INSERT INTO crawl_runs (mode, budget) VALUES ($1, $2) RETURNING *`,
      [mode, budget],
    );
    return rows[0];
  }

  async markRunRunning(id) {
    const { rows } = await this.pool.query(
      `UPDATE crawl_runs SET status = 'running', updated_at = now(), finished_at = NULL, message = NULL
       WHERE id = $1 RETURNING *`,
      [id],
    );
    return rows[0];
  }

  async checkpointRun(id, { throttle, breaker, http }) {
    await this.pool.query(
      `UPDATE crawl_runs SET throttle_state = $2, breaker_state = $3, http_stats = $4, updated_at = now()
       WHERE id = $1`,
      [id, JSON.stringify(throttle), JSON.stringify(breaker), JSON.stringify(http)],
    );
  }

  async finishRun(id, status, message = null) {
    const terminal = status === 'completed' || status === 'failed';
    await this.pool.query(
      `UPDATE crawl_runs SET status = $2, message = $3, updated_at = now(),
         finished_at = CASE WHEN $4 THEN now() ELSE finished_at END
       WHERE id = $1`,
      [id, status, message, terminal],
    );
  }

  // ---------------------------------------------------------------------- work
  /** Only one crawler instance can run (advisory lock), so every lease is stale at startup. */
  async releaseAllLeases() {
    const { rowCount } = await this.pool.query(
      'UPDATE apps SET lease_owner = NULL, lease_until = NULL WHERE lease_owner IS NOT NULL',
    );
    return rowCount;
  }

  async releaseLeases(runId, packages) {
    if (!packages.length) return;
    await this.pool.query(
      `UPDATE apps SET lease_owner = NULL, lease_until = NULL
       WHERE lease_owner = $1 AND package_name = ANY($2::text[])`,
      [runId, packages],
    );
  }

  /**
   * Claim the next batch of work.
   *  incremental: apps whose next_crawl_at is due (new apps first via priority).
   *  full:        every app not yet attempted since the full run started.
   */
  async claimBatch(run, limit) {
    const filter =
      run.mode === 'full'
        ? `(last_attempt_at IS NULL OR last_attempt_at < $3)`
        : `status NOT IN ('removed', 'disallowed') AND next_crawl_at <= now()`;
    const order = run.mode === 'full' ? 'priority DESC, package_name' : 'priority DESC, next_crawl_at';
    const params = [run.id, limit];
    if (run.mode === 'full') params.push(run.started_at);
    const { rows } = await this.pool.query(
      `WITH c AS (
         SELECT package_name FROM apps
         WHERE lease_owner IS NULL AND ${filter}
         ORDER BY ${order}
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE apps a SET lease_owner = $1, lease_until = now() + make_interval(secs => ${Math.round(this.cfg.leaseMs / 1000)})
       FROM c WHERE a.package_name = c.package_name
       RETURNING a.package_name, a.status, a.priority, a.content_hash, a.recrawl_hours,
                 a.next_crawl_at, a.consecutive_failures, a.not_found_strikes`,
      params,
    );
    rows.sort((x, y) => y.priority - x.priority || (x.next_crawl_at < y.next_crawl_at ? -1 : 1));
    return rows;
  }

  async _withRunTx(runId, packageName, counters, fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query(
        `UPDATE crawl_runs SET processed = processed + 1,
           succeeded = succeeded + $3, not_found = not_found + $4, failed = failed + $5, changed = changed + $6,
           last_package = $2, updated_at = now()
         WHERE id = $1`,
        [runId, packageName, counters.succeeded ?? 0, counters.notFound ?? 0, counters.failed ?? 0, result?.changed ? 1 : 0],
      );
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Persist a successful crawl. Returns { changed }. */
  recordSuccess(runId, item, app) {
    const changed = item.content_hash !== app.contentHash;
    const { minRecrawlHours: min, maxRecrawlHours: max } = this.cfg;
    // Apps that change get revisited daily; stable apps back off gradually.
    const prev = item.recrawl_hours ?? min;
    const recrawlHours = changed ? min : Math.min(max, Math.max(min, prev * 1.5));
    return this._withRunTx(runId, item.package_name, { succeeded: 1 }, async (c) => {
      await c.query(
        `UPDATE apps SET
           status = 'active', priority = 0, lease_owner = NULL, lease_until = NULL,
           last_attempt_at = now(), last_success_at = now(),
           last_changed_at = CASE WHEN $2 THEN now() ELSE last_changed_at END,
           recrawl_hours = $3::real,
           next_crawl_at = now() + make_interval(secs => $3::real * 3600 * (0.9 + random() * 0.2)),
           consecutive_failures = 0, not_found_strikes = 0, last_error = NULL,
           content_hash = $4, title = $5, developer = $6, developer_url = $7, description = $8,
           icon_url = $9, category = $10, content_rating = $11, rating = $12, rating_count = $13,
           price = $14, currency = $15, installs = $16, min_installs = $17, version = $18,
           store_updated_at = $19, released_at = $20, contains_ads = $21
         WHERE package_name = $1`,
        [
          item.package_name, changed, recrawlHours, app.contentHash, app.title, app.developer, app.developerUrl,
          app.description, app.iconUrl, app.category, app.contentRating, app.rating, app.ratingCount,
          app.price, app.currency, app.installs, app.minInstalls, app.version, app.updatedAt, app.releasedAt,
          app.containsAds,
        ],
      );
      if (changed) {
        await c.query(
          `INSERT INTO app_snapshots (package_name, content_hash, rating, rating_count, installs, min_installs,
             price, currency, version, store_updated_at, data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            item.package_name, app.contentHash, app.rating, app.ratingCount, app.installs, app.minInstalls,
            app.price, app.currency, app.version, app.updatedAt, JSON.stringify(app),
          ],
        );
      }
      return { changed };
    });
  }

  recordNotFound(runId, item) {
    const strikes = item.not_found_strikes + 1;
    const removed = strikes >= this.cfg.notFoundMaxStrikes;
    return this._withRunTx(runId, item.package_name, { notFound: 1 }, async (c) => {
      await c.query(
        `UPDATE apps SET status = $2, not_found_strikes = $3, lease_owner = NULL, lease_until = NULL,
           last_attempt_at = now(), last_error = 'HTTP 404', priority = 0,
           next_crawl_at = now() + make_interval(secs => $4 * 3600)
         WHERE package_name = $1`,
        [item.package_name, removed ? 'removed' : 'not_found', strikes, this.cfg.notFoundRecrawlHours],
      );
      return { removed };
    });
  }

  recordFailure(runId, item, message) {
    const failures = item.consecutive_failures + 1;
    // Exponential per-app backoff: 6h, 12h, 24h, ... capped at MAX_RECRAWL_HOURS.
    const hours = Math.min(this.cfg.maxRecrawlHours, this.cfg.failedRecrawlHours * 2 ** Math.min(failures - 1, 10));
    return this._withRunTx(runId, item.package_name, { failed: 1 }, async (c) => {
      await c.query(
        `UPDATE apps SET consecutive_failures = $2, last_error = $3, lease_owner = NULL, lease_until = NULL,
           status = CASE WHEN last_success_at IS NULL THEN 'failed' ELSE status END,
           last_attempt_at = now(), next_crawl_at = now() + make_interval(secs => $4 * 3600)
         WHERE package_name = $1`,
        [item.package_name, failures, String(message).slice(0, 1000), hours],
      );
    });
  }

  recordDisallowed(runId, item) {
    return this._withRunTx(runId, item.package_name, {}, async (c) => {
      await c.query(
        `UPDATE apps SET status = 'disallowed', lease_owner = NULL, lease_until = NULL, last_attempt_at = now(),
           last_error = 'disallowed by robots.txt', next_crawl_at = now() + make_interval(secs => $2 * 3600)
         WHERE package_name = $1`,
        [item.package_name, this.cfg.maxRecrawlHours],
      );
    });
  }

  /** Insert newly discovered packages. Returns how many were actually new. */
  async addApps(packages, { from = null, priority = 100 } = {}) {
    if (!packages.length) return 0;
    const { rowCount } = await this.pool.query(
      `INSERT INTO apps (package_name, priority, discovered_from)
       SELECT unnest($1::text[]), $2, $3
       ON CONFLICT (package_name) DO NOTHING`,
      [packages, priority, from],
    );
    return rowCount;
  }

  async incrementDiscovered(runId, n) {
    if (n > 0) await this.pool.query('UPDATE crawl_runs SET discovered = discovered + $2 WHERE id = $1', [runId, n]);
  }

  async countApps() {
    const { rows } = await this.pool.query('SELECT count(*)::bigint AS n FROM apps');
    return Number(rows[0].n);
  }

  async summary() {
    const [byStatus, due, runs] = await Promise.all([
      this.pool.query('SELECT status, count(*)::int AS n FROM apps GROUP BY status ORDER BY status'),
      this.pool.query(
        `SELECT count(*)::int AS n FROM apps WHERE status NOT IN ('removed','disallowed') AND next_crawl_at <= now()`,
      ),
      this.pool.query(
        `SELECT id, run_date, mode, status, started_at, updated_at, finished_at, budget, processed, succeeded,
                not_found, failed, changed, discovered, last_package, message
         FROM crawl_runs ORDER BY id DESC LIMIT 10`,
      ),
    ]);
    return {
      apps: Object.fromEntries(byStatus.rows.map((r) => [r.status, r.n])),
      dueNow: due.rows[0].n,
      blockedUntil: await this.getBlockedUntil(),
      recentRuns: runs.rows,
    };
  }

  /** Make every app due now (used by `full-reset`, an alternative to a full run). */
  async markAllDue() {
    const { rowCount } = await this.pool.query(
      `UPDATE apps SET next_crawl_at = now() WHERE status NOT IN ('removed')`,
    );
    return rowCount;
  }
}

