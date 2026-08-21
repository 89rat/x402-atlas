-- 0008_agent_reputation.sql
-- Append-only, tamper-evident reputation chain per agent. Each row links to the
-- previous via prev_hash; UNIQUE(agent_id, seq) makes concurrent appends safe
-- (no forked chain, no dropped entry). Atlas signs the chain head into a
-- seller-verifiable credential — the network-wide credit rating.
--
-- Rename to the next sequential number if 0008 is taken.

CREATE TABLE IF NOT EXISTS agent_reputation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  seq INTEGER NOT NULL,             -- per-agent monotonic sequence
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,               -- 'PAID_OK' | 'PAID_FAIL'
  endpoint_host TEXT,               -- host the outcome was reported for
  amount_units INTEGER,             -- optional settled amount, USDC 6dp integer units
  prev_hash TEXT NOT NULL,          -- entry_hash of the previous entry ('GENESIS' for the first)
  entry_hash TEXT NOT NULL,         -- sha256(agent_id|seq|ts|kind|host|amount|prev_hash)
                                    -- HASH CONVENTION: NULL endpoint_host -> "", NULL amount_units -> 0
                                    -- in the hashed string (columns still store NULL). External
                                    -- re-verifiers must mirror this or hashes won't match.
  UNIQUE(agent_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_agent_reputation_agent ON agent_reputation(agent_id, seq DESC);
