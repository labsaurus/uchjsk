import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, layout, homePage, appPage } from '../src/dashboard/views.js';

test('esc neutralises HTML', () => {
  assert.equal(esc(`<script>"x"&'y'</script>`), '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;');
});

test('layout shows a test-data banner for non-Play sources only', () => {
  assert.match(layout({ title: 't', body: '', source: 'http://127.0.0.1:8099' }), /Test data/);
  assert.doesNotMatch(layout({ title: 't', body: '', source: 'https://play.google.com' }), /Test data/);
});

const ov = { total: 1, due: 0, new24h: 1, changed24h: 1, avg_rating: 4.5, snapshots: 2, byStatus: [{ status: 'active', n: 1 }], categories: [{ category: 'TOOLS', n: 1 }], runs: [] };
const evil = { package_name: 'com.x.y', title: '<img src=x onerror=alert(1)>', developer: '"><b>', status: 'active', rating: 4.5, rating_count: 10, icon_url: 'javascript:alert(1)' };

test('home page escapes app data and ignores non-https icons', () => {
  const html = homePage({ ov, list: { rows: [evil], total: 1 }, filters: { q: '"><x', status: '', category: '', sort: 'ratings', page: 1 }, categories: ['TOOLS'] });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(html, /"><x/);
  assert.match(html, /&lt;img src=x/);
});

test('app page renders history chart', () => {
  const snaps = [
    { captured_at: '2026-01-01T00:00:00Z', rating: 4.1, rating_count: 100 },
    { captured_at: '2026-01-02T00:00:00Z', rating: 4.3, rating_count: 150 },
  ];
  const html = appPage({ app: { ...evil, discovered_at: new Date() }, snapshots: snaps });
  assert.match(html, /<svg class="chart"/);
  assert.doesNotMatch(html, /<b>/);
});
