-- Per-endpoint example request body so the prober can reach the 402 challenge
-- (services like code402 validate input before issuing the payment challenge).
ALTER TABLE endpoints ADD COLUMN probe_body TEXT;
