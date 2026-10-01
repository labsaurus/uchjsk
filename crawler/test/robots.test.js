import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RobotsPolicy } from '../src/robots.js';

const TXT = `
User-agent: *
Disallow: /store/search
Disallow: /store/apps/details?id=*&reviewId
Allow: /store/apps/details?
Disallow: /store/
Crawl-delay: 3

User-agent: BadBot
Disallow: /
`;

test('longest match wins, wildcards, crawl-delay', () => {
  const r = RobotsPolicy.parse(TXT, 'PlayStoreResearchCrawler');
  assert.equal(r.isAllowed('/store/apps/details?id=com.foo&hl=en'), true);
  assert.equal(r.isAllowed('/store/search?q=x'), false);
  assert.equal(r.isAllowed('/store/apps/collection/x'), false);
  assert.equal(r.isAllowed('/store/apps/details?id=com.foo&reviewId=1'), false);
  assert.equal(r.isAllowed('/about'), true);
  assert.equal(r.crawlDelayMs, 3000);
});

test('specific user-agent group takes precedence', () => {
  const r = RobotsPolicy.parse(TXT, 'BadBot');
  assert.equal(r.isAllowed('/store/apps/details?id=com.foo'), false);
});

test('allow-all / disallow-all policies', () => {
  assert.equal(RobotsPolicy.allowAll().isAllowed('/x'), true);
  assert.equal(RobotsPolicy.disallowAll().isAllowed('/x'), false);
});
