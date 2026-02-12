CREATE TABLE IF NOT EXISTS markets (
  provider TEXT NOT NULL,
  market_id TEXT NOT NULL,
  title TEXT NOT NULL,
  raw_category TEXT,
  normalized_category TEXT NOT NULL DEFAULT 'other',
  status TEXT NOT NULL DEFAULT 'open',
  open_time TIMESTAMPTZ,
  close_time TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, market_id)
);

CREATE TABLE IF NOT EXISTS outcomes (
  provider TEXT NOT NULL,
  market_id TEXT NOT NULL,
  outcome_id TEXT NOT NULL,
  label TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, market_id, outcome_id),
  FOREIGN KEY (provider, market_id) REFERENCES markets (provider, market_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS snapshots_1m (
  ts_minute TIMESTAMPTZ NOT NULL,
  provider TEXT NOT NULL,
  market_id TEXT NOT NULL,
  outcome_id TEXT NOT NULL,
  probability DOUBLE PRECISION NOT NULL,
  spread_pp DOUBLE PRECISION,
  volume_24h_usd DOUBLE PRECISION,
  liquidity_usd DOUBLE PRECISION,
  market_title TEXT NOT NULL,
  raw_category TEXT,
  normalized_category TEXT NOT NULL,
  PRIMARY KEY (ts_minute, provider, market_id, outcome_id),
  FOREIGN KEY (provider, market_id, outcome_id) REFERENCES outcomes (provider, market_id, outcome_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_snapshots_latest
  ON snapshots_1m (provider, market_id, outcome_id, ts_minute DESC);

CREATE TABLE IF NOT EXISTS deltas (
  ts_minute TIMESTAMPTZ NOT NULL,
  provider TEXT NOT NULL,
  market_id TEXT NOT NULL,
  outcome_id TEXT NOT NULL,
  delta_3m DOUBLE PRECISION,
  delta_9m DOUBLE PRECISION,
  delta_30m DOUBLE PRECISION,
  delta_1h DOUBLE PRECISION,
  delta_3h DOUBLE PRECISION,
  delta_6h DOUBLE PRECISION,
  delta_12h DOUBLE PRECISION,
  delta_24h DOUBLE PRECISION,
  PRIMARY KEY (ts_minute, provider, market_id, outcome_id),
  FOREIGN KEY (provider, market_id, outcome_id) REFERENCES outcomes (provider, market_id, outcome_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS classification_scores (
  ts_minute TIMESTAMPTZ NOT NULL,
  provider TEXT NOT NULL,
  market_id TEXT NOT NULL,
  outcome_id TEXT NOT NULL,
  opaque_score DOUBLE PRECISION NOT NULL,
  exogenous_score DOUBLE PRECISION NOT NULL,
  label TEXT NOT NULL,
  reason_tags TEXT[] NOT NULL DEFAULT '{}',
  model_version TEXT NOT NULL DEFAULT 'rules-v1',
  PRIMARY KEY (ts_minute, provider, market_id, outcome_id),
  FOREIGN KEY (provider, market_id, outcome_id) REFERENCES outcomes (provider, market_id, outcome_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alert_state (
  signature TEXT PRIMARY KEY,
  last_sent_at TIMESTAMPTZ NOT NULL
);
