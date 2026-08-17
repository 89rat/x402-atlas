-- x402 Atlas initial schema
-- Canonical seller identity = settlement address (lesson from tx 0xc647...672d)

CREATE TABLE IF NOT EXISTS sellers (
  address TEXT PRIMARY KEY,              -- lowercase settlement address
  chain TEXT NOT NULL DEFAULT 'eip155:8453', -- CAIP-2
  settled_volume_usdc TEXT NOT NULL DEFAULT '0', -- integer string, 6 decimals (exact math)
  settled_tx_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,                   -- slug
  base_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  categories TEXT NOT NULL DEFAULT '[]',      -- JSON array
  chains TEXT NOT NULL DEFAULT '[]',          -- JSON array of CAIP-2
  manifest_type TEXT,                         -- x402 | openapi | llms-txt | agent-card | none
  manifest_raw TEXT,                          -- last raw manifest (also snapshotted to R2)
  seller_address TEXT,                        -- settlement address if known
  submitter TEXT,                             -- 'seed' | 'submit' | 'bazaar'
  source_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (seller_address) REFERENCES sellers(address)
);
CREATE INDEX IF NOT EXISTS idx_services_seller ON services(seller_address);
CREATE INDEX IF NOT EXISTS idx_services_updated ON services(updated_at DESC);

CREATE TABLE IF NOT EXISTS endpoints (
  id TEXT PRIMARY KEY,                   -- slug
  service_id TEXT NOT NULL,
  path TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET',
  description TEXT DEFAULT '',
  paywall_scheme TEXT,                   -- exact | upto | ...
  price_min_units INTEGER,               -- USDC 6-decimal integer units (5000 = $0.005)
  price_max_units INTEGER,
  asset TEXT,                            -- e.g. eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
  alive INTEGER NOT NULL DEFAULT 0,      -- last probe result (0/1)
  last_probe_at INTEGER,
  last_latency_ms INTEGER,
  uptime_7d REAL NOT NULL DEFAULT 0.0,   -- rolling 7-day uptime fraction
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(service_id, path, method),
  FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_endpoints_alive ON endpoints(alive DESC, price_min_units ASC);

CREATE TABLE IF NOT EXISTS probes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  status INTEGER,                         -- HTTP status (402 expected)
  ok INTEGER NOT NULL,                    -- 1 = valid x402 paywall observed
  format TEXT,                            -- adapter: v1 | v2 | unknown
  price_min_units INTEGER,
  price_max_units INTEGER,
  latency_ms INTEGER,
  error TEXT,
  FOREIGN KEY (endpoint_id) REFERENCES endpoints(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_probes_endpoint_ts ON probes(endpoint_id, ts DESC);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_url TEXT NOT NULL,
  email TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS search_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  q TEXT NOT NULL,
  chain TEXT,
  price_max_units INTEGER,
  alive_only INTEGER NOT NULL DEFAULT 1,
  result_count INTEGER NOT NULL,
  zero_results INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS adapters_meta (
  format TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  spec_ref TEXT,
  conformance_pass INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
