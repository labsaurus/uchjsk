# Play Store Research Crawler

A conservative, resumable crawler for collecting public Google Play app
metadata (title, developer, rating, installs, version, ...) into PostgreSQL.
It is built to run once a day on a small (4 GB RAM) VPS.

It **does not** try to bypass CAPTCHAs, anti-bot systems, access controls,
IP bans, or robots.txt. If the server shows an anti-bot challenge or returns
HTTP 403, the crawler stops at once and sends no requests until a cooldown
(`BLOCK_COOLDOWN_HOURS`, default 24 h) has passed.

- **Node.js ≥ 20**, a single dependency (`pg`), plain HTTP requests. It never
  starts a browser.
- **PostgreSQL** holds the app data, the snapshot history, the run checkpoints
  and the crawler's own state.
- A **systemd timer** (or cron) starts the daily crawl.

---

## How it stays polite

Every HTTP attempt, retries included, goes through this pipeline:

```
robots.txt check ─► circuit breaker ─► global rate limiter ─► fetch ─► outcome
                         ▲                     ▲                         │
                         └──── adaptive throttle (concurrency, delay) ◄──┘
```

| Concern | Behaviour | Main settings |
|---|---|---|
| **Concurrency** | A fixed-size worker pool, starting at `CONCURRENCY` (default 5). Its size is adjusted at run time but always stays within `[MIN_CONCURRENCY, MAX_CONCURRENCY]`. The number of parallel requests is never unbounded. | `CONCURRENCY`, `MIN_CONCURRENCY`, `MAX_CONCURRENCY` |
| **Global rate limit** | One limiter is shared by all workers and grants request slots one at a time, in order. Each slot must satisfy the minimum spacing plus random jitter, a requests-per-minute token bucket, and the adaptive slow-down multiplier. A robots.txt `Crawl-delay` is honoured when present. | `MIN_REQUEST_INTERVAL_MS`, `REQUEST_JITTER_MS`, `MAX_REQUESTS_PER_MINUTE` |
| **Exponential backoff** | HTTP 408/429/500/502/503/504 and network errors are retried with an exponential delay plus jitter. The delay starts at `BACKOFF_BASE_MS` and is capped at `BACKOFF_MAX_MS`. A `Retry-After` header (seconds or HTTP date) is always respected. On a 429 it pauses the global limiter, so every worker backs off, not just one. Retries stop after `MAX_RETRIES`. If `Retry-After` asks for more than `RETRY_AFTER_MAX_MS`, the item is skipped until the next run instead of waiting. | `MAX_RETRIES`, `BACKOFF_*`, `RETRY_AFTER_MAX_MS` |
| **Adaptive throttling** | A 429 halves concurrency and doubles the delay. Repeated errors (an error rate above the threshold, or 3 errors in a row) lower concurrency by 1 and multiply the delay by 1.5. Recovery only starts after a full window with no 429s and an error rate below `ADAPTIVE_STABLE_ERROR_RATE`. It then takes at most one step per `ADAPTIVE_INCREASE_INTERVAL_MS`: the delay comes back down first, and only then is one worker added. | `ADAPTIVE_*`, `MAX_SLOWDOWN_MULTIPLIER` |
| **Circuit breaker** | The circuit opens when `BREAKER_FAILURE_THRESHOLD` or more of the last `BREAKER_WINDOW_SIZE` requests were 429, 5xx or network errors. While it is open, **no requests are sent**. When the cooldown ends, a single probe request is allowed. A few successful probes close the circuit again. A failed probe reopens it with double the cooldown, capped at `BREAKER_MAX_COOLDOWN_MS`. After `BREAKER_MAX_TRIPS_PER_RUN` trips the run pauses and the next timer run resumes it. Breaker state is checkpointed, so a restart does not cut a cooldown short. | `BREAKER_*` |
| **Hard blocks** | A CAPTCHA page, "unusual traffic" page, `/sorry/` redirect or HTTP 403 stops the whole crawl immediately. These are never retried or worked around. A cooldown is stored in PostgreSQL, and later runs exit without sending anything until it expires. | `BLOCK_COOLDOWN_HOURS` |
| **robots.txt** | Fetched at the start of every run and enforced for every URL, following RFC 9309: the longest matching rule wins, and `*` and `$` are supported. If robots.txt can't be reached (5xx or a network error), the crawler treats the whole site as disallowed. | `ROBOTS_USER_AGENT_TOKEN` |
| **Memory** | Response bodies are capped (`MAX_RESPONSE_BYTES`). Only small batches are held in memory. The DB pool is small and the V8 heap is limited to 512 MB. The systemd unit sets `MemoryMax=1G`. | `MAX_RESPONSE_BYTES`, `DB_POOL_MAX` |

