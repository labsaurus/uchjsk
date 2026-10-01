// Server-rendered HTML for the dashboard. No client framework; every dynamic
// value goes through esc().

import { PAGE_SIZE, SORT_KEYS } from './queries.js';

export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const nf = new Intl.NumberFormat('en-US');
const fmtNum = (n) => (n == null ? '—' : nf.format(n));
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const fmtCompact = (n) => (n == null ? '—' : compact.format(n));

function fmtDate(d, withTime = true) {
  if (!d) return '—';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return esc(d);
  return date.toLocaleString('en-GB', {
    year: 'numeric', month: 'short', day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
    timeZone: 'UTC',
  }) + (withTime ? ' UTC' : '');
}

function relTime(d) {
  if (!d) return '—';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  const abs = Math.abs(s);
  const [v, u] = abs < 60 ? [abs, 's'] : abs < 3600 ? [Math.round(abs / 60), 'm'] : abs < 86400 ? [Math.round(abs / 3600), 'h'] : [Math.round(abs / 86400), 'd'];
  return s >= 0 ? `${v}${u} ago` : `in ${v}${u}`;
}

function duration(a, b) {
  if (!a) return '—';
  const ms = new Date(b ?? Date.now()) - new Date(a);
  const m = Math.floor(ms / 60000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const STATUS_TONE = {
  active: 'good', completed: 'good', new: 'info', running: 'info',
  not_found: 'warn', paused: 'warn', interrupted: 'warn', failed: 'bad',
  removed: 'muted', disallowed: 'muted', blocked: 'bad',
};
const badge = (s) => `<span class="badge ${STATUS_TONE[s] ?? 'muted'}">${esc(String(s).replace('_', ' '))}</span>`;

function stars(r) {
  if (r == null) return '<span class="dim">—</span>';
  return `<span class="rating"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L10 14.9l-5.2 2.7 1-5.8L1.5 7.7l5.9-.8z"/></svg>${Number(r).toFixed(1)}</span>`;
}

function icon(app, size = 40) {
  const letter = esc((app.title || app.package_name || '?').trim()[0]?.toUpperCase());
  const hue = [...(app.package_name || '')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const fallback = `<span class="icon fallback" style="--s:${size}px;--h:${hue}">${letter}</span>`;
  if (!app.icon_url || !/^https:\/\//.test(app.icon_url)) return fallback;
  return `<span class="icon-wrap" style="--s:${size}px">${fallback}<img class="icon" src="${esc(app.icon_url)}=w${size * 2}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"></span>`;
}

function qs(base, params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...params })) if (v !== '' && v != null && !(k === 'page' && v === 1)) u.set(k, v);
  const s = u.toString();
  return s ? `/?${s}` : '/';
}

// ------------------------------------------------------------------ layout
export function layout({ title, body, source, blockedUntil }) {
  const demo = source && !/^https:\/\/play\.google\.com\/?$/.test(source);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)} · Play Crawler</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <div class="wrap top-inner">
    <a class="brand" href="/">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3.5v17l9-8.5z" opacity=".9"/><path d="M13 12l3-2.8L5.2 3.1z" opacity=".65"/><path d="M13 12l3 2.8L5.2 20.9z" opacity=".75"/><path d="M16 9.2L20 11.5c.7.4.7 1.3 0 1.7L16 14.8 13 12z"/></svg>
      Play Crawler
    </a>
    <nav><a href="/">Apps</a><a href="/runs">Runs</a></nav>
  </div>
