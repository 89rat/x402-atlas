-- Agent retention state (spec §2.1.2: accumulated platform state = lawful switching cost)
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  api_key_hash TEXT NOT NULL UNIQUE,   -- SHA-256 of bearer key; raw key never stored
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  policy TEXT NOT NULL,                -- JSON: price_ceiling_usd, min_uptime, budget_usd, escalation_threshold_usd...
  created_at INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  UNIQUE(agent_id, name)
);

CREATE TABLE IF NOT EXISTS agent_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  endpoint_url TEXT NOT NULL,
  decision TEXT NOT NULL,               -- ACCEPT | REJECT | ESCALATE
  reason_code TEXT NOT NULL,
  price_usd TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_history ON agent_history(agent_id, ts DESC);
