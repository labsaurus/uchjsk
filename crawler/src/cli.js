#!/usr/bin/env node
// Command line entry point.
//
//   migrate                       create/upgrade the schema
//   seed <pkg|file>...            add package names (or files with one per line)
//   crawl [--full] [--force]      run (or resume) today's crawl
//   status                        show counts, due apps and recent runs
//   mark-all-due                  make every known app due on the next crawl
//   clear-block                   clear a hard-block cooldown (after investigating!)

import fs from 'node:fs';
import { buildConfig, loadDotEnv } from './config.js';
import { createLogger } from './lib/logger.js';
import { createPool, migrate } from './db.js';
import { Store } from './store.js';
import { Crawler } from './crawler.js';
import { isValidPackageName } from './parser.js';

const EXIT = { ok: 0, error: 1, usage: 2, blocked: 3, locked: 4, incomplete: 5 };

async function main(argv) {
  loadDotEnv();
  const [cmd, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const args = rest.filter((a) => !a.startsWith('--'));
  const cfg = buildConfig();
  const log = createLogger(cfg.logLevel, { svc: 'playstore-crawler' });

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || flags.has('--help')) {
    process.stdout.write(usage());
    return cmd ? EXIT.ok : EXIT.usage;
  }

  const pool = createPool(cfg);
  try {
    switch (cmd) {
      case 'migrate':
        await migrate(pool, log);
        log.info('database schema up to date');
        return EXIT.ok;

      case 'seed': {
        const pkgs = collectPackages(args, log);
        if (!pkgs.length) {
          log.error('no valid package names given');
          return EXIT.usage;
        }
        const store = new Store(pool, cfg);
        let added = 0;
        for (let i = 0; i < pkgs.length; i += 1000) {
          added += await store.addApps(pkgs.slice(i, i + 1000), { from: 'seed', priority: 200 });
        }
        log.info('seeded apps', { given: pkgs.length, added });
        return EXIT.ok;
      }

      case 'crawl': {
        await migrate(pool, log);
        const crawler = new Crawler({ cfg, pool, log });
        installSignalHandlers(crawler, log);
        const result = await crawler.run({ mode: flags.has('--full') ? 'full' : 'incremental', force: flags.has('--force') });
        if (result.status === 'blocked' || result.status === 'blocked_cooldown') return EXIT.blocked;
        if (result.status === 'locked') return EXIT.locked;
        if (result.status === 'completed' || result.status === 'already_completed') return EXIT.ok;
        // paused / interrupted: progress is saved; the next timer run resumes.
        return EXIT.incomplete;
      }

      case 'status': {
        const s = await new Store(pool, cfg).summary();
        process.stdout.write(JSON.stringify(s, null, 2) + '\n');
        return EXIT.ok;
      }

      case 'mark-all-due': {
        const n = await new Store(pool, cfg).markAllDue();
        log.info('marked apps due', { count: n });
        return EXIT.ok;
      }

      case 'clear-block': {
        await new Store(pool, cfg).setState('blocked_until', { until: null, clearedAt: new Date().toISOString() });
        log.warn('hard-block cooldown cleared by operator');
        return EXIT.ok;
      }

      default:
        process.stderr.write(`unknown command: ${cmd}\n\n${usage()}`);
        return EXIT.usage;
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

function collectPackages(args, log) {
  const out = new Set();
  for (const a of args) {
    let candidates = [a];
    if (fs.existsSync(a) && fs.statSync(a).isFile()) {
      candidates = fs.readFileSync(a, 'utf8').split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
    }
    for (const c of candidates) {
      if (isValidPackageName(c)) out.add(c);
      else log.warn('skipping invalid package name', { value: c });
    }
  }
  return [...out];
}

function installSignalHandlers(crawler, log) {
  let count = 0;
  const handler = (sig) => {
    count++;
    if (count === 1) {
      log.info('received signal, shutting down gracefully (send again to force)', { sig });
      crawler.stop(`signal:${sig}`);
    } else {
      log.warn('second signal: aborting in-flight requests', { sig });
      crawler.stop(`signal:${sig}`, { hard: true });
    }
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

function usage() {
  return `Usage: node src/cli.js <command> [options]

Commands:
  migrate                      Create or upgrade the database schema
  seed <pkg|file>...           Add package names (or files, one package per line)
  crawl [--full] [--force]     Run or resume the daily crawl
                                 --full   full rescan of every known app (resumable, may span days)
                                 --force  run again even if today's incremental crawl completed
  status                       Print app counts, due apps and recent runs
  mark-all-due                 Make every known app due for the next incremental crawl
  clear-block                  Clear a hard-block cooldown (only after investigating the cause)

Exit codes: 0 ok, 1 error, 2 usage, 3 blocked, 4 another instance running, 5 paused/interrupted (resumes next run)
`;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(JSON.stringify({ level: 'error', msg: 'fatal', err: err?.message, stack: err?.stack }) + '\n');
    process.exit(EXIT.error);
  },
);