</header>
${demo ? `<div class="notice demo"><div class="wrap"><strong>Test data.</strong> This database was filled from <code>${esc(source)}</code>, not from Google Play.</div></div>` : ''}
${blockedUntil ? `<div class="notice bad"><div class="wrap"><strong>Crawling paused:</strong> the server returned an anti-bot / access-denied response. No requests until ${fmtDate(blockedUntil)}.</div></div>` : ''}
<main class="wrap">${body}</main>
<footer class="wrap foot">Read-only dashboard · data from PostgreSQL · times in UTC</footer>
</body>
</html>`;
}

// ------------------------------------------------------------------ pages
export function homePage({ ov, list, filters, categories }) {
  const statusCount = Object.fromEntries(ov.byStatus.map((s) => [s.status, s.n]));
  const last = ov.runs[0];
  const cards = [
    ['Known apps', fmtNum(ov.total), `${fmtNum(ov.new24h)} discovered in 24h`],
    ['Active', fmtNum(statusCount.active ?? 0), `${fmtNum(ov.changed24h)} changed in 24h`],
    ['Due now', fmtNum(ov.due), 'waiting for next crawl'],
    ['Avg. rating', ov.avg_rating == null ? '—' : ov.avg_rating.toFixed(2), `${fmtNum(ov.snapshots)} history snapshots`],
    ['Last run', last ? badge(last.status) : '—', last ? `${fmtNum(last.processed)} apps · ${relTime(last.updated_at)}` : 'no runs yet'],
  ];
  const maxCat = Math.max(1, ...ov.categories.map((c) => c.n));

  const statusOpts = ['', 'active', 'new', 'not_found', 'failed', 'removed', 'disallowed']
    .map((s) => `<option value="${s}" ${filters.status === s ? 'selected' : ''}>${s ? s.replace('_', ' ') : 'All statuses'}</option>`).join('');
  const catOpts = ['', ...categories]
    .map((c) => `<option value="${esc(c)}" ${filters.category === c ? 'selected' : ''}>${c ? esc(prettyCat(c)) : 'All categories'}</option>`).join('');
  const sortLabels = { title: 'Name', rating: 'Rating', ratings: 'Most ratings', installs: 'Installs', updated: 'Store update', crawled: 'Last crawled', discovered: 'Newest discovered' };
  const sortOpts = SORT_KEYS.map((k) => `<option value="${k}" ${filters.sort === k ? 'selected' : ''}>${sortLabels[k]}</option>`).join('');

  const rows = list.rows.map((a) => `
    <tr>
      <td class="app-cell"><a href="/app/${encodeURIComponent(a.package_name)}">${icon(a)}<span><strong>${esc(a.title ?? a.package_name)}</strong><small>${esc(a.package_name)}</small></span></a></td>
      <td class="hide-sm">${esc(a.developer ?? '—')}</td>
      <td class="hide-md">${a.category ? `<span class="chip">${esc(prettyCat(a.category))}</span>` : '<span class="dim">—</span>'}</td>
      <td class="num">${stars(a.rating)}</td>
      <td class="num hide-sm">${fmtCompact(a.rating_count == null ? null : Number(a.rating_count))}</td>
      <td class="num hide-sm">${esc(a.installs ?? '—')}</td>
      <td>${badge(a.status)}</td>
      <td class="num hide-md dim" title="${esc(fmtDate(a.last_attempt_at))}">${relTime(a.last_attempt_at)}</td>
    </tr>`).join('');

  const pages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
  const page = Math.min(filters.page, pages);
  const pager = pages > 1 ? `<div class="pager">
      ${page > 1 ? `<a class="btn" href="${qs(filters, { page: page - 1 })}">← Prev</a>` : '<span class="btn disabled">← Prev</span>'}
      <span>Page ${page} of ${pages}</span>
      ${page < pages ? `<a class="btn" href="${qs(filters, { page: page + 1 })}">Next →</a>` : '<span class="btn disabled">Next →</span>'}
    </div>` : '';

  return `
  <section class="cards">${cards.map(([k, v, s]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('')}</section>

  <section class="grid2">
    <div class="panel">
      <h2>Categories</h2>
      ${ov.categories.length ? `<ul class="bars">${ov.categories.map((c) => `
        <li><a href="${qs({}, { category: c.category })}"><span class="lbl">${esc(prettyCat(c.category))}</span><span class="bar"><i style="width:${(c.n / maxCat) * 100}%"></i></span><span class="n">${fmtNum(c.n)}</span></a></li>`).join('')}</ul>` : '<p class="dim">No data yet.</p>'}
    </div>
    <div class="panel">
      <h2>App status</h2>
      <ul class="status-list">${ov.byStatus.map((s) => `<li><a href="${qs({}, { status: s.status })}">${badge(s.status)}<span class="n">${fmtNum(s.n)}</span></a></li>`).join('') || '<li class="dim">No apps yet. Run <code>seed</code> then <code>crawl</code>.</li>'}</ul>
    </div>
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2>Apps <span class="count">${fmtNum(list.total)}</span></h2>
      <form class="filters" method="get" action="/">
        <input type="search" name="q" value="${esc(filters.q)}" placeholder="Search name, package, developer…" aria-label="Search">
        <select name="status" aria-label="Status">${statusOpts}</select>
        <select name="category" aria-label="Category">${catOpts}</select>
        <select name="sort" aria-label="Sort">${sortOpts}</select>
        <button class="btn primary" type="submit">Apply</button>
        ${filters.q || filters.status || filters.category ? '<a class="btn" href="/">Reset</a>' : ''}
      </form>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>App</th><th class="hide-sm">Developer</th><th class="hide-md">Category</th><th class="num">Rating</th><th class="num hide-sm">Ratings</th><th class="num hide-sm">Installs</th><th>Status</th><th class="num hide-md">Crawled</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="8" class="empty">No apps match these filters.</td></tr>'}</tbody>
      </table>
    </div>
    ${pager}
  </section>`;
}

export function runsPage({ runs }) {
  return `
  <h1 class="page-title">Crawl runs</h1>
  <section class="panel">
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Date</th><th>Mode</th><th>Status</th><th class="num">Processed</th><th class="num">OK</th><th class="num hide-sm">404</th><th class="num hide-sm">Failed</th><th class="num hide-sm">Changed</th><th class="num hide-sm">Discovered</th><th class="num hide-md">Requests</th><th class="hide-md">Duration</th></tr></thead>
      <tbody>${runs.map((r) => {
        const pct = r.budget ? Math.min(100, (r.processed / r.budget) * 100) : 0;
        const http = r.http_stats ?? {};
        return `<tr>
          <td class="dim">${esc(r.id)}</td>
          <td>${fmtDate(r.started_at)}${r.message ? `<small class="msg">${esc(r.message)}</small>` : ''}</td>
          <td><span class="chip">${esc(r.mode)}</span></td>
          <td>${badge(r.status)}</td>
          <td class="num"><div class="prog" title="${fmtNum(r.processed)} of budget ${fmtNum(r.budget)}"><span>${fmtNum(r.processed)}</span><i><b style="width:${pct}%"></b></i></div></td>
          <td class="num">${fmtNum(r.succeeded)}</td>
          <td class="num hide-sm">${fmtNum(r.not_found)}</td>
          <td class="num hide-sm">${r.failed ? `<span class="t-bad">${fmtNum(r.failed)}</span>` : 0}</td>
          <td class="num hide-sm">${fmtNum(r.changed)}</td>
          <td class="num hide-sm">${fmtNum(r.discovered)}</td>
          <td class="num hide-md" title="${esc(JSON.stringify(http.status ?? {}))}">${fmtNum(http.requests)}${http.retries ? ` <small class="dim">(${fmtNum(http.retries)} retries)</small>` : ''}</td>
          <td class="hide-md">${duration(r.started_at, r.finished_at ?? r.updated_at)}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="12" class="empty">No runs yet.</td></tr>'}</tbody>
    </table></div>
  </section>`;
}

export function appPage({ app: a, snapshots }) {
  const facts = [
    ['Developer', a.developer_url && /^https?:\/\//.test(a.developer_url) ? `<a href="${esc(a.developer_url)}" rel="noreferrer noopener" target="_blank">${esc(a.developer ?? '—')}</a>` : esc(a.developer ?? '—')],
    ['Category', a.category ? esc(prettyCat(a.category)) : '—'],
    ['Installs', esc(a.installs ?? '—')],
    ['Price', a.price == null ? '—' : Number(a.price) === 0 ? 'Free' : `${esc(a.price)} ${esc(a.currency ?? '')}`],
    ['Version', esc(a.version ?? '—')],
    ['Content rating', esc(a.content_rating ?? '—')],
    ['Store updated', fmtDate(a.store_updated_at, false)],
    ['Contains ads', a.contains_ads == null ? '—' : a.contains_ads ? 'Yes' : 'No'],
  ];
  const crawl = [
    ['Status', badge(a.status)],
    ['Discovered', `${fmtDate(a.discovered_at)}${a.discovered_from ? ` <small class="dim">via ${a.discovered_from === 'seed' ? 'seed' : `<a href="/app/${encodeURIComponent(a.discovered_from)}">${esc(a.discovered_from)}</a>`}</small>` : ''}`],
    ['Last success', fmtDate(a.last_success_at)],
    ['Last changed', fmtDate(a.last_changed_at)],
    ['Next crawl', `${fmtDate(a.next_crawl_at)} <small class="dim">(${relTime(a.next_crawl_at)})</small>`],
    ['Recrawl interval', a.recrawl_hours ? `${Math.round(a.recrawl_hours)} h` : '—'],
    ['Failures in a row', fmtNum(a.consecutive_failures)],
    ['Last error', a.last_error ? `<span class="t-bad">${esc(a.last_error)}</span>` : '—'],
  ];
  const storeUrl = `https://play.google.com/store/apps/details?id=${encodeURIComponent(a.package_name)}`;
  return `
  <a class="back" href="/">← All apps</a>
  <section class="hero panel">
    ${icon(a, 72)}
    <div class="hero-main">
      <h1>${esc(a.title ?? a.package_name)}</h1>
      <div class="sub"><code>${esc(a.package_name)}</code> ${badge(a.status)}</div>
      <div class="hero-stats">
        <div><span class="big">${a.rating == null ? '—' : Number(a.rating).toFixed(1)}</span><small>${fmtNum(a.rating_count == null ? null : Number(a.rating_count))} ratings</small></div>
        <div><span class="big">${esc(a.installs ?? '—')}</span><small>installs</small></div>
        <div><span class="big">${esc(a.version ?? '—')}</span><small>version</small></div>
      </div>
    </div>
    <a class="btn" href="${esc(storeUrl)}" rel="noreferrer noopener" target="_blank">Open in Play Store ↗</a>
  </section>

  <section class="grid2">
    <div class="panel"><h2>Store details</h2><dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>
    <div class="panel"><h2>Crawl state</h2><dl>${crawl.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>
  </section>

  <section class="grid2">
    <div class="panel"><h2>Rating over time</h2>${lineChart(snapshots, 'rating', (v) => v.toFixed(2))}</div>
    <div class="panel"><h2>Number of ratings</h2>${lineChart(snapshots, 'rating_count', (v) => fmtCompact(v))}</div>
  </section>

  ${a.description ? `<section class="panel"><h2>Description</h2><p class="desc">${esc(a.description)}</p></section>` : ''}

  <section class="panel">
    <h2>Change history <span class="count">${fmtNum(snapshots.length)}</span></h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Captured</th><th class="num">Rating</th><th class="num">Ratings</th><th>Installs</th><th>Version</th></tr></thead>
      <tbody>${[...snapshots].reverse().map((s) => `<tr><td>${fmtDate(s.captured_at)}</td><td class="num">${s.rating == null ? '—' : Number(s.rating).toFixed(2)}</td><td class="num">${fmtNum(s.rating_count == null ? null : Number(s.rating_count))}</td><td>${esc(s.installs ?? '—')}</td><td>${esc(s.version ?? '—')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No snapshots yet.</td></tr>'}</tbody>
    </table></div>
  </section>`;
}

export function notFoundPage() {
  return `<section class="panel empty-state"><h1>Not found</h1><p>That app is not in the database.</p><a class="btn" href="/">Back to apps</a></section>`;
}

// ------------------------------------------------------------------ chart
function lineChart(snaps, key, fmt) {
  const pts = snaps.filter((s) => s[key] != null).map((s) => ({ t: new Date(s.captured_at).getTime(), v: Number(s[key]) }));
  if (pts.length < 2) {
    return `<div class="chart-empty">${pts.length ? `Only one data point so far (${fmt(pts[0].v)}). The chart fills in as the app changes over time.` : 'No data yet.'}</div>`;
  }
  const W = 560, H = 180, P = { l: 48, r: 14, t: 12, b: 26 };
  let min = Math.min(...pts.map((p) => p.v)), max = Math.max(...pts.map((p) => p.v));
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.1; min -= pad; max += pad;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  const x = (t) => P.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const area = `${line}L${x(t1).toFixed(1)},${H - P.b}L${x(t0).toFixed(1)},${H - P.b}Z`;
  const ticks = [0, 0.5, 1].map((f) => min + (max - min) * f);
  const last = pts[pts.length - 1];
  const short = t1 - t0 < 2 * 86_400_000; // same-day data: show times on the axis
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(key)} over time">
    ${ticks.map((v) => `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${P.l - 8}" y="${y(v) + 4}" text-anchor="end">${esc(fmt(v))}</text>`).join('')}
    <text class="axis" x="${P.l}" y="${H - 6}">${esc(fmtDate(t0, short))}</text>
    <text class="axis" x="${W - P.r}" y="${H - 6}" text-anchor="end">${esc(fmtDate(t1, short))}</text>
    <path class="area" d="${area}"/><path class="line" d="${line}"/>
    ${pts.map((p) => `<circle class="dot" cx="${x(p.t).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3"><title>${esc(fmtDate(p.t))}: ${esc(fmt(p.v))}</title></circle>`).join('')}
    <circle class="dot last" cx="${x(last.t).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="4.5"/>
  </svg>`;
}

function prettyCat(c) {
  return String(c).replace(/^GAME_/, 'Game · ').replace(/_/g, ' ').toLowerCase().replace(/(^|[\s·]+)(\w)/g, (m) => m.toUpperCase());
}

// ------------------------------------------------------------------ styles
const CSS = `
:root{--bg:#f6f7f9;--panel:#fff;--text:#111827;--muted:#6b7280;--line:#e5e7eb;--soft:#f1f3f5;--accent:#0b8a5f;--accent-soft:#e3f4ec;
--good:#0b8a5f;--good-bg:#e3f4ec;--info:#2563eb;--info-bg:#e6eefc;--warn:#b45309;--warn-bg:#fdf1de;--bad:#c2410c;--bad-bg:#fde8df;--mut-bg:#eef0f3;
--shadow:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.06);color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--panel:#161b22;--text:#e6e8eb;--muted:#9aa3ad;--line:#262d36;--soft:#1c222b;--accent:#34c38f;--accent-soft:#11392b;
--good:#34c38f;--good-bg:#11392b;--info:#7aa7ff;--info-bg:#18294a;--warn:#f0b35a;--warn-bg:#3a2a12;--bad:#ff8a65;--bad-bg:#3d1d14;--mut-bg:#232a33;--shadow:none;color-scheme:dark}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
a{color:inherit;text-decoration:none}a:hover{color:var(--accent)}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--soft);padding:1px 6px;border-radius:5px}
.wrap{max-width:1200px;margin:0 auto;padding:0 16px}
.top{background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
.top-inner{display:flex;align-items:center;justify-content:space-between;height:56px}
.brand{display:flex;align-items:center;gap:10px;font-weight:650;font-size:15px}.brand svg{width:22px;height:22px;fill:var(--accent)}
nav{display:flex;gap:4px}nav a{padding:6px 12px;border-radius:8px;color:var(--muted);font-weight:500}nav a:hover{background:var(--soft);color:var(--text)}
.notice{border-bottom:1px solid var(--line);padding:10px 0;font-size:13px}.notice.demo{background:var(--info-bg);color:var(--info)}.notice.bad{background:var(--bad-bg);color:var(--bad)}
main.wrap{padding-top:24px;padding-bottom:8px}
.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:16px}
.card,.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow)}
.card{padding:14px 16px}.card .k{color:var(--muted);font-size:12px;font-weight:500;text-transform:uppercase;letter-spacing:.04em}
.card .v{font-size:26px;font-weight:650;margin:4px 0 2px;letter-spacing:-.01em;font-variant-numeric:tabular-nums}.card .s{color:var(--muted);font-size:12.5px}
.panel{padding:18px;margin-bottom:16px}.panel h2{font-size:15px;margin:0 0 12px;font-weight:620}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}.grid2 .panel{margin-bottom:0}.grid2{margin-bottom:16px}
.panel-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.panel-head h2{margin:0}
.count{color:var(--muted);font-weight:500;font-size:13px;background:var(--soft);padding:1px 8px;border-radius:99px;margin-left:4px}
.filters{display:flex;flex-wrap:wrap;gap:8px}
input,select{font:inherit;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:7px 10px;min-height:36px}
input[type=search]{width:260px;max-width:100%}input:focus,select:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)}
.btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-weight:550;padding:7px 14px;min-height:36px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text);cursor:pointer;white-space:nowrap}
.btn:hover{background:var(--soft);color:var(--text)}.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}.btn.primary:hover{filter:brightness(1.05);color:#fff}.btn.disabled{opacity:.45;pointer-events:none}
.table-wrap{overflow-x:auto;margin:0 -18px}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:550;text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:middle}tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:var(--soft)}
th:first-child,td:first-child{padding-left:18px}th:last-child,td:last-child{padding-right:18px}
.num{text-align:right}.dim{color:var(--muted)}.empty{text-align:center;color:var(--muted);padding:32px}
.app-cell a{display:flex;align-items:center;gap:12px;min-width:220px}.app-cell span{display:flex;flex-direction:column;min-width:0}
.app-cell strong{font-weight:580;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px}.app-cell small{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px}
.icon-wrap{position:relative;width:var(--s);height:var(--s);flex:none}.icon-wrap img{position:absolute;inset:0}
.icon{width:var(--s);height:var(--s);border-radius:22%;flex:none;object-fit:cover;background:var(--soft)}
.icon.fallback{display:inline-flex;align-items:center;justify-content:center;font-weight:650;font-size:calc(var(--s)*.42);color:#fff;background:linear-gradient(135deg,hsl(var(--h) 60% 52%),hsl(calc(var(--h) + 40) 62% 42%))}
.badge{display:inline-block;font-size:12px;font-weight:560;padding:2px 9px;border-radius:99px;text-transform:capitalize;white-space:nowrap}
.badge.good{background:var(--good-bg);color:var(--good)}.badge.info{background:var(--info-bg);color:var(--info)}.badge.warn{background:var(--warn-bg);color:var(--warn)}.badge.bad{background:var(--bad-bg);color:var(--bad)}.badge.muted{background:var(--mut-bg);color:var(--muted)}
.chip{display:inline-block;font-size:12px;padding:2px 8px;border-radius:6px;background:var(--soft);color:var(--muted);white-space:nowrap}
.rating{display:inline-flex;align-items:center;gap:4px;font-weight:560}.rating svg{width:13px;height:13px;fill:#f5a623}
.t-bad{color:var(--bad)}
.bars{list-style:none;margin:0;padding:0}.bars li a{display:grid;grid-template-columns:minmax(110px,180px) 1fr 44px;align-items:center;gap:10px;padding:5px 0}
.bars .lbl{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bar{height:8px;background:var(--soft);border-radius:99px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent);border-radius:99px}.bars .n{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}
.status-list{list-style:none;margin:0;padding:0}.status-list a{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px dashed var(--line)}.status-list li:last-child a{border:0}.status-list .n{font-weight:600;font-variant-numeric:tabular-nums}
.pager{display:flex;justify-content:center;align-items:center;gap:14px;margin-top:14px;color:var(--muted)}
.page-title{font-size:22px;margin:0 0 16px}
.prog{display:flex;flex-direction:column;align-items:flex-end;gap:4px}.prog i{display:block;width:90px;height:4px;background:var(--soft);border-radius:9px;overflow:hidden}.prog b{display:block;height:100%;background:var(--accent)}
.msg{display:block;color:var(--muted);font-size:12px;max-width:340px}
.back{display:inline-block;color:var(--muted);margin-bottom:12px}
.hero{display:flex;gap:20px;align-items:flex-start}.hero-main{flex:1;min-width:0}.hero h1{margin:0 0 4px;font-size:24px;letter-spacing:-.01em}
.sub{display:flex;gap:8px;align-items:center;flex-wrap:wrap;color:var(--muted)}
.hero-stats{display:flex;gap:28px;margin-top:14px;flex-wrap:wrap}.hero-stats div{display:flex;flex-direction:column}.hero-stats .big{font-size:20px;font-weight:650}.hero-stats small{color:var(--muted)}
dl{display:grid;grid-template-columns:150px 1fr;gap:8px 12px;margin:0}dt{color:var(--muted)}dd{margin:0;word-break:break-word}
.desc{white-space:pre-line;margin:0;color:var(--text);max-height:300px;overflow:auto}
.chart{width:100%;height:auto;display:block}.chart .grid{stroke:var(--line);stroke-dasharray:3 4}.chart .axis{fill:var(--muted);font-size:11px}
.chart .line{fill:none;stroke:var(--accent);stroke-width:2.2;stroke-linejoin:round}.chart .area{fill:var(--accent);opacity:.09}.chart .dot{fill:var(--panel);stroke:var(--accent);stroke-width:2}.chart .dot.last{fill:var(--accent)}
.chart-empty{color:var(--muted);padding:40px 12px;text-align:center;background:var(--soft);border-radius:8px}
.empty-state{text-align:center;padding:48px}
.foot{color:var(--muted);font-size:12px;padding:8px 16px 32px;text-align:center}
@media (max-width:1000px){.cards{grid-template-columns:repeat(3,1fr)}.hide-md{display:none}}
@media (max-width:720px){.cards{grid-template-columns:repeat(2,1fr)}.grid2{grid-template-columns:1fr}.hide-sm{display:none}.hero{flex-wrap:wrap}
input[type=search]{width:100%}.filters{width:100%}.filters select{flex:1}dl{grid-template-columns:120px 1fr}.app-cell a{min-width:0;gap:10px}.app-cell strong,.app-cell small{max-width:125px}th,td{padding-left:8px;padding-right:8px}}
`;
