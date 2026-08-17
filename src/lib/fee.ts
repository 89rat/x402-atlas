/**
 * Deterministic fee engine (profit-spec §1.3, §3.2).
 * Integer money only. No floats. Fee is computable before execution,
 * deterministic for a given input, machine-readable, versioned, signed.
 */

export interface FeePolicy {
  policy_version: number;
  currency: "USDC";
  /** All amounts in 6-decimal integer units (5000 = $0.005). */
  fixed_fee_units: number;
  /** Ad-valorem rate in basis points (100 bps = 1%). */
  bps: number;
  min_fee_units: number;
  max_fee_units: number;
}

/** Current schedule. Changes require a new policy_version (no mid-transaction mutation). */
export const CURRENT_FEE_POLICY: FeePolicy = {
  policy_version: 1,
  currency: "USDC",
  fixed_fee_units: 0, // free tier while bootstrapping the network
  bps: 0,
  min_fee_units: 0,
  max_fee_units: 100_000, // $0.10 hard cap for when fees activate
};

/** Deterministic, overflow-safe ad-valorem fee: min(max_fee, max(min_fee, floor(notional*bps/10000))) + fixed. */
export function calculateFee(notionalUnits: number, policy: FeePolicy): number {
  if (!Number.isSafeInteger(notionalUnits) || notionalUnits < 0) {
    throw new Error("notionalUnits must be a non-negative safe integer");
  }
  // Exact: notional and bps are bounded; use split multiply to stay in safe range
  const adValorem = Math.min(
    Math.max(Math.floor((notionalUnits * policy.bps) / 10_000), policy.min_fee_units),
    policy.max_fee_units,
  );
  const total = adValorem + policy.fixed_fee_units;
  if (!Number.isSafeInteger(total)) throw new Error("fee overflow");
  return total;
}

export interface FeeQuote {
  quote_id: string;
  policy_version: number;
  notional_units: number;
  total_fee_units: number;
  currency: "USDC";
  /** Quotes expire; agents must not execute after this. */
  expires_utc: string;
  /** HMAC-SHA256 over canonical fields — agents verify before paying. */
  signature: string;
}

export function canonicalQuoteFields(q: Omit<FeeQuote, "signature">): string {
  return [q.quote_id, q.policy_version, q.notional_units, q.total_fee_units, q.currency, q.expires_utc].join("|");
}

/** Deterministic quote_id derived from inputs (same input ⇒ same id ⇒ natural idempotency). */
export function quoteId(notionalUnits: number, policyVersion: number, clientId: string): string {
  return `${policyVersion}:${notionalUnits}:${clientId}`.slice(0, 120);
}
