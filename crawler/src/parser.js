// Parse a Play Store app details page.
//
// Primary source: the schema.org JSON-LD block (stable, documented format).
// Secondary, best-effort: the embedded `ds:5` data blob for fields JSON-LD
// lacks (installs, version, last updated...). Its layout is undocumented and
// changes occasionally, so every lookup is defensive and missing values are
// simply stored as NULL rather than failing the item.

import crypto from 'node:crypto';

const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const LINK_RE = /\/store\/apps\/details\?id=([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)/g;

export function isValidPackageName(name) {
  return typeof name === 'string' && name.length <= 255 && PACKAGE_RE.test(name);
}

export function detailsUrl(baseUrl, packageName, lang, country) {
  const u = new URL('/store/apps/details', baseUrl);
  u.searchParams.set('id', packageName);
  u.searchParams.set('hl', lang);
  u.searchParams.set('gl', country);
  return u.toString();
}

/** Extract other app package names linked from the page (similar apps, same developer...). */
export function extractLinkedPackages(html, selfPackage) {
  const found = new Set();
  for (const m of html.matchAll(LINK_RE)) {
    const pkg = m[1];
    if (pkg !== selfPackage && isValidPackageName(pkg)) found.add(pkg);
  }
  return [...found];
}

export function parseAppPage(html, packageName) {
  const ld = extractJsonLd(html);
  const ds5 = extractInitData(html, 'ds:5');
  const d = ds5?.[1]?.[2];

  const title = str(ld?.name) ?? str(at(d, 0, 0)) ?? metaContent(html, 'og:title');
  if (!title) return null; // not a recognisable app page

  const offer = Array.isArray(ld?.offers) ? ld.offers[0] : ld?.offers;
  const app = {
    packageName,
    title: decodeEntities(title),
    developer: str(ld?.author?.name) ?? str(at(d, 68, 0)),
    developerUrl: str(ld?.author?.url) ?? null,
    description: str(ld?.description) ?? metaContent(html, 'og:description'),
    iconUrl: str(ld?.image) ?? metaContent(html, 'og:image'),
    category: str(ld?.applicationCategory) ?? str(at(d, 79, 0, 0, 0)),
    contentRating: str(ld?.contentRating) ?? str(at(d, 9, 0)),
    rating: numOrNull(ld?.aggregateRating?.ratingValue) ?? numOrNull(at(d, 51, 0, 1)),
    ratingCount: intOrNull(ld?.aggregateRating?.ratingCount) ?? intOrNull(at(d, 51, 2, 1)),
    price: numOrNull(offer?.price),
    currency: str(offer?.priceCurrency),
    installs: str(at(d, 13, 0)),
    minInstalls: intOrNull(at(d, 13, 1)),
    version: str(at(d, 140, 0, 0, 0)),
    updatedAt: epochToIso(at(d, 145, 0, 1, 0)),
    releasedAt: str(at(d, 10, 0)),
    containsAds: typeof at(d, 48) === 'string' ? true : null,
  };
  app.contentHash = hashApp(app);
  return app;
}

/** Hash of the fields we treat as "the app changed" (drives recrawl interval + snapshots). */
export function hashApp(app) {
  const fields = [
    app.title, app.developer, app.description, app.category, app.contentRating,
    app.rating, app.ratingCount, app.price, app.currency, app.installs, app.version, app.updatedAt,
  ];
  return crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

export function extractJsonLd(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      const data = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : [data];
      const app = items.find((x) => /SoftwareApplication|MobileApplication/i.test(String(x?.['@type'])));
      if (app) return app;
    } catch {
      // ignore malformed block
    }
  }
  return null;
}

/** Extract the JSON `data:` array from `AF_initDataCallback({key: '<key>', ... data: [...] ...})`. */
export function extractInitData(html, key) {
  const marker = html.search(new RegExp(`AF_initDataCallback\\(\\{key:\\s*'${key.replace(':', '\\:')}'`));
  if (marker === -1) return null;
  const dataIdx = html.indexOf('data:', marker);
  if (dataIdx === -1) return null;
  const start = html.indexOf('[', dataIdx);
  if (start === -1) return null;
  const end = matchBracket(html, start);
  if (end === -1) return null;
  try {
    return JSON.parse(html.slice(start, end + 1));
  } catch {
    return null;
  }
}

function matchBracket(s, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function at(obj, ...path) {
  let cur = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function str(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(v) {
  const n = numOrNull(v);
  return n == null ? null : Math.round(n);
}

function epochToIso(v) {
  return Number.isFinite(v) && v > 1e9 ? new Date(v * 1000).toISOString() : null;
}

function metaContent(html, property) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`, 'i');
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : null;
}

function decodeEntities(s) {
  if (s == null) return s;
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
