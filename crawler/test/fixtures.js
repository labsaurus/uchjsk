// Synthetic Play Store-like pages for tests (no network access needed).
export function appPage(pkg, { title = `App ${pkg}`, rating = 4.2, version = '1.0.0', links = [] } = {}) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: title,
    url: `https://play.google.com/store/apps/details?id=${pkg}`,
    description: 'A test app &amp; more',
    operatingSystem: 'ANDROID',
    applicationCategory: 'GAME_PUZZLE',
    contentRating: 'Everyone',
    author: { '@type': 'Person', name: 'Dev Co', url: 'https://example.com' },
    aggregateRating: { '@type': 'AggregateRating', ratingValue: String(rating), ratingCount: '1234' },
    offers: [{ '@type': 'Offer', price: '0', priceCurrency: 'USD' }],
    image: 'https://play-lh.googleusercontent.com/icon',
  };
  const d = [];
  d[0] = [title];
  d[13] = ['1,000,000+', 1000000, 2500000, '1M+'];
  d[140] = [[[version]]];
  d[145] = [[null, [1767225600, 0]]];
  const ds5 = [null, [null, null, d]];
  return `<!doctype html><html><head>
<meta property="og:title" content="${title}">
<script type="application/ld+json" nonce="abc">${JSON.stringify(ld)}</script>
</head><body>
${links.map((l) => `<a href="/store/apps/details?id=${l}">x</a>`).join('\n')}
<script nonce="x">AF_initDataCallback({key: 'ds:5', hash: '7', data:${JSON.stringify(ds5)}, sideChannel: {}});</script>
</body></html>`;
}

export const ROBOTS = `User-agent: *\nDisallow: /store/search\nAllow: /store/apps/details?\nDisallow: /store/apps/details?id=com.disallowed\n`;

/** Build a fake fetch from a handler (url) => {status, body, headers} | Error. */
export function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(url);
    if (init?.signal?.aborted) throw init.signal.reason;
    const r = await handler(url, calls.length);
    if (r instanceof Error) throw r;
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  impl.calls = calls;
  return impl;
}
