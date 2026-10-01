import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAppPage, extractLinkedPackages, isValidPackageName, detailsUrl } from '../src/parser.js';
import { appPage } from './fixtures.js';

test('parses JSON-LD and embedded data', () => {
  const app = parseAppPage(appPage('com.example.game', { links: ['com.other.app'] }), 'com.example.game');
  assert.equal(app.title, 'App com.example.game');
  assert.equal(app.developer, 'Dev Co');
  assert.equal(app.description, 'A test app &amp; more');
  assert.equal(app.rating, 4.2);
  assert.equal(app.ratingCount, 1234);
  assert.equal(app.price, 0);
  assert.equal(app.currency, 'USD');
  assert.equal(app.installs, '1,000,000+');
  assert.equal(app.minInstalls, 1000000);
  assert.equal(app.version, '1.0.0');
  assert.equal(app.updatedAt, '2026-01-01T00:00:00.000Z');
  assert.match(app.contentHash, /^[0-9a-f]{64}$/);
});

test('content hash changes when tracked fields change', () => {
  const a = parseAppPage(appPage('com.a.b', { version: '1' }), 'com.a.b');
  const b = parseAppPage(appPage('com.a.b', { version: '2' }), 'com.a.b');
  assert.notEqual(a.contentHash, b.contentHash);
});

test('returns null for non-app pages', () => {
  assert.equal(parseAppPage('<html><body>nothing</body></html>', 'com.a.b'), null);
});

test('extracts linked packages, excluding self and invalid ids', () => {
  const html = appPage('com.self.app', { links: ['com.one.app', 'com.two.app', 'com.self.app', 'com.one.app'] });
  assert.deepEqual(extractLinkedPackages(html, 'com.self.app').sort(), ['com.one.app', 'com.two.app']);
});

test('package validation and URL building', () => {
  assert.ok(isValidPackageName('com.whatsapp'));
  assert.ok(!isValidPackageName('nodot'));
  assert.ok(!isValidPackageName('com.foo;drop'));
  assert.equal(detailsUrl('https://play.google.com', 'com.a.b', 'en', 'us'),
    'https://play.google.com/store/apps/details?id=com.a.b&hl=en&gl=us');
});
