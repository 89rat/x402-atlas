-- 0006_endpoint_settlement_terms.sql
-- Persist full settlement terms on each endpoint so /v1/search can return a
-- ready-to-pay quote WITHOUT a second live probe, and split the liveness signal
-- into probe-observed vs catalog/manifest-asserted.
--
-- NOTE: rename to the next sequential number in your migrations/ dir if 0006 is taken.
-- D1: `wrangler d1 migrations apply <DB>` (or `--local` first).

-- payTo (settlement address) and CAIP-2 network were previously only captured in
-- probe `terms` and the sellers table; endpoints never stored them, so search rows
-- could not carry a payable quote. Add them.
ALTER TABLE endpoints ADD COLUMN pay_to TEXT;    -- lowercase settlement (payTo) address
ALTER TABLE endpoints ADD COLUMN network TEXT;   -- CAIP-2, e.g. eip155:8453

-- Evidence tier behind `alive`. Makes the liveness signal honest:
--   'probe'    = a live 402 was directly observed this cycle
--   'catalog'  = asserted from bazaar/leaderboard catalog price (probe inconclusive)
--   'manifest' = self-reported via the service's /.well-known/x402.json
--   'none'     = never observed alive
ALTER TABLE endpoints ADD COLUMN evidence TEXT NOT NULL DEFAULT 'none';

CREATE INDEX IF NOT EXISTS idx_endpoints_payto ON endpoints(pay_to);
CREATE INDEX IF NOT EXISTS idx_endpoints_network ON endpoints(network);
CREATE INDEX IF NOT EXISTS idx_endpoints_evidence ON endpoints(evidence);

-- Backfill evidence for currently-alive endpoints from their most recent
-- successful probe's error signature (genuine probes leave error = NULL; the
-- catalog/manifest fallbacks stamp a descriptive error string on an ok=1 probe).
-- This makes `probed_alive` meaningful immediately, before the next probe cycle.
UPDATE endpoints
SET evidence = COALESCE((
  SELECT CASE
    WHEN p.error IS NULL                     THEN 'probe'
    WHEN p.error LIKE 'catalog-verified%'    THEN 'catalog'
    WHEN p.error LIKE '%manifest%'           THEN 'manifest'
    ELSE 'none'
  END
  FROM probes p
  WHERE p.endpoint_id = endpoints.id AND p.ok = 1
  ORDER BY p.ts DESC
  LIMIT 1
), 'none')
WHERE alive = 1;
