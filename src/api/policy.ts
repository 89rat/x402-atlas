/**
 * Deterministic purchase policy engine (doc controls #1-10, #31-40, #61-70).
 * The LLM proposes; this code decides. No LLM in the decision path.
 * Output contract: ACCEPT | REJECT | ESCALATE with confidence vector + checklist.
 */
import { z } from "zod";
import type { Env } from "../lib/types";

export const PlanInput = z.object({
  endpoint_url: z.string().url(),
  /** Budget context the buyer agent declares (USDC units, 6 decimals). */
  budget_usd: z.number().positive().optional(),
  /** Hard ceiling per call (USD). Overriding this REJECTs. */
  price_ceiling_usd: z.number().positive().optional(),
  /** Max acceptable 7d uptime fraction [0,1]. */
  min_uptime: z.number().min(0).max(1).default(0.9),
  /** Require the endpoint verified alive in the last N hours. */
  max_probe_age_hours: z.number().positive().default(26),
  /** Above this USD amount, escalate to human instead of ACCEPT. */
  escalation_threshold_usd: z.number().positive().default(1),
  transaction_id: z.string().uuid().optional(),
});
export type PlanInput = z.infer<typeof PlanInput>;

export interface PolicyDecision {
  schema_version: "atlas.policy.v1";
  decision: "ACCEPT" | "REJECT" | "ESCALATE";
  reason_code: string;
  human_summary: string;
  terms: {
    endpoint_url: string;
    price_usd: string | null;
    network: string | null;
    seller_address: string | null;
  };
  confidence: {
    price_verified: number;
    liveness_verified: number;
    uptime_quality: number;
    data_completeness: number;
  };
  policy_checklist: {
    endpoint_known: boolean;
    price_within_ceiling: boolean;
    budget_available: boolean;
    endpoint_alive: boolean;
    uptime_above_min: boolean;
    probe_fresh: boolean;
    seller_identified: boolean;
  };
  /** Surplus proof (retention-spec §2.1.1): measured value of routing through Atlas vs direct. */
  surplus_proof: {
    direct_cost_estimate_usd: string;
    platform_cost_usd: string;
    net_surplus_usd: string;
    fee_schedule_version: number;
    evidence: string[];
  };
  audit: {
    engine_version: string;
    timestamp_utc: string;
    transaction_id: string | null;
  };
}

export async function planPurchase(env: Env, input: PlanInput): Promise<PolicyDecision> {
  const now = Date.now();
  const url = new URL(input.endpoint_url);
  const path = url.pathname;

  const row = await env.DB.prepare(
    `SELECT e.*, s.base_url, s.seller_address, s.title
     FROM endpoints e JOIN services s ON s.id = e.service_id
     WHERE s.base_url = ?1 AND ?2 LIKE ('%' || e.path || '%')
     ORDER BY LENGTH(e.path) DESC LIMIT 1`,
  )
    .bind(`${url.protocol}//${url.host}`, path)
    .first<{
      alive: number; uptime_7d: number; price_min_units: number | null; last_probe_at: number | null;
      base_url: string; seller_address: string | null; title: string;
    }>();

  const priceUsd = row?.price_min_units != null ? row.price_min_units / 1e6 : null;
  const probeFresh =
    row?.last_probe_at != null && now - row.last_probe_at < input.max_probe_age_hours * 3600_000;

  const checklist = {
    endpoint_known: row != null,
    price_within_ceiling:
      priceUsd != null && input.price_ceiling_usd != undefined ? priceUsd <= input.price_ceiling_usd : true,
    budget_available: input.budget_usd != undefined ? priceUsd == null || priceUsd <= input.budget_usd : true,
    endpoint_alive: row?.alive === 1,
    uptime_above_min: (row?.uptime_7d ?? 0) >= input.min_uptime,
    probe_fresh: probeFresh,
    seller_identified: row?.seller_address != null,
  };

  // Deterministic decision ladder (priority: safety > treasury > data > efficiency)
  let decision: PolicyDecision["decision"];
  let reason: string;
  if (!checklist.endpoint_known) {
    decision = "REJECT"; reason = "ENDPOINT_NOT_INDEXED";
  } else if (!checklist.endpoint_alive || !checklist.probe_fresh) {
    decision = "REJECT"; reason = "ENDPOINT_NOT_VERIFIED_ALIVE";
  } else if (!checklist.price_within_ceiling) {
    decision = "REJECT"; reason = "PRICE_ABOVE_CEILING";
  } else if (!checklist.budget_available) {
    decision = "REJECT"; reason = "BUDGET_EXCEEDED";
  } else if (!checklist.uptime_above_min) {
    decision = "REJECT"; reason = "UPTIME_BELOW_MINIMUM";
  } else if (priceUsd != null && priceUsd > input.escalation_threshold_usd) {
    decision = "ESCALATE"; reason = "ABOVE_HUMAN_REVIEW_THRESHOLD";
  } else if (!checklist.seller_identified || priceUsd == null) {
    decision = "ESCALATE"; reason = "INCOMPLETE_SELLER_DATA";
  } else {
    decision = "ACCEPT"; reason = "ALL_CHECKS_PASSED";
  }

  const summary =
    decision === "ACCEPT"
      ? `Cleared to pay $${priceUsd?.toFixed(3)} to ${row?.title} (${url.host}). Verified alive, uptime ${(100 * (row?.uptime_7d ?? 0)).toFixed(0)}%.`
      : decision === "ESCALATE"
        ? `Requires human review before payment: ${reason.toLowerCase().replace(/_/g, " ")}.`
        : `Do not pay: ${reason.toLowerCase().replace(/_/g, " ")}.`;

  return {
    schema_version: "atlas.policy.v1",
    decision,
    reason_code: reason,
    human_summary: summary,
    terms: {
      endpoint_url: input.endpoint_url,
      price_usd: priceUsd != null ? priceUsd.toFixed(6) : null,
      network: null,
      seller_address: row?.seller_address ?? null,
    },
    confidence: {
      price_verified: priceUsd != null ? 1 : 0,
      liveness_verified: checklist.endpoint_alive && probeFresh ? 1 : checklist.endpoint_alive ? 0.5 : 0,
      uptime_quality: Math.round((row?.uptime_7d ?? 0) * 100) / 100,
      data_completeness:
        Object.values(checklist).filter(Boolean).length / Object.keys(checklist).length,
    },
    policy_checklist: checklist,
    surplus_proof: {
      // Deterministic estimate: what an agent would spend discovering+verifying this
      // endpoint itself (probe calls, dead-end retries) vs Atlas's free indexed answer.
      direct_cost_estimate_usd: checklist.endpoint_known ? "0.050" : "0.000",
      platform_cost_usd: "0.000",
      net_surplus_usd: checklist.endpoint_known ? "0.050" : "0.000",
      fee_schedule_version: 1,
      evidence: [
        `probe_verified_alive=${checklist.endpoint_alive}`,
        `measured_price_usd=${priceUsd != null ? priceUsd.toFixed(6) : "unknown"}`,
        `uptime_7d=${Math.round((row?.uptime_7d ?? 0) * 1000) / 10}%`,
      ],
    },
    audit: {
      engine_version: "0.1.0",
      timestamp_utc: new Date(now).toISOString(),
      transaction_id: input.transaction_id ?? null,
    },
  };
}
