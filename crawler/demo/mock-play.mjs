// Local mock of a Play-like site with FICTIONAL apps, for trying the crawler and
// dashboard without sending any request to Google. Usage: node demo/mock-play.mjs
import http from 'node:http';
const CATS = ['GAME_PUZZLE','PRODUCTIVITY','TOOLS','EDUCATION','HEALTH_AND_FITNESS','MUSIC_AND_AUDIO','FINANCE','PHOTOGRAPHY','GAME_ACTION','TRAVEL_AND_LOCAL'];
const WORDS = ['Pixel','Nova','Zen','Quick','Bright','Echo','Orbit','Maple','Lumen','Swift','Coral','Atlas','Ember','Tide','Nimbus','Fable','Cobalt','Willow','Prism','Drift'];
const NOUNS = ['Notes','Puzzle','Tracker','Studio','Budget','Runner','Scanner','Radio','Planner','Quest','Lens','Maps','Coach','Words','Timer','Vault','Beats','Garden','Blocks','Journal'];
const DEVS = ['Lumen Labs','Northwind Apps','Bluefin Studio','Kite Software','Orchard Games','Quartz Mobile'];
const INST = [[1000,'1,000+'],[10000,'10,000+'],[100000,'100,000+'],[1000000,'1,000,000+'],[10000000,'10,000,000+']];
const apps = [];
for (let i = 0; i < 48; i++) {
  const w = WORDS[i % 20], n = NOUNS[(i * 7) % 20];
  apps.push({ pkg: `dev.demo.${w.toLowerCase()}${n.toLowerCase()}`, title: `${w} ${n}`, cat: CATS[(i * 3) % 10], dev: DEVS[i % 6],
    rating: 3.4 + ((i * 37) % 15) / 10, count: 500 + ((i * 7919) % 250000), inst: INST[(i * 3 + 1) % 5], ver: [1, (i % 9), 0] });
}
const byPkg = new Map(apps.map((a, i) => [a.pkg, i]));
let day = Number(process.env.DAY || 0);
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/robots.txt') return res.end('User-agent: *\nAllow: /store/apps/details?\nDisallow: /store/search\n');
  if (u.pathname === '/__day') { day = Number(u.searchParams.get('d')); return res.end('ok'); }
  const i = byPkg.get(u.searchParams.get('id'));
  if (i === undefined) { res.writeHead(404); return res.end('not found'); }
  const a = apps[i];
  // Deterministic drift per "day": ratings move slightly, counts grow, some versions bump.
  const rating = Math.min(4.9, Math.max(2.5, a.rating + Math.sin(i + day * 1.3) * 0.15 + day * 0.01 * ((i % 3) - 1)));
  const count = Math.round(a.count * (1 + day * (0.01 + (i % 5) * 0.004)));
  const ver = `${a.ver[0]}.${a.ver[1] + Math.floor((day + i) / 3)}.${(day * (i % 4)) % 10}`;
  const ld = { '@context':'https://schema.org','@type':'SoftwareApplication', name:a.title, description:`${a.title} is a fictional demo app used to test the crawler dashboard.\n\nIt is served by a local mock server and has no relation to any real Google Play listing.`,
    applicationCategory:a.cat, contentRating:'Everyone', author:{'@type':'Person',name:a.dev,url:'https://example.com/dev'},
    aggregateRating:{'@type':'AggregateRating',ratingValue:rating.toFixed(1),ratingCount:String(count)}, offers:[{'@type':'Offer',price:i%11===0?'2.99':'0',priceCurrency:'USD'}] };
  const d = []; d[0]=[a.title]; d[13]=[a.inst[1],a.inst[0]]; d[140]=[[[ver]]]; d[145]=[[null,[1767225600 + (day * 86400) - (i * 86400 * 3),0]]]; if (i % 2) d[48] = 'Contains ads';
  const links = [1, 2, 5].map((k) => apps[(i * 3 + k) % apps.length].pkg);
  const html = `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>${links.map((l) => `<a href="/store/apps/details?id=${l}">x</a>`).join('')}
<script>AF_initDataCallback({key: 'ds:5', hash: '1', data:${JSON.stringify([null,[null,null,d]])}, sideChannel: {}});</script></body></html>`;
  // A little realistic noise: occasional 503 with Retry-After.
  if ((i + day) % 17 === 0 && !req.headers['x-retry']) { res.writeHead(503, { 'retry-after': '1' }); return res.end(); }
  setTimeout(() => { res.setHeader('content-type','text/html'); res.end(html); }, 40 + (i % 5) * 20);
}).listen(8099, () => console.log('mock on 8099'));
