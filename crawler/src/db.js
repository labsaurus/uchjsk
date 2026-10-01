import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
// Arbitrary constant used for the single-instance advisory lock.
export const CRAWLER_LOCK_KEY = 815_337_001;

export function createPool(cfg) {
  const pool = new pg.Pool({
    connectionString: cfg.databaseUrl,
    max: cfg.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'playstore-crawler',
  });
  pool.on('error', () => {}); // idle client errors are surfaced on next query
  return pool;
}

export async function migrate(pool, log) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [CRAWLER_LOCK_KEY + 1]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        log?.info('applied migration', { migration: f });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [CRAWLER_LOCK_KEY + 1]).catch(() => {});
    client.release();
  }
}

/**
 * Hold a session-level advisory lock on a dedicated connection for the life of
 * the crawl, guaranteeing a single crawler instance per database.
 */
export async function acquireInstanceLock(pool) {
  const client = await pool.connect();
  const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [CRAWLER_LOCK_KEY]);
  if (!rows[0].ok) {
    client.release();
    return null;
  }
  return async () => {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [CRAWLER_LOCK_KEY]);
    } finally {
      client.release();
    }
  };
}
