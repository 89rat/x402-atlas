-- 0007_agent_history_index.sql
-- Personalization reads an agent's history by (agent_id, host) on the hot path
-- (every authenticated search + plan). Index it. No new tables — the agents,
-- agent_history, and agent_policies tables already exist.
--
-- Rename to the next sequential number if 0007 is taken.

CREATE INDEX IF NOT EXISTS idx_agent_history_agent_ts ON agent_history(agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_agent_history_agent_endpoint ON agent_history(agent_id, endpoint_url);
