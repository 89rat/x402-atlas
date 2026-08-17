/** Minimal MCP (Streamable HTTP) server exposing x402 Atlas search to AI agents. */
import type { Env } from "../lib/types";
import { search } from "../api/search";
import { unitsToUsd } from "../ingest/adapters";

interface McpRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "search_x402",
    description: "Search the live index of x402 pay-per-call API services. Returns verified liveness, measured prices (USDC), uptime, and endpoint URLs that agents can pay via HTTP 402.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "What you need, e.g. 'web search' or 'token prices'" },
        chain: { type: "string", description: "CAIP-2 network filter, e.g. eip155:8453 (Base)" },
        price_max_usd: { type: "number", description: "Max price per call in USD" },
        alive_only: { type: "boolean", description: "Only endpoints verified alive in the last probe (default true)" },
      },
      required: ["q"],
    },
  },
  {
    name: "get_ecosystem_stats",
    description: "Aggregate stats over the indexed x402 economy: service count, alive rate, median/min prices.",
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
    if (name === "search_x402") {
      const hits = await search(env, {
        q: String(args.q ?? ""),
        chain: args.chain ? String(args.chain) : undefined,
        priceMaxUnits: args.price_max_usd !== undefined ? Math.round(Number(args.price_max_usd) * 1e6) : undefined,
        aliveOnly: args.alive_only === undefined ? true : Boolean(args.alive_only),
        limit: 10,
      });
      const text =
        hits.length === 0
          ? "No matching x402 services found. Try broader terms or set alive_only=false."
          : hits
              .map(
                (h) =>
                  `- ${h.title} (${h.baseUrl}${h.endpointPath}) — $${h.priceMin ?? "?"}/call, alive=${h.alive}, uptime_7d=${(h.uptime7d * 100).toFixed(0)}%, ${h.description}`,
              )
              .join("\n");
      return reply({ content: [{ type: "text", text }] });
    }
    if (name === "get_ecosystem_stats") {
      const s = await env.DB.prepare(
        `SELECT COUNT(*) AS services FROM services`,
      ).first<{ services: number }>();
      const e = await env.DB.prepare(
        `SELECT COUNT(*) AS endpoints, SUM(alive) AS alive, AVG(price_min_units) AS medianish FROM endpoints WHERE last_probe_at IS NOT NULL`,
      ).first<{ endpoints: number; alive: number; medianish: number | null }>();
      return reply({
        content: [{
          type: "text",
          text: `services=${s?.services ?? 0} endpoints_probed=${e?.endpoints ?? 0} alive=${e?.alive ?? 0} avg_price=${e?.medianish != null ? "$" + unitsToUsd(Math.round(e.medianish)) : "n/a"}`,
        }],
      });
    }
    return err(-32602, `unknown tool: ${name}`);
  }
  return err(-32601, `method not found: ${body.method}`);
}
