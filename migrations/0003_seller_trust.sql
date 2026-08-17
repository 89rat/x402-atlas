-- On-chain seller evidence (from agent402 leaderboard scans of transferWithAuthorization settlements)
ALTER TABLE sellers ADD COLUMN unique_buyers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sellers ADD COLUMN trust_score INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_sellers_trust ON sellers(trust_score DESC);