## Scheduling and checkpoints

- **Known apps** live in `apps`. Each app has a `next_crawl_at`, a `priority`
  and a per-app recrawl interval.
- **Incremental daily crawl.** Each run only claims apps whose `next_crawl_at`
  has passed, highest priority first:
  - Seeded apps have priority 200.
  - Newly discovered apps have priority 100.
  - Everything else is ordered by how overdue it is.
  - Each run handles at most `MAX_APPS_PER_RUN` apps.
- **Per-app revisit interval:**
  - Apps whose tracked fields changed are revisited after `MIN_RECRAWL_HOURS`.
  - Unchanged apps back off ×1.5 each time, up to `MAX_RECRAWL_HOURS`.
  - Failed apps back off exponentially, starting at `FAILED_RECRAWL_HOURS`.
  - A 404 is retried after `NOT_FOUND_RECRAWL_HOURS`. After
    `NOT_FOUND_MAX_STRIKES` 404s in a row, the app is marked `removed`.
  - A random ±10% is added to every interval so the work spreads out over time.
- **Discovery.** Links to other apps on crawled pages (similar apps, the same
  developer) are added to the queue. This is capped by `MAX_DISCOVERED_PER_RUN`
  and `MAX_TOTAL_APPS`.
- **Checkpointing.** Each app's result is written in one transaction together
  with the run's counters (`crawl_runs`). The database therefore always shows
  exactly what has been done. Throttle and breaker state are also saved every
  `CHECKPOINT_INTERVAL_MS`.
- **Resume:**
  - If the process is killed, crashes or the VPS reboots, the next `crawl` picks
    up the same run row and carries on with the apps that are still due. The
    leases left behind by the dead process are reclaimed.
  - Completed apps are never fetched again in the same run.
  - Throttle and breaker state are restored, so the crawler doesn't restart at
    full speed after a period of trouble.
- **Daily idempotence.** Once today's incremental run has completed, further
  invocations exit without doing anything. Use `--force` to run again anyway.
- **Full rescan.** `crawl --full` revisits every known app, including
  `removed` and `disallowed` ones. A full rescan can span several days: each
  invocation is limited by `MAX_RUN_DURATION_MINUTES`, and a plain `crawl`
  continues an unfinished full rescan before it does anything else. As an
  alternative, `mark-all-due` makes every app due for the regular incremental
  crawl.
- **Single instance.** A PostgreSQL advisory lock guarantees that only one
  crawler runs against a database at a time.
- **Graceful shutdown:**
  - The first SIGTERM or SIGINT stops scheduling new apps and cancels any waits.
    In-flight requests get up to `SHUTDOWN_GRACE_MS` to finish. The crawler then
    releases unprocessed leases, writes a checkpoint and exits with code 5.
  - A second signal aborts in-flight requests immediately.

## Data model

| Table | Contents |
|---|---|
| `apps` | One row per package: the latest parsed metadata plus its scheduling state. |
| `app_snapshots` | Time series. A row is added whenever an app's tracked fields change. |
| `crawl_runs` | One row per run: mode, status, budget, counters, last package, and saved throttle, breaker and HTTP stats. |
| `crawler_state` | Global state, such as the hard-block cooldown. |

Parsing relies mainly on the page's schema.org **JSON-LD** block. A few extra
fields, such as installs, version and last updated, come from the page's
embedded data on a best-effort basis. That format is undocumented, so a field
that is missing is stored as `NULL` and the item does not fail.

---

## Installation (Debian/Ubuntu, 4 GB VPS)

```bash
# 1. Prerequisites
sudo apt-get install -y postgresql nodejs npm      # Node.js >= 20 (use NodeSource if your distro's is older)

# 2. Database
sudo -u postgres psql <<'SQL'
CREATE ROLE crawler LOGIN PASSWORD 'change-me';
CREATE DATABASE playstore OWNER crawler;
SQL

# 3. Install the app and its systemd units
cd crawler && sudo ./deploy/install.sh

# 4. Configure (at minimum DATABASE_URL and USER_AGENT with a real contact)
sudoedit /opt/playstore-crawler/.env

# 5. Schema + seeds
sudo -u crawler bash -c 'cd /opt/playstore-crawler && node src/cli.js migrate'
sudo -u crawler bash -c 'cd /opt/playstore-crawler && node src/cli.js seed seeds/example.txt'

# 6. Enable the daily timer
sudo systemctl enable --now playstore-crawler.timer
systemctl list-timers playstore-crawler.timer
```

