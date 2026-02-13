CREATE TABLE IF NOT EXISTS market_profiles (
  provider TEXT NOT NULL,
  market_id TEXT NOT NULL,
  anchor_type TEXT NOT NULL,
  insider_possible BOOLEAN NOT NULL,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  model_version TEXT NOT NULL DEFAULT 'anchor-rules-v1',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, market_id),
  FOREIGN KEY (provider, market_id) REFERENCES markets (provider, market_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_market_profiles_anchor_type
  ON market_profiles (anchor_type);

