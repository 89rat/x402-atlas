/**
 * MCP Factory — one dedicated MCP server per catalog service.
 *
 * Every service in the Atlas index automatically gets its own MCP endpoint at
 * POST /mcp/{serviceId}. One Worker deployment serves thousands of logical
 * MCP servers; the catalog grows, the factory follows. Each per-service MCP
 * exposes three tools: service_info, verify_liveness, pay_instructions.
 */
import type { Env } from "../lib/types";
import { unitsToUsd } from "../ingest/adapters";
import { sanitizeSellerText } from "../lib/sanitize";

interface ServiceRow {
  id: string; title: string | null; description: string; base_url: string;
  seller_address: string | null;
  alive: number; uptime_7d: number; price_min_units: number | null;
  path: string | null; last_probe_at: number | null; last_latency_ms: number | null;
  trust: number;
}

async function loadService(env: Env, serviceId: string): Promise<ServiceRow | null> {
  return env.DB.prepare(
    `SELECT s.id, s.title, s.description, s.base_url, s.seller_address,
            MAX(e.alive) alive, MAX(e.uptime_7d) uptime_7d,
            MIN(CASE WHEN e.price_min_units IS NOT NULL THEN e.price_min_units END) price_min_units,
            (SELECT e2.path FROM endpoints e2 WHERE e2.service_id = s.id AND e2.price_min_units IS NOT NULL LIMIT 1) path,
            MAX(e.last_probe_at) last_probe_at, MIN(e.last_latency_ms) last_latency_ms,
            COALESCE(MAX(sel.trust_score), 0) trust
     FROM services s
     LEFT JOIN endpoints e ON e.service_id = s.id
     LEFT JOIN sellers sel ON sel.address = s.seller_address
     WHERE s.id = ?1 GROUP BY s.id`,
  ).bind(serviceId).first<ServiceRow>();
}

function toolsFor(s: ServiceRow) {
  return [
    {
      name: "service_info",
      description: `Verified info for ${s.title ?? s.id}: probe-measured price, uptime, latency, on-chain seller trust.`,
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "verify_liveness",
      description: "Live re-check: probe the service's payable endpoint right now and return the observed 402 terms.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "pay_instructions",
      description: "Machine-readable instructions to pay this service per call via x402 (HTTP 402 / EIP-3009 USDC).",
      inputSchema: { type: "object", properties: {} },
    },
  ];
}

export async function handleFactoryMcp(env: Env, serviceId: string, req: Request): Promise<Response> {
  const s = await loadService(env, serviceId);
  if (!s) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: `unknown service '${serviceId}' — see GET /mcp-directory` } }), {
      status: 404, headers: { "content-type": "application/json" },
    });
  }
  const body = await req.json<{ jsonrpc: string; id?: unknown; method: string; params?: { name?: string } }>();
  const reply = (result: unknown) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, result } as const), {
      headers: { "content-type": "application/json" },
    });

  if (body.method === "initialize") {
    return reply({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: `x402-atlas-${s.id}`, version: "1.0.0" },
    });
  }
  if (body.method === "tools/list") return reply({ tools: toolsFor(s) });
  if (body.method === "tools/call") {
    const tool = body.params?.name ?? "";
    if (tool === "service_info") {
      return reply({ content: [{ type: "text", text: JSON.stringify({
        service: s.title ?? s.id, base_url: s.base_url,
        price_usd: s.price_min_units != null ? unitsToUsd(s.price_min_units) : null,
        verified_alive: s.alive === 1, uptime_7d_pct: Math.round(s.uptime_7d * 1000) / 10,
        latency_ms: s.last_latency_ms, seller_trust: `${s.trust}/100`,
        seller_address: s.seller_address,
        description: sanitizeSellerText(s.description, 200),
      }) }] });
    }
    if (tool === "verify_liveness") {
      const ep = s.path ?? "/";
      const { probeEndpoint } = await import("../ingest/prober");
      const r = await probeEndpoint(s.base_url, ep, "GET");
      return reply({ content: [{ type: "text", text: JSON.stringify({
        endpoint: s.base_url + ep, ok: r.ok, status: r.status, latency_ms: r.latencyMs,
        price_terms: r.terms ? { scheme: r.terms.scheme, usd: unitsToUsd(r.terms.priceUnits.min), network: r.terms.network, pay_to: r.terms.payTo } : null,
        error: r.error ?? null,
      }) }] });
    }
    if (tool === "pay_instructions") {
      const ep = s.path ?? "/";
      return reply({ content: [{ type: "text", text: JSON.stringify({
        step_1: `Send any request to ${s.base_url}${ep} — expect HTTP 402 with payment terms (x402)`,
        step_2: "Sign the EIP-3009 transferWithAuthorization for the quoted USDC amount with your agent wallet",
        step_3: "Retry with X-PAYMENT header — receive 200 + result",
        budget_hint: `measured price: $${s.price_min_units != null ? unitsToUsd(s.price_min_units) : "?"}/call · seller trust ${s.trust}/100`,
        policy_gate: "POST atlas.code402.dev/v1/plan for deterministic ACCEPT/REJECT/ESCALATE before signing",
      }) }] });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32602, message: `unknown tool ${tool}` } }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: `method not found: ${body.method}` } }), {
    status: 400, headers: { "content-type": "application/json" },
  });
}

/** GET /mcp-directory — the index of every per-service MCP endpoint. */
export async function mcpDirectory(env: Env): Promise<{ count: number; servers: { serviceId: string; title: string; url: string }[] }> {
  const rows = await env.DB.prepare(
    `SELECT s.id, COALESCE(s.title, s.id) title FROM services s
     JOIN endpoints e ON e.service_id = s.id
     GROUP BY s.id ORDER BY MAX(sel2.trust_score) DESC LIMIT 5000`,
  ).bind().all<{ id: string; title: string }>().catch(async () =>
    // fallback without the sel2 join if the query shape fails
    (await env.DB.prepare(`SELECT s.id, COALESCE(s.title, s.id) title FROM services s JOIN endpoints e ON e.service_id = s.id GROUP BY s.id LIMIT 5000`).all<{ id: string; title: string }>()));
  return {
    count: rows.results.length,
    servers: rows.results.map((r) => ({ serviceId: r.id, title: r.title, url: `https://atlas.code402.dev/mcp/${r.id}` })),
  };
}
