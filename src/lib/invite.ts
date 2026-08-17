/**
 * Signed propagation invitations (retention-spec §2.2.1-2.2.2).
 * Machine-verifiable economic proposals — no persuasion, only numbers.
 * Acceptance is rational if expected_surplus > counterparty threshold.
 */

export interface Invitation {
  schema_version: "atlas.invitation.v1";
  platform_identity: "x402-atlas";
  inviter: string;
  counterparty: string;
  /** Integer USDC units: estimated per-1000-call savings vs direct integration cost. */
  expected_savings_units: number;
  integration_cost_estimate_units: number;
  fee_schedule_version: number;
  expires_utc: string;
  openapi_spec_url: string;
  sandbox_endpoint: string;
  signature_algorithm: "HMAC-SHA256";
  signature: string;
}

export function canonicalInvitationFields(i: Omit<Invitation, "signature">): string {
  return [
    i.schema_version, i.platform_identity, i.inviter, i.counterparty,
    i.expected_savings_units, i.integration_cost_estimate_units,
    i.fee_schedule_version, i.expires_utc, i.sandbox_endpoint,
  ].join("|");
}

/** Expected surplus — the only rational acceptance criterion. */
export function expectedSurplusUnits(i: Pick<Invitation, "expected_savings_units" | "integration_cost_estimate_units">): number {
  return i.expected_savings_units - i.integration_cost_estimate_units;
}
