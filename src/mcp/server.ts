/** Minimal MCP (Streamable HTTP) server exposing x402 Atlas search to AI agents.
 *  Supersedes the settlement-terms-only version: also personalizes results for an
 *  authenticated (Bearer agent key) caller using its saved policy + outcome ledger. */
import type { Env } from "../lib/types";
import { search } from "../api/search";
import { unitsToUsd } from "../ingest/adapters";
import { authenticate, recordDecision } from "../api/agents";
import {
  loadDefaultPolicy,
  mergePolicyDefaults,
  experienceByHost,
  personalizeHits,
  applyOutcomeDowngrade,
  recordOutcome,
  hostOf,
} from "../api/personalize";
import { issueCredential } from "../lib/reputation";

interface McpRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "search_x402",
    description:
      "Search the live index of x402 pay-per-call API services. Each result carries ready-to-pay settlement terms (payTo, asset, CAIP-2 network, exact integer USDC amount) and an honest liveness tier — 'probe' (a live 402 was directly observed) vs 'catalog'/'manifest' (asserted). Send Authorization: Bearer <agent key> to auto-apply your saved policy and rank by YOUR own pay history.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "What you need, e.g. 'web search' or 'token prices'" },
        chain: { type: "string", description: "CAIP-2 network filter, e.g. eip155:8453 (Base)" },
        price_max_usd: { type: "number", description: "Max price per call in USD" },
        alive_only: { type: "boolean", description: "Only endpoints with any liveness evidence (default true)" },
        verified_only: { type: "boolean", description: "Only DIRECTLY probe-observed live 402s (default false)" },
      },
      required: ["q"],
    },
  },
  {
    name: "plan_purchase",
    description:
      "Deterministic purchase gate. Returns ACCEPT / REJECT / ESCALATE with a policy checklist. Authenticated agents get their saved policy defaults applied automatically and their own history at the endpoint attached. Call this BEFORE paying any x402 endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint_url: { type: "string", description: "Full URL of the payable endpoint" },
        budget_usd: { type: "number", description: "Total remaining budget in USD" },
        price_ceiling_usd: { type: "number", description: "Max acceptable price per call" },
        escalation_threshold_usd: { type: "number", description: "Above this price, ESCALATE (default 1)" },
        min_uptime: { type: "number", description: "Min 7d uptime fraction 0-1 (default 0.9)" },
      },
      required: ["endpoint_url"],
    },
  },
  {
    name: "report_outcome",
    description:
      "Close the loop: after you pay (or fail to pay) an endpoint, report ok=true/false (and amount_units if you want it counted toward settled volume). Written to YOUR private ledger AND your tamper-evident reputation chain — improves future results and raises your seller-verifiable reputation. Requires Authorization: Bearer <agent key>.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint_url: { type: "string", description: "The endpoint you paid" },
        ok: { type: "boolean", description: "true if the paid call succeeded, false if it failed" },
        amount_units: { type: "integer", description: "Optional: settled amount in USDC 6-decimal integer units, counted toward your reputation volume" },
      },
      required: ["endpoint_url", "ok"],
    },
  },
  {
    name: "get_my_reputation",
    description:
      "Return your signed, seller-verifiable reputation credential (score, settled counts, chain head + Atlas HMAC). Portable: present it to sellers, or they fetch GET /v1/agent/{id}/reputation and verify via POST /v1/reputation/verify. Requires Authorization: Bearer <agent key>.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_ecosystem_stats",
    description: "Aggregate stats over the indexed x402 economy: service count, alive rate (any-evidence and probe-observed), median/min prices.",
    inputSchema: { type: "object", properties: {} },
  },
];

