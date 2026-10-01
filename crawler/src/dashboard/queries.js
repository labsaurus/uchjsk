// Read-only queries for the dashboard. Sort columns are whitelisted; all
// user input goes through bind parameters.

const SORTS = {
  title: 'title ASC NULLS LAST',
  rating: 'rating DESC NULLS LAST',
  ratings: 'rating_count DESC NULLS LAST',
  installs: 'min_installs DESC NULLS LAST',
  updated: 'store_updated_at DESC NULLS LAST',
  crawled: 'last_attempt_at DESC NULLS LAST',
  discovered: 'discovered_at DESC',
};
export const SORT_KEYS = Object.keys(SORTS);
export const PAGE_SIZE = 25;

export async function overview(pool) {
  const [totals, byStatus, categories, runs, snaps, blocked] = await Promise.all([
    pool.query(`SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE status NOT IN ('removed','disallowed') AND next_crawl_at <= now())::int AS due,
                  count(*) FILTER (WHERE discovered_at > now() - interval '24 hours')::int AS new24h,
                  count(*) FILTER (WHERE last_changed_at > now() - interval '24 hours')::int AS changed24h,
                  round(avg(rating)::numeric, 2)::float AS avg_rating
                FROM apps`),
    pool.query('SELECT status, count(*)::int AS n FROM apps GROUP BY status ORDER BY n DESC'),
    pool.query(`SELECT category, count(*)::int AS n FROM apps WHERE category IS NOT NULL
                GROUP BY category ORDER BY n DESC, category LIMIT 12`),
    pool.query(`SELECT id, run_date, mode, status, started_at, finished_at, updated_at, budget, processed, succeeded,
                       not_found, failed, changed, discovered, message, http_stats
                FROM crawl_runs ORDER BY id DESC LIMIT 8`),
    pool.query('SELECT count(*)::int AS n FROM app_snapshots'),
    pool.query(`SELECT value FROM crawler_state WHERE key = 'blocked_until'`),
  ]);
  const until = blocked.rows[0]?.value?.until;
  return {
    ...totals.rows[0],
    snapshots: snaps.rows[0].n,
    byStatus: byStatus.rows,
    categories: categories.rows,
    runs: runs.rows,
    blockedUntil: until && new Date(until) > new Date() ? new Date(until) : null,
  };
}

export async function listApps(pool, { q = '', status = '', category = '', sort = 'ratings', page = 1 }) {
  const where = [];
  const params = [];
  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(title ILIKE $${params.length} OR package_name ILIKE $${params.length} OR developer ILIKE $${params.length})`);
  }
  if (status) where.push(`status = $${params.push(status)}`);
  if (category) where.push(`category = $${params.push(category)}`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order = SORTS[sort] ?? SORTS.ratings;
  const offset = (Math.max(1, page) - 1) * PAGE_SIZE;
  const [rows, count] = await Promise.all([
    pool.query(
      `SELECT package_name, status, title, developer, icon_url, category, rating, rating_count, installs,
              price, currency, version, store_updated_at, last_attempt_at, last_changed_at
       FROM apps ${w} ORDER BY ${order}, package_name LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
      params,
    ),
    pool.query(`SELECT count(*)::int AS n FROM apps ${w}`, params),
  ]);
  return { rows: rows.rows, total: count.rows[0].n };
}

export async function appDetail(pool, pkg) {
  const [app, snaps] = await Promise.all([
    pool.query('SELECT * FROM apps WHERE package_name = $1', [pkg]),
    pool.query(
      `SELECT captured_at, rating, rating_count, installs, version, price, currency
       FROM app_snapshots WHERE package_name = $1 ORDER BY captured_at ASC LIMIT 500`,
      [pkg],
    ),
  ]);
  if (!app.rows[0]) return null;
  return { app: app.rows[0], snapshots: snaps.rows };
}

export async function allCategories(pool) {
  const { rows } = await pool.query('SELECT DISTINCT category FROM apps WHERE category IS NOT NULL ORDER BY 1');
  return rows.map((r) => r.category);
}
