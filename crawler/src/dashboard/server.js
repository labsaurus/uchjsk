// Minimal read-only web dashboard (node:http, no framework).
// Binds to 127.0.0.1 by default; set DASHBOARD_USER/DASHBOARD_PASSWORD to
// require HTTP Basic auth if you expose it (preferably behind a TLS proxy).

import http from 'node:http';
import crypto from 'node:crypto';
import { overview, listApps, appDetail, allCategories, SORT_KEYS } from './queries.js';
import { layout, homePage, runsPage, appPage, notFoundPage } from './views.js';
import { isValidPackageName } from '../parser.js';

const STATUSES = new Set(['active', 'new', 'not_found', 'failed', 'removed', 'disallowed']);

export function createDashboard({ cfg, pool, log }) {
  const auth = cfg.dashboardUser && cfg.dashboardPassword
    ? Buffer.from(`${cfg.dashboardUser}:${cfg.dashboardPassword}`).toString('base64')
    : null;

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      if (auth && !checkAuth(req.headers.authorization, auth)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Play Crawler", charset="UTF-8"' });
        return res.end('Authentication required');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        return res.end();
      }
      const url = new URL(req.url, 'http://localhost');
      const render = async () => {
        if (url.pathname === '/healthz') return { type: 'text/plain', body: 'ok' };
        if (url.pathname === '/api/summary') return { type: 'application/json', body: JSON.stringify(await overview(pool)) };
        const ov = await overview(pool);
        const page = (title, body, status = 200) => ({
          status,
          body: layout({ title, body, source: cfg.baseUrl, blockedUntil: ov.blockedUntil }),
        });
        if (url.pathname === '/') {
          const filters = parseFilters(url.searchParams);
          const [list, categories] = await Promise.all([listApps(pool, filters), allCategories(pool)]);
          return page('Apps', homePage({ ov, list, filters, categories }));
        }
        if (url.pathname === '/runs') {
          const { rows } = await pool.query(
            `SELECT id, run_date, mode, status, started_at, finished_at, updated_at, budget, processed, succeeded,
                    not_found, failed, changed, discovered, message, http_stats
             FROM crawl_runs ORDER BY id DESC LIMIT 100`,
          );
          return page('Runs', runsPage({ runs: rows }));
        }
        const m = url.pathname.match(/^\/app\/([^/]+)$/);
        if (m) {
          const pkg = decodeURIComponent(m[1]);
          const detail = isValidPackageName(pkg) ? await appDetail(pool, pkg) : null;
          return detail ? page(detail.app.title ?? pkg, appPage(detail)) : page('Not found', notFoundPage(), 404);
        }
        return page('Not found', notFoundPage(), 404);
      };
      const out = await render();
      res.writeHead(out.status ?? 200, {
        'Content-Type': `${out.type ?? 'text/html'}; charset=utf-8`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; img-src https://play-lh.googleusercontent.com data:; script-src 'unsafe-hashes' 'sha256-" +
          crypto.createHash('sha256').update('this.remove()').digest('base64') + "'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
      res.end(req.method === 'HEAD' ? undefined : out.body);
      log.debug('dashboard request', { path: url.pathname, ms: Date.now() - started });
    } catch (err) {
      log.error('dashboard error', { err, path: req.url });
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal error');
    }
  });
  return server;
}

function parseFilters(sp) {
  const page = Number.parseInt(sp.get('page') ?? '1', 10);
  const sort = sp.get('sort');
  const status = sp.get('status') ?? '';
  return {
    q: (sp.get('q') ?? '').trim().slice(0, 100),
    status: STATUSES.has(status) ? status : '',
    category: (sp.get('category') ?? '').slice(0, 100),
    sort: SORT_KEYS.includes(sort) ? sort : 'ratings',
    page: Number.isFinite(page) && page > 0 ? Math.min(page, 100_000) : 1,
  };
}

function checkAuth(header, expected) {
  const m = /^Basic\s+(.+)$/i.exec(header ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