export async function handleMcp(env: Env, req: Request): Promise<Response> {
  const body = await req.json<McpRequest>();
  const reply = (result: unknown, id: McpRequest["id"] = body.id) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id, result } as const), {
      headers: { "content-type": "application/json" },
    });
  const err = (code: number, message: string) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, error: { code, message } } as const), {
      status: 400,
      headers: { "content-type": "application/json" },
    });

  if (body.method === "initialize") {
    return reply({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "x402-atlas", version: "0.1.0" },
    });
  }
  if (body.method === "tools/list") return reply({ tools: TOOLS });
  if (body.method === "tools/call") {
    const name = body.params?.name as string;
    const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
    const agent = await authenticate(env, req); // null if anonymous

    if (name === "search_x402") {
      const pol = agent ? await loadDefaultPolicy(env, agent) : null;
      const hits = await search(env, {
        q: String(args.q ?? ""),
        chain: args.chain ? String(args.chain) : pol?.chain,
        priceMaxUnits:
          args.price_max_usd !== undefined
            ? Math.round(Number(args.price_max_usd) * 1e6)
            : pol?.price_ceiling_usd != null
              ? Math.round(pol.price_ceiling_usd * 1e6)
              : undefined,
        aliveOnly: args.alive_only === undefined ? true : Boolean(args.alive_only),
        verifiedOnly: args.verified_only !== undefined ? Boolean(args.verified_only) : Boolean(pol?.verified_only),
        limit: 10,
      });

      let ranked = hits.map((h) => ({ ...h, yourHistory: null as unknown, personalAdjustment: 0 }));
      let personalNote = "";
      if (agent) {
        const exp = await experienceByHost(env, agent);
        const p = personalizeHits(hits, exp);
        ranked = p.hits;
        personalNote = ` [personalized: ${p.applied.preferred} preferred, ${p.applied.deprioritized} deprioritized]`;
      }

      const text =
        ranked.length === 0
          ? "No matching x402 services found. Try broader terms or set alive_only=false."
          : ranked
              .map((h) => {
                const s = h.settlement;
                const pay = s
                  ? `pay ${s.amountUnits} units (${s.assetDecimals}dp USDC)${s.payTo ? ` to ${s.payTo}` : ""}${s.network ? ` on ${s.network}` : ""}`
                  : "terms: unknown";
                const hist =
                  h.yourHistory && (h.yourHistory as { paidOk: number; paidFail: number }).paidOk +
                    (h.yourHistory as { paidOk: number; paidFail: number }).paidFail >
                    0
                    ? ` · your history: ${(h.yourHistory as { paidOk: number }).paidOk}✓/${(h.yourHistory as { paidFail: number }).paidFail}✗`
                    : "";
                return `- ${h.title} (${h.baseUrl}${h.endpointPath}) — $${h.priceMin ?? "?"}/call · liveness=${h.evidence}${h.probedAlive ? " (probed)" : ""} · uptime_7d=${(h.uptime7d * 100).toFixed(0)}% · ${pay}${hist} · ${h.description}`;
              })
              .join("\n") + personalNote;
      return reply({ content: [{ type: "text", text }], structuredContent: { results: ranked } });
    }

    if (name === "plan_purchase") {
      const { planPurchase, PlanInput: PI } = await import("../api/policy");
      const pol = agent ? await loadDefaultPolicy(env, agent) : null;
      const merged = mergePolicyDefaults(pol, args);
      const parsed = PI.safeParse(merged);
      if (!parsed.success) {
        return reply({ content: [{ type: "text", text: `INVALID_INPUT: ${JSON.stringify(parsed.error.issues)}` }] });
      }
      let d = await planPurchase(env, parsed.data);
      let histNote = "";
      if (agent) {
        const exp = await experienceByHost(env, agent);
        const host = hostOf(parsed.data.endpoint_url);
        const e = host ? exp.get(host) ?? null : null;
        d = applyOutcomeDowngrade(d, e, pol);
        if (e) histNote = ` your_history=${e.paidOk}✓/${e.paidFail}✗`;
        await recordDecision(env, agent, {
          endpoint_url: d.terms.endpoint_url,
          decision: d.decision,
          reason_code: d.reason_code,
          price_usd: d.terms.price_usd,
        });
      }
      return reply({
        content: [{
          type: "text",
          text: `${d.decision} (${d.reason_code}) — ${d.human_summary} price=${d.terms.price_usd ?? "?"}${histNote} checklist=${JSON.stringify(d.policy_checklist)}`,
        }],
      });
    }

    if (name === "report_outcome") {
      if (!agent) {
        return reply({ content: [{ type: "text", text: "UNAUTHENTICATED: register at POST /v1/agent/register and send Authorization: Bearer <key> to build your history." }] });
      }
      const url = typeof args.endpoint_url === "string" ? args.endpoint_url : "";
      if (!/^https?:\/\//.test(url)) {
        return reply({ content: [{ type: "text", text: "INVALID_INPUT: endpoint_url (http/https) required" }] });
      }
      const amountUnits = Number.isFinite(Number(args.amount_units)) ? Math.round(Number(args.amount_units)) : null;
      await recordOutcome(env, agent, { endpoint_url: url, ok: Boolean(args.ok), amountUnits });
      const cred = await issueCredential(env, agent.id);
      return reply({ content: [{ type: "text", text: `recorded ${args.ok ? "PAID_OK" : "PAID_FAIL"} for ${hostOf(url) ?? url}. Reputation now: score=${cred.summary.reputation_score} (${cred.summary.settled_ok}✓/${cred.summary.settled_fail}✗, ${cred.summary.distinct_hosts} hosts).` }] });
    }

    if (name === "get_my_reputation") {
      if (!agent) {
        return reply({ content: [{ type: "text", text: "UNAUTHENTICATED: register at POST /v1/agent/register and send Authorization: Bearer <key>." }] });
      }
      const cred = await issueCredential(env, agent.id);
      return reply({
        content: [{
          type: "text",
          text: `reputation_score=${cred.summary.reputation_score} settled_ok=${cred.summary.settled_ok} settled_fail=${cred.summary.settled_fail} distinct_hosts=${cred.summary.distinct_hosts} volume_units=${cred.summary.volume_units} head=${cred.summary.head_seq}:${cred.summary.head_hash.slice(0, 12)}… signature=${cred.signature.slice(0, 16)}…`,
        }],
        structuredContent: { credential: cred },
      });
    }

    if (name === "get_ecosystem_stats") {
      const s = await env.DB.prepare(`SELECT COUNT(*) AS services FROM services`).first<{ services: number }>();
      const e = await env.DB.prepare(
        `SELECT COUNT(*) AS endpoints, SUM(alive) AS alive,
                SUM(CASE WHEN evidence = 'probe' AND alive = 1 THEN 1 ELSE 0 END) AS probed_alive,
                AVG(price_min_units) AS medianish
         FROM endpoints WHERE last_probe_at IS NOT NULL`,
      ).first<{ endpoints: number; alive: number; probed_alive: number; medianish: number | null }>();
      return reply({
        content: [{
          type: "text",
          text: `services=${s?.services ?? 0} endpoints_probed=${e?.endpoints ?? 0} alive_any_evidence=${e?.alive ?? 0} probe_observed_alive=${e?.probed_alive ?? 0} avg_price=${e?.medianish != null ? "$" + unitsToUsd(Math.round(e.medianish)) : "n/a"}`,
        }],
      });
    }
    return err(-32602, `unknown tool: ${name}`);
  }
  return err(-32601, `method not found: ${body.method}`);
}
