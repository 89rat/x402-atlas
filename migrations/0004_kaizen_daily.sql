-- Daily kaizen metrics: one row per UTC day, written by the cron.
CREATE TABLE IF NOT EXISTS metrics_daily (
  day TEXT PRIMARY KEY,            -- YYYY-MM-DD
  ts INTEGER NOT NULL,
  services INTEGER NOT NULL,
  endpoints_probed INTEGER NOT NULL,
  alive INTEGER NOT NULL,
  zero_result_queries INTEGER NOT NULL,
  searches INTEGER NOT NULL,
  raw_settled_units INTEGER NOT NULL,
  sybil_adjusted_units INTEGER NOT NULL,
  top_seller_address TEXT
);
