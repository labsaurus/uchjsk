// robots.txt parser/evaluator (RFC 9309 semantics: most specific group,
// longest-match rule wins, Allow wins ties, `*` and `$` supported).

export class RobotsPolicy {
  constructor(rules = [], crawlDelayMs = null, mode = 'rules') {
    this.rules = rules; // [{allow:boolean, pattern:string, re:RegExp, len:number}]
    this.crawlDelayMs = crawlDelayMs;
    this.mode = mode; // 'rules' | 'allow_all' | 'disallow_all'
  }

  static allowAll() { return new RobotsPolicy([], null, 'allow_all'); }
  static disallowAll() { return new RobotsPolicy([], null, 'disallow_all'); }

  static parse(text, userAgentToken) {
    const token = userAgentToken.toLowerCase();
    const groups = [];
    let current = null;
    let lastWasAgent = false;
    for (const rawLine of String(text).split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, '').trim();
      if (!line) continue;
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const field = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (field === 'user-agent') {
        if (!lastWasAgent || !current) {
          current = { agents: [], rules: [], crawlDelay: null };
          groups.push(current);
        }
        current.agents.push(value.toLowerCase());
        lastWasAgent = true;
        continue;
      }
      lastWasAgent = false;
      if (!current) continue;
      if (field === 'allow' || field === 'disallow') {
        if (field === 'disallow' && value === '') continue; // empty disallow = allow all
        current.rules.push({ allow: field === 'allow', pattern: value });
      } else if (field === 'crawl-delay') {
        const d = Number(value);
        if (Number.isFinite(d) && d >= 0) current.crawlDelay = d;
      }
    }

    const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
    const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
    const rules = [];
    let crawlDelay = null;
    for (const g of chosen) {
      for (const r of g.rules) rules.push({ ...r, re: patternToRegex(r.pattern), len: r.pattern.length });
      if (g.crawlDelay != null) crawlDelay = Math.max(crawlDelay ?? 0, g.crawlDelay);
    }
    return new RobotsPolicy(rules, crawlDelay == null ? null : crawlDelay * 1000);
  }

  /** @param {string} pathAndQuery e.g. "/store/apps/details?id=com.foo" */
  isAllowed(pathAndQuery) {
    if (this.mode === 'allow_all') return true;
    if (this.mode === 'disallow_all') return false;
    if (pathAndQuery === '/robots.txt') return true;
    let best = null;
    for (const r of this.rules) {
      if (!r.re.test(pathAndQuery)) continue;
      if (!best || r.len > best.len || (r.len === best.len && r.allow && !best.allow)) best = r;
    }
    return best ? best.allow : true;
  }
}

function patternToRegex(pattern) {
  let p = pattern;
  const anchored = p.endsWith('$');
  if (anchored) p = p.slice(0, -1);
  const body = p
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}
