/**
 * Retention layer — the accrued-state moat.
 *
 * Makes a RETURNING authenticated agent's results cheaper to act on than a
 * first-timer's, using only data the agent already accrued with us:
 *   - its saved default policy (auto-applied filters + plan defaults), and
 *   - its own outcome ledger (what actually paid vs failed for THIS agent).
 *
 * Margin-neutral by construction: this reorders/annotates existing rows and
 * fills in omitted request fields. It never changes a price or grants a subsidy.
 * The value to the agent is lower decision cost + lower failure risk; the value
 * to us is a switching cost that grows with every call — not a discount.
 */
import type { Env } from "../lib/types";
import type { AgentCtx } from "./agents";
import type { SearchHit } from "./search";
import type { PolicyDecision } from "./policy";

/** Shape an agent is expected to store under the policy name "default". All fields optional. */
export interface DefaultPolicy {
  price_ceiling_usd?: number;
  min_uptime?: number;
  chain?: string; // CAIP-2
  escalation_threshold_usd?: number;
  budget_usd?: number;
  verified_only?: boolean;
  /** Opt-in: if this endpoint has failed this agent before, downgrade ACCEPT -> ESCALATE. */
  escalate_on_prior_fail?: boolean;
}

export function hostOf(u: string): string | null {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return null;
  }
}

export async function loadDefaultPolicy(env: Env, agent: AgentCtx, name = "default"): Promise<DefaultPolicy | null> {
  const row = await env.DB.prepare(`SELECT policy FROM agent_policies WHERE agent_id = ?1 AND name = ?2`)
    .bind(agent.id, name)
    .first<{ policy: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.policy) as DefaultPolicy;
  } catch {
    return null;
  }
}

/** This agent's accrued experience with one host. */
export interface HostExperience {
  paidOk: number; // real PAID_OK outcomes the agent reported
  paidFail: number; // real PAID_FAIL outcomes the agent reported
  accepted: number; // times the policy engine cleared it for this agent
  rejected: number; // times the policy engine rejected it for this agent
  lastDecision: string | null;
  lastReason: string | null;
  lastTs: number | null;
}

function blankExp(): HostExperience {
  return { paidOk: 0, paidFail: 0, accepted: 0, rejected: 0, lastDecision: null, lastReason: null, lastTs: null };
}

/** Aggregate this agent's last-90d history by host (decisions + reported outcomes). */
export async function experienceByHost(env: Env, agent: AgentCtx): Promise<Map<string, HostExperience>> {
  const rows = await env.DB.prepare(
    `SELECT endpoint_url, decision, reason_code, ts FROM agent_history
     WHERE agent_id = ?1 AND ts > ?2 ORDER BY ts ASC`,
  )
    .bind(agent.id, Date.now() - 90 * 24 * 3600_000)
    .all<{ endpoint_url: string; decision: string; reason_code: string; ts: number }>();

  const m = new Map<string, HostExperience>();
  for (const r of rows.results) {
    const h = hostOf(r.endpoint_url);
    if (!h) continue;
    const e = m.get(h) ?? blankExp();
    if (r.decision === "OUTCOME") {
      if (r.reason_code === "PAID_OK") e.paidOk++;
      else if (r.reason_code === "PAID_FAIL") e.paidFail++;
    } else if (r.decision === "ACCEPT") {
      e.accepted++;
    } else if (r.decision === "REJECT") {
      e.rejected++;
    }
    e.lastDecision = r.decision;
    e.lastReason = r.reason_code;
    e.lastTs = r.ts;
    m.set(h, e);
  }
  return m;
}

export interface PersonalizedHit extends SearchHit {
  /** This agent's accrued experience with the host, or null if none. */
  yourHistory: HostExperience | null;
  /** Deterministic score adjustment applied from that experience (audit trail). */
  personalAdjustment: number;
}

/**
 * Re-rank hits by THIS agent's accrued experience. Deterministic weights:
 *   proven-payable-for-you  >>  policy-cleared-before  >>  neutral  >>  failed-you-before
 * Nothing is hidden — deprioritized hits stay in the list, annotated, so a
 * temperature=0 caller can audit the ordering.
 */
export function personalizeHits(
  hits: SearchHit[],
  exp: Map<string, HostExperience>,
): { hits: PersonalizedHit[]; applied: { preferred: number; deprioritized: number } } {
  let preferred = 0;
  let deprioritized = 0;
  const out: PersonalizedHit[] = hits.map((h) => {
    const host = hostOf(h.baseUrl);
    const e = host ? exp.get(host) ?? null : null;
    let adj = 0;
    if (e) {
      adj += e.paidOk * 40; // it actually paid for you
      adj -= e.paidFail * 80; // it failed you — strong avoid
      adj += e.accepted * 5; // your own policy cleared it before
      if (adj > 0) preferred++;
      else if (adj < 0) deprioritized++;
    }
    return { ...h, yourHistory: e, personalAdjustment: adj, score: h.score + adj };
  });
  out.sort((a, b) => b.score - a.score);
  return { hits: out, applied: { preferred, deprioritized } };
}

/** Merge saved policy defaults UNDER the explicit request body (explicit args always win). */
export function mergePolicyDefaults(
  policy: DefaultPolicy | null,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!policy) return body;
  const defaults: Record<string, unknown> = {};
  if (policy.price_ceiling_usd != null) defaults.price_ceiling_usd = policy.price_ceiling_usd;
  if (policy.min_uptime != null) defaults.min_uptime = policy.min_uptime;
  if (policy.escalation_threshold_usd != null) defaults.escalation_threshold_usd = policy.escalation_threshold_usd;
  if (policy.budget_usd != null) defaults.budget_usd = policy.budget_usd;
  return { ...defaults, ...body };
}

/**
 * Opt-in safety: if the agent's own outcome ledger shows this host failed it more
 * often than it succeeded, and the policy engine would ACCEPT, downgrade to
 * ESCALATE. Deterministic and only when the agent set escalate_on_prior_fail.
 */
export function applyOutcomeDowngrade(
  decision: PolicyDecision,
  exp: HostExperience | null,
  policy: DefaultPolicy | null,
): PolicyDecision {
  if (
    policy?.escalate_on_prior_fail &&
    exp &&
    exp.paidFail > exp.paidOk &&
    decision.decision === "ACCEPT"
  ) {
    return {
      ...decision,
      decision: "ESCALATE",
      reason_code: "PRIOR_OUTCOME_FAILURE",
      human_summary: `Requires review: this endpoint failed you ${exp.paidFail}× (vs ${exp.paidOk} success) in your last 90 days.`,
    };
  }
  return decision;
}

/**
 * Append a real pay outcome. Two writes, both awaited (money-path durability):
 *   1. agent_history — the private behavior log that powers personalization.
 *   2. agent_reputation — the tamper-evident, seller-verifiable credit chain.
 */
export async function recordOutcome(
  env: Env,
  agent: AgentCtx,
  o: { endpoint_url: string; ok: boolean; amountUnits?: number | null },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO agent_history (agent_id, ts, endpoint_url, decision, reason_code, price_usd)
     VALUES (?1, ?2, ?3, 'OUTCOME', ?4, NULL)`,
  )
    .bind(agent.id, Date.now(), o.endpoint_url, o.ok ? "PAID_OK" : "PAID_FAIL")
    .run();

  const { appendReputation } = await import("../lib/reputation");
  await appendReputation(env, agent.id, {
    kind: o.ok ? "PAID_OK" : "PAID_FAIL",
    host: hostOf(o.endpoint_url),
    amountUnits: o.amountUnits ?? null,
  });
}