The timer starts a crawl every day at about 03:15, with a random delay of up to
30 minutes. `Persistent=true` catches up on a crawl missed during downtime.
`OnBootSec=15min` resumes an interrupted run after a reboot. If you prefer cron,
see `deploy/crontab.example`.

Suggested PostgreSQL settings for a 4 GB VPS shared with the crawler, in
`postgresql.conf`:

```
shared_buffers = 512MB
effective_cache_size = 1536MB
work_mem = 8MB
maintenance_work_mem = 128MB
max_connections = 30
```

## Usage

```bash
node src/cli.js migrate                  # create/upgrade schema
node src/cli.js seed com.foo.bar list.txt  # add packages (args or files)
node src/cli.js crawl                    # run or resume today's incremental crawl
node src/cli.js crawl --full             # full rescan (resumable, may span days)
node src/cli.js crawl --force            # crawl again even if today's run completed
node src/cli.js status                   # counts, due apps, recent runs (JSON)
node src/cli.js mark-all-due             # make every app due for the next crawl
node src/cli.js clear-block              # clear a hard-block cooldown (investigate first!)
node src/cli.js serve                    # read-only web dashboard on 127.0.0.1:8080
```

Logs are written as one JSON line per event to stdout/stderr, so journald
captures them. To follow them:

```bash
journalctl -u playstore-crawler -f
```

| Exit code | Meaning |
|---|---|
| 0 | Completed, or today's crawl was already done |
| 1 | Unexpected error |
| 2 | Usage error |
| 3 | Blocked: an anti-bot challenge or 403 was seen, or a cooldown is active |
| 4 | Another instance is already running |
| 5 | Paused or interrupted; progress is saved and the next run resumes it. systemd treats this as success. |

## Web dashboard

`node src/cli.js serve` starts a small, read-only web dashboard. It has no
extra dependencies and runs as plain server-rendered HTML. It shows:

- **Overview:** total, active and due apps, average rating, the last run, a
  category breakdown and status counts.
- **Apps:** search by name, package or developer; filter by status or
  category; sort; pagination.
- **App detail:** store details, crawl state, charts of rating and number of
  ratings over time (from `app_snapshots`), and the change history.
- **Runs:** progress, outcomes, HTTP requests, retries and duration for each
  crawl run.

By default it listens on `127.0.0.1:8080` only. To open it from your own
computer, use an SSH tunnel:

```bash
ssh -L 8080:127.0.0.1:8080 you@your-vps   # then open http://localhost:8080
```

To run it permanently, use `systemctl enable --now playstore-dashboard`. If you
expose it publicly, set `DASHBOARD_USER` and `DASHBOARD_PASSWORD` (HTTP Basic
auth) and put it behind an HTTPS reverse proxy. If `PLAY_BASE_URL` is not Google
Play, the dashboard shows a "Test data" banner.

### Demo without touching Google Play

`demo/run-demo.sh` starts a local mock server that serves fictional apps. It
crawls six simulated "days" into a separate, empty database and then opens the
dashboard:

```bash
DEMO_DATABASE_URL=postgres://crawler:pass@localhost/playstore_demo ./demo/run-demo.sh
```

## Configuration

All settings are environment variables. You can also put them in a `.env` file
in the working directory; real environment variables take precedence. See
[`.env.example`](.env.example) for every option with its default. Values are
validated at startup and must be within allowed ranges, so a typo can't remove
the limits.

The defaults are deliberately slow: at most 30 requests per minute, at least
1.5 s between requests, and 5 workers. At that rate 5,000 apps take roughly
3 hours. Raise the limits gradually, and only if the error rate stays at zero.

## Tests

```bash
npm test                                   # unit tests (no network, no DB)
TEST_DATABASE_URL=postgres://user:pass@localhost/crawler_test npm test   # + end-to-end tests
```

The end-to-end tests use a fake network against a real PostgreSQL database.
**They drop and recreate the `public` schema**, so only point
`TEST_DATABASE_URL` at a throwaway database. They cover:

- discovery, 404 handling and robots.txt disallow
- daily idempotence
- interruption and resume of the same run
- crash recovery from stale leases
- hard-block cooldown
- circuit breaker pause
- resumable full rescan
- the single-instance lock

## Responsible use

Use the crawler only for research that complies with Google Play's Terms of
Service and the laws that apply to you. Keep the rate limits conservative, put
a real contact address in `USER_AGENT`, and don't publish personal data. If the
crawler reports `blocked`, find out why before running `clear-block`: being
blocked means the site does not want this traffic.
