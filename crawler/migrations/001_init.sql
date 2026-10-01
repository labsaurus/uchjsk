-- Known apps + scheduling state. One row per package.
CREATE TABLE IF NOT EXISTS apps (
  package_name      TEXT PRIMARY KEY,
  status            TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'active', 'not_found', 'removed', 'failed', 'disallowed')),
  priority          INTEGER NOT NULL DEFAULT 0,
  discovered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  discovered_from   TEXT,
  next_crawl_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at   TIMESTAMPTZ,
  last_success_at   TIMESTAMPTZ,
  last_changed_at   TIMESTAMPTZ,
  recrawl_hours     REAL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  not_found_strikes INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  lease_owner       BIGINT,
  lease_until       TIMESTAMPTZ,
  content_hash      TEXT,

  -- latest parsed data
  title             TEXT,
  developer         TEXT,
  developer_url     TEXT,
  description       TEXT,
  icon_url          TEXT,
  category          TEXT,
  content_rating    TEXT,
  rating            REAL,
  rating_count      BIGINT,
  price             NUMERIC(12, 2),
  currency          TEXT,
  installs          TEXT,
  min_installs      BIGINT,
  version           TEXT,
  store_updated_at  TIMESTAMPTZ,
  released_at       TEXT,
  contains_ads      BOOLEAN
);

-- Work selection: due apps, highest priority first.
CREATE INDEX IF NOT EXISTS apps_due_idx ON apps (priority DESC, next_crawl_at)
  WHERE status NOT IN ('removed', 'disallowed');
CREATE INDEX IF NOT EXISTS apps_last_attempt_idx ON apps (last_attempt_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS apps_lease_idx ON apps (lease_owner) WHERE lease_owner IS NOT NULL;

-- Time series: one row each time an app's tracked fields change.
CREATE TABLE IF NOT EXISTS app_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  package_name  TEXT NOT NULL REFERENCES apps(package_name) ON DELETE CASCADE,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_hash  TEXT NOT NULL,
  rating        REAL,
  rating_count  BIGINT,
  installs      TEXT,
  min_installs  BIGINT,
  price         NUMERIC(12, 2),
  currency      TEXT,
  version       TEXT,
  store_updated_at TIMESTAMPTZ,
  data          JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS app_snapshots_pkg_idx ON app_snapshots (package_name, captured_at DESC);

-- One row per crawl run; doubles as the persistent checkpoint.
CREATE TABLE IF NOT EXISTS crawl_runs (
  id             BIGSERIAL PRIMARY KEY,
  run_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  mode           TEXT NOT NULL CHECK (mode IN ('incremental', 'full')),
  status         TEXT NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running', 'interrupted', 'paused', 'blocked', 'completed', 'failed')),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  budget         INTEGER NOT NULL,
  processed      INTEGER NOT NULL DEFAULT 0,
  succeeded      INTEGER NOT NULL DEFAULT 0,
  not_found      INTEGER NOT NULL DEFAULT 0,
  failed         INTEGER NOT NULL DEFAULT 0,
  changed        INTEGER NOT NULL DEFAULT 0,
  discovered     INTEGER NOT NULL DEFAULT 0,
  last_package   TEXT,
  throttle_state JSONB,
  breaker_state  JSONB,
  http_stats     JSONB,
  message        TEXT
);
CREATE INDEX IF NOT EXISTS crawl_runs_date_idx ON crawl_runs (run_date DESC, id DESC);

-- Global key/value state (e.g. hard-block cooldown that outlives a run).
CREATE TABLE IF NOT EXISTS crawler_state (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
