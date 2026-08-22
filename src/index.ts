/** x402 Atlas — main Worker entry.
 *  Integrated build: settlement terms + honest liveness (Layer 1),
 *  accrued-state personalization (Layer 2), reputation rail (Layer 3). */
import type { Env, QueueMessage } from "./lib/types";
import { ensureSeeds, ingestService, runProbe } from "./ingest/pipeline";
import { search } from "./api/search";
import { planPurchase, PlanInput } from "./api/policy";
import { hmacSign } from "./lib/sign";
import { handleMcp } from "./mcp/server";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });

/** Timing-safe admin-token comparison (workers-best-practices security rule). */
async function tokenOk(env: { ADMIN_TOKEN?: string }, provided: string | null): Promise<boolean> {
  if (!env.ADMIN_TOKEN || !provided) return !env.ADMIN_TOKEN && !provided;
  const a = new TextEncoder().encode(env.ADMIN_TOKEN);
  const b = new TextEncoder().encode(provided);
  if (a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** Token-bucket rate limit per client IP (KV, 60s window). Public APIs only. */
async function rateLimited(env: Env, req: Request, path: string): Promise<boolean> {
  if (!path.startsWith("/v1/") && path !== "/mcp") return false;
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const key = `rl:${ip}:${Math.floor(Date.now() / 60_000)}`;
  const n = Number((await env.CACHE.get(key)) ?? 0) + 1;
  await env.CACHE.put(key, String(n), { expirationTtl: 90 });
  return n > 120; // 120 req/min per IP
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/healthz") {
      const db = await env.DB.prepare(`SELECT 1 AS ok`).first();
      return json({ status: db ? "ok" : "degraded", ts: new Date().toISOString() });
    }
    if (path === "/security.txt" || path === "/.well-known/security.txt") {
      return new Response(
        `Contact: mailto:security@code402.dev\nExpires: 2027-08-18T00:00:00Z\nPreferred-Languages: en\nCanonical: https://atlas.code402.dev/.well-known/security.txt\n`,
        { headers: { "content-type": "text/plain" } },
      );
    }

    if (await rateLimited(env, req, path)) {
      return json({ error: "RATE_LIMITED", window: "60s", limit: 120 }, 429);
    }

    if (path === "/mcp" && req.method === "POST") return handleMcp(env, req);

    // MCP Factory: one MCP server per catalog service (POST /mcp/{serviceId})
    if (path.startsWith("/mcp/") && req.method === "POST" && !path.includes(".")) {
      const { handleFactoryMcp } = await import("./mcp/factory");
      return handleFactoryMcp(env, decodeURIComponent(path.slice("/mcp/".length).replace(/\/+$/, "")), req);
    }
    if (path === "/mcp-directory") {
      const { mcpDirectory } = await import("./mcp/factory");
      const d = await mcpDirectory(env);
      if (url.searchParams.get("format") === "html") {
        const rows = d.servers.slice(0, 500).map((sv) => `<tr><td><a href="/services/${sv.serviceId}">${sv.title}</a></td><td><code>POST /mcp/${sv.serviceId}</code></td></tr>`).join("\n");
        return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>${d.count} MCP servers — x402 Atlas</title><meta name="description" content="Every indexed x402 service has its own dedicated MCP server: verified pricing, live probes, pay instructions. One endpoint per service, auto-generated."></head><body style="font-family:system-ui;max-width:800px;margin:2rem auto"><h1>${d.count} dedicated MCP servers</h1><p>Every service in the Atlas index automatically gets its own MCP endpoint. Catalog grows → servers grow. <a href="?format=json">JSON</a> · <a href="/directory.md">full directory</a></p><table style="width:100%;border-collapse:collapse">${rows}</table></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return json(d);
    }

    // ---- Search: settlement terms + honest liveness + per-agent personalization ----
    if (path === "/v1/search") {
      const q = url.searchParams.get("q") ?? "";
      let chain = url.searchParams.get("chain") ?? undefined;
      const priceMaxUsd = url.searchParams.get("price_max_usd");
      const aliveOnly = url.searchParams.get("alive_only") !== "false";
      let verifiedOnly = url.searchParams.get("verified_only") === "true";
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 25), 100);

      // Retention layer: authenticated agents get their saved policy applied and
      // results ranked by their own pay history. The anonymous path is unchanged.
      const { authenticate } = await import("./api/agents");
      const agent = await authenticate(env, req);
      let priceMaxUnits = priceMaxUsd !== null ? Math.round(Number(priceMaxUsd) * 1e6) : undefined;
      let policyApplied = false;
      if (agent) {
        const { loadDefaultPolicy } = await import("./api/personalize");
        const pol = await loadDefaultPolicy(env, agent);
        if (pol) {
          policyApplied = true;
          if (chain === undefined && pol.chain) chain = pol.chain;
          if (priceMaxUnits === undefined && pol.price_ceiling_usd != null) priceMaxUnits = Math.round(pol.price_ceiling_usd * 1e6);
          if (!verifiedOnly && pol.verified_only) verifiedOnly = true;
        }
      }

      const cacheKey = `search:${q}:${chain ?? ""}:${priceMaxUnits ?? ""}:${aliveOnly}:${verifiedOnly}:${limit}`;
      // Shared cache is anonymous-only; personalized responses are never cached under it.
      if (!agent) {
        const cached = await env.CACHE.get(cacheKey, "json");
        if (cached) return json(cached);
      }

      const hits = await search(env, { q, chain, priceMaxUnits, aliveOnly, verifiedOnly, limit });

      // Kaizen telemetry: log every search (incl. zero-result queries → demand signal)
      ctx.waitUntil(
        env.DB.prepare(
          `INSERT INTO search_log (ts, q, chain, price_max_units, alive_only, result_count, zero_results) VALUES (?1,?2,?3,?4,?5,?6,?7)`,
        ).bind(Date.now(), q, chain ?? null, priceMaxUnits ?? null, aliveOnly ? 1 : 0, hits.length, hits.length === 0 ? 1 : 0).run(),
      );

      const totalRow = await env.DB.prepare(
        `SELECT COUNT(DISTINCT s.id) n FROM services s LEFT JOIN endpoints e ON e.service_id = s.id WHERE (?2 = 0 OR e.alive = 1)`,
      ).bind(aliveOnly ? 1 : 0, aliveOnly ? 1 : 0).first<{ n: number }>();

      let results: unknown = hits;
      let personalization: Record<string, unknown> | undefined;
      if (agent) {
        const { experienceByHost, personalizeHits } = await import("./api/personalize");
        const exp = await experienceByHost(env, agent);
        const p = personalizeHits(hits, exp);
        results = p.hits;
        personalization = { agent_id: agent.id, policy_applied: policyApplied, preferred: p.applied.preferred, deprioritized: p.applied.deprioritized };
      }

      const payload = {
        query: { q, chain, price_max_usd: priceMaxUsd, alive_only: aliveOnly, verified_only: verifiedOnly },
        count: hits.length,
        total_matching_services: totalRow?.n ?? hits.length,
        ...(personalization ? { personalization } : {}),
        results,
      };
      if (!agent) ctx.waitUntil(env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 60 }));
      return json(payload);
    }

    if (path === "/v1/services") {
      const rows = await env.DB.prepare(`SELECT id, title, base_url, description, manifest_type, updated_at FROM services ORDER BY updated_at DESC LIMIT 200`).all();
      return json(rows.results);
    }
    if (path === "/v1/services/history") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "id required" }, 400);
      const rows = await env.DB.prepare(`SELECT p.ts, p.ok, p.status, p.price_min_units, p.latency_ms, p.error FROM probes p JOIN endpoints e ON e.id = p.endpoint_id WHERE e.service_id = ?1 ORDER BY p.ts DESC LIMIT 100`).bind(id).all();
      return json(rows.results);
    }
    if (path === "/v1/stats") {
      const s = await env.DB.prepare(`SELECT COUNT(*) AS services FROM services`).first();
      const e = await env.DB.prepare(
        `SELECT COUNT(*) AS endpoints, SUM(alive) AS alive,
                SUM(CASE WHEN evidence = 'probe' AND alive = 1 THEN 1 ELSE 0 END) AS probed_alive
         FROM endpoints WHERE last_probe_at IS NOT NULL`,
      ).first<{ endpoints: number; alive: number; probed_alive: number }>();
      const zeroQ = await env.DB.prepare(`SELECT COUNT(*) AS zero FROM search_log WHERE zero_results = 1`).first();
      return json({
        services: s?.services ?? 0,
        endpoints_probed: e?.endpoints ?? 0,
        alive: e?.alive ?? 0,               // any-evidence (probe OR catalog OR manifest) — back-compat
        probed_alive: e?.probed_alive ?? 0, // directly observed a live 402 — the honest number
        zero_result_queries: zeroQ?.zero ?? 0,
      });
    }

    // Reputation: seller-side verify (no secret needed — returns authenticated fields).
    if (path === "/v1/reputation/verify" && req.method === "POST") {
      const b = (await req.json<Record<string, unknown>>().catch(() => ({}))) as { payload?: string; signature?: string };
      if (!b.payload || !b.signature) return json({ error: "payload and signature required" }, 400);
      const { verifyCredential } = await import("./lib/reputation");
      return json(await verifyCredential(env, b.payload, b.signature));
    }

    if (path === "/v1/submit" && req.method === "POST") {
      const body = await req.json<{
        base_url?: string; title?: string; description?: string;
        categories?: string[]; endpoints?: { path: string; method?: string }[]; note?: string;
      }>();
      if (!body.base_url || !/^https:\/\//.test(body.base_url)) return json({ error: "base_url (https) required" }, 400);
      const now = Date.now();
      const { slugify } = await import("./ingest/pipeline");
      const title = (body.title ?? new URL(body.base_url).host).slice(0, 80);
      let id = slugify(title);
      // Slug collision guard: if another service owns this slug, suffix it
      const clash = await env.DB.prepare(`SELECT 1 FROM services WHERE id = ?1 AND base_url != ?2`).bind(id, body.base_url).first();
      if (clash) id = `${id}-${Math.abs(hashStr(body.base_url)) % 10000}`;
      await env.DB.prepare(
        `INSERT INTO services (id, base_url, title, description, categories, submitter, source_url, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'submit', ?2, ?6, ?6)
         ON CONFLICT(base_url) DO UPDATE SET updated_at = ?6`,
      )
        .bind(id, body.base_url, title, body.description ?? "", JSON.stringify(body.categories ?? []), now)
        .run();
      for (const e of body.endpoints ?? []) {
        await env.DB.prepare(
          `INSERT INTO endpoints (id, service_id, path, method, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?5) ON CONFLICT(service_id, path, method) DO NOTHING`,
        ).bind(`${id}:${slugify(e.path)}`, id, e.path, e.method ?? "GET", now).run();
      }
      await env.DB.prepare(`INSERT INTO submissions (base_url, note, status, created_at) VALUES (?1, ?2, 'approved', ?3)`)
        .bind(body.base_url, body.note ?? null, now).run();
      // Probe immediately so the listing shows verified data fast
      ctx.waitUntil((async () => {
        const { ingestService } = await import("./ingest/pipeline");
        const row = await env.DB.prepare(`SELECT id FROM services WHERE base_url = ?1`).bind(body.base_url).first<{ id: string }>();
        if (row) await ingestService(env, row.id);
      })());
      return json({ status: "indexed", service_id: id, verification: "queued" }, 201);
    }
    if (path === "/llms.txt") {
      const hits = await search(env, { q: "", aliveOnly: false, limit: 100 });
      const body = [
        "# x402 Atlas",
        "> Live search engine for x402 pay-per-call API services. Verified liveness, measured USDC prices, on-chain seller trust. The neutral index of the machine-payable economy.",
        "",
        "## The magnet (machine-ingest everything from here)",
        "- Full directory: https://atlas.code402.dev/directory.md",
        "- Self-manifest: https://atlas.code402.dev/.well-known/x402.json",
        "- Weekly ecosystem report: https://atlas.code402.dev/reports/state-of-x402.md",
        "",
        "## Ecosystem",
        "- Sell any API to agents: https://code402.dev (settlement layer, non-custodial)",
        "- M2M/1 protocol gateway: https://gateway.code402.dev/v1/services (marketplace, $0.001-$0.005/call)",
        "- Seller leaderboard (on-chain trust): /leaderboard",
        "",
        "## API",
        "- GET /v1/search?q=web+search&chain=eip155:8453&price_max_usd=0.01 — ranked JSON results",
        "- POST /mcp (MCP): tools search_x402, plan_purchase, report_outcome, get_my_reputation, get_ecosystem_stats",
        "",
        "## Services",
        ...hits.map((h) => `- [${h.title}](${h.baseUrl}${h.endpointPath}): $${h.priceMin ?? "?"}/call — ${h.description}`),
      ].join("\n");
      return new Response(body, { headers: { "content-type": "text/plain" } });
    }

    // ---- Agent identity & accumulated state (retention layer) ----
    if (path === "/v1/agent/register" && req.method === "POST") {
      const body = (await req.json<Record<string, unknown>>().catch(() => ({}))) as { label?: string };
      const { registerAgent } = await import("./api/agents");
      const out = await registerAgent(env, body.label ?? "unnamed-agent");
      return json({ ...out, note: "Store this api_key now — it is never shown again. Use: Authorization: Bearer <key>" }, 201);
    }

    // Public, seller-facing: an agent's signed reputation credential (no agent key).
    // Integrity comes from the Atlas signature; add ?audit=1 for a full chain proof.
    {
      const m = path.match(/^\/v1\/agent\/([^/]+)\/reputation$/);
      if (m && req.method === "GET") {
        const id = decodeURIComponent(m[1] ?? "");
        try {
          const { issueCredential, verifyChain } = await import("./lib/reputation");
          const cred = await issueCredential(env, id);
          if (url.searchParams.get("audit") === "1") return json({ ...cred, chain_audit: await verifyChain(env, id) });
          return json(cred);
        } catch (e) {
          if (e instanceof Error && e.message === "INVALID_AGENT_ID") return json({ error: "INVALID_AGENT_ID" }, 400);
          throw e;
        }
      }
    }

    if (path.startsWith("/v1/agent/")) {
      const { authenticate } = await import("./api/agents");
      const agent = await authenticate(env, req);
      if (!agent) return json({ error: "UNAUTHORIZED", hint: "POST /v1/agent/register first" }, 401);
      if (path === "/v1/agent/me" && req.method === "GET") {
        const { agentProfile } = await import("./api/agents");
        return json(await agentProfile(env, agent));
      }
      if (path === "/v1/agent/attestation" && req.method === "GET") {
        const { issueCredential } = await import("./lib/reputation");
        return json(await issueCredential(env, agent.id)); // signed, exportable, seller-verifiable
      }
      if (path === "/v1/agent/policies" && req.method === "POST") {
        const body = (await req.json<Record<string, unknown>>().catch(() => ({}))) as { name?: string; policy?: unknown };
        if (!body.name || typeof body.policy !== "object") return json({ error: "name and policy object required" }, 400);
        const { savePolicy } = await import("./api/agents");
        await savePolicy(env, agent, body.name, body.policy);
        return json({ status: "saved" }, 201);
      }
      if (path === "/v1/agent/outcome" && req.method === "POST") {
        const b = (await req.json<Record<string, unknown>>().catch(() => ({}))) as { endpoint_url?: string; ok?: boolean; amount_units?: number };
        if (!b.endpoint_url || !/^https?:\/\//.test(b.endpoint_url)) return json({ error: "endpoint_url (http/https) required" }, 400);
        const amountUnits = Number.isFinite(Number(b.amount_units)) ? Math.round(Number(b.amount_units)) : null;
        const { recordOutcome } = await import("./api/personalize");
        await recordOutcome(env, agent, { endpoint_url: b.endpoint_url, ok: Boolean(b.ok), amountUnits });
        const { issueCredential } = await import("./lib/reputation");
        const cred = await issueCredential(env, agent.id);
        return json({ status: "recorded", outcome: b.ok ? "PAID_OK" : "PAID_FAIL", reputation: cred.summary }, 201);
      }
      return json({ error: "NOT_FOUND" }, 404);
    }

    if (path === "/v1/plan") {
      const rawBody = await req.json<Record<string, unknown>>();
      const { authenticate, recordDecision } = await import("./api/agents");
      const agent = await authenticate(env, req);

      // Retention layer: fill omitted fields from the agent's saved default policy
      // (explicit args still win), then annotate/adjust with its own outcome ledger.
      const { loadDefaultPolicy, mergePolicyDefaults, experienceByHost, applyOutcomeDowngrade, hostOf } = await import("./api/personalize");
      const pol = agent ? await loadDefaultPolicy(env, agent) : null;
      const body = mergePolicyDefaults(pol, rawBody);

      const parsed = PlanInput.safeParse(body);
      if (!parsed.success) {
        return json({ error: "INVALID_INPUT", issues: parsed.error.issues }, 400);
      }
      let decision = await planPurchase(env, parsed.data);

      let yourHistory: unknown = null;
      let reputation: unknown = undefined;
      if (agent) {
        const exp = await experienceByHost(env, agent);
        const host = hostOf(parsed.data.endpoint_url);
        const e = host ? exp.get(host) ?? null : null;
        yourHistory = e;
        decision = applyOutcomeDowngrade(decision, e, pol);
        ctx.waitUntil(recordDecision(env, agent, {
          endpoint_url: decision.terms.endpoint_url,
          decision: decision.decision,
          reason_code: decision.reason_code,
          price_usd: decision.terms.price_usd,
        }));
        const { reputationSummary } = await import("./lib/reputation");
        reputation = await reputationSummary(env, agent.id);
      }
      return json({ ...(agent ? { agent_id: agent.id, policy_applied: pol != null, your_history: yourHistory, reputation } : {}), ...decision });
    }

    // REMOVED (2026-08-22, owner directive): the /admin/outreach seller-email
    // route. All email outreach is stopped. The hourly health alert to the
    // operator (below, cron path) is internal and remains.
    if (path === "/admin/outreach") {
      return json({ error: "outreach disabled by owner directive (2026-08-22)" }, 410);
    }

    if (path === "/admin/kaizen") {
      const token = url.searchParams.get("token");
      if (!(await tokenOk(env, token))) return json({ error: "unauthorized" }, 401);
      const { dailyKaizen } = await import("./ingest/kaizen");
      await dailyKaizen(env);
      return json({ status: "snapshot taken" });
    }
    if (path === "/kaizen/daily") {
      const rows = await env.DB.prepare(`SELECT * FROM metrics_daily ORDER BY day DESC LIMIT 30`).all();
      return json({ kaizen: rows.results });
    }
    if (path === "/admin/bazaar") {
      const token = url.searchParams.get("token");
      if (!(await tokenOk(env, token))) return json({ error: "unauthorized" }, 401);
      const { ingestBazaar } = await import("./ingest/bazaar");
      return json(await ingestBazaar(env));
    }
    if (path === "/admin/curate") {
      const token = url.searchParams.get("token");
      if (!(await tokenOk(env, token))) return json({ error: "unauthorized" }, 401);
      const { curateFromLeaderboard } = await import("./ingest/curate");
      return json(await curateFromLeaderboard(env));
    }
    if (path === "/services" || path === "/services/") {
      const { servicesPage } = await import("./api/pages");
      return servicesPage(env);
    }
    if (path.startsWith("/services/") && !path.includes(".")) {
      const { serviceDetailPage } = await import("./api/pages");
      return serviceDetailPage(env, path.slice("/services/".length).replace(/\/+$/, ""));
    }
    if (path === "/leaderboard") {
      const { leaderboardPage } = await import("./api/pages");
      return leaderboardPage(env);
    }
    if (path === "/reports/state-of-x402.md") {
      const { stateReport } = await import("./api/pages");
      return stateReport(env, "md");
    }
    if (/^\/reports\/\d{4}-\d{2}-\d{2}$/.test(path)) {
      const { reportArchivePage } = await import("./api/pages");
      return reportArchivePage(env, path.slice("/reports/".length));
    }
    if (path === "/reports/state-of-x402") {
      const { stateReportPage } = await import("./api/pages");
      return stateReportPage(env);
    }
    if (path === "/sellers/claim" || path === "/claim") {
      const { claimPage } = await import("./api/pages");
      return claimPage(env);
    }
    if (path === "/compliance") {
      const { compliancePage } = await import("./api/pages");
      return compliancePage();
    }
    if (path === "/sitemap.xml") {
      const { sitemapXml } = await import("./api/pages");
      return sitemapXml(env);
    }

    if (path === "/v1/sellers") {
      const rows = await env.DB.prepare(
        `SELECT address, settled_volume_usdc, settled_tx_count, unique_buyers, trust_score
         FROM sellers WHERE trust_score > 0 ORDER BY trust_score DESC LIMIT 100`,
      ).all();
      return json(rows.results.map((s: Record<string, unknown>) => ({
        address: s.address,
        settled_volume_usd: Number(s.settled_volume_usdc as string) / 1e6,
        settled_calls: s.settled_tx_count,
        unique_buyers: s.unique_buyers,
        trust_score: s.trust_score,
      })));
    }

    if (path === "/v1/fee/quote") {
      const notional = Number(url.searchParams.get("notional_units") ?? "0");
      const clientId = url.searchParams.get("client") ?? "anonymous";
      if (!Number.isSafeInteger(notional) || notional < 0) return json({ error: "notional_units must be non-negative integer" }, 400);
      const feeMod: typeof import("./lib/fee") = await import("./lib/fee");
      const { calculateFee, CURRENT_FEE_POLICY, quoteId, canonicalQuoteFields } = feeMod;
      const unsigned: Omit<import("./lib/fee").FeeQuote, "signature"> = {
        quote_id: quoteId(notional, CURRENT_FEE_POLICY.policy_version, clientId),
        policy_version: CURRENT_FEE_POLICY.policy_version,
        notional_units: notional,
        total_fee_units: calculateFee(notional, CURRENT_FEE_POLICY),
        currency: "USDC",
        expires_utc: new Date(Date.now() + 300_000).toISOString(),
      };
      return json({ ...unsigned, signature: await hmacSign(env, canonicalQuoteFields(unsigned)) });
    }

    if (path === "/v1/invite" && req.method === "POST") {
      const body = (await req.json<Record<string, unknown>>().catch(() => ({}))) as {
        inviter?: string; counterparty?: string; expected_savings_units?: number;
      };
      if (!body.inviter || !body.counterparty) return json({ error: "inviter and counterparty required" }, 400);
      const { canonicalInvitationFields } = await import("./lib/invite");
      type InvitationT = import("./lib/invite").Invitation;
      const unsigned: Omit<InvitationT, "signature"> = {
        schema_version: "atlas.invitation.v1",
        platform_identity: "x402-atlas",
        inviter: body.inviter.slice(0, 80),
        counterparty: body.counterparty.slice(0, 80),
        expected_savings_units: Math.max(0, Math.floor(body.expected_savings_units ?? 5000)),
        integration_cost_estimate_units: 0,
        fee_schedule_version: 1,
        expires_utc: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
        openapi_spec_url: "https://atlas.code402.dev/openapi.json",
        sandbox_endpoint: "https://atlas.code402.dev/v1/search",
        signature_algorithm: "HMAC-SHA256",
      };
      return json({ ...unsigned, signature: await hmacSign(env, canonicalInvitationFields(unsigned)) });
    }

    if (path === "/.well-known/x402.json" || path === "/.well-known/x402") {
      return json({
        name: "x402 Atlas",
        description: "The neutral discovery + intelligence layer for the machine-payable economy: hourly-verified prices, uptime, on-chain seller trust. Free search API + MCP; seller registration in one line.",
        mcp: "https://atlas.code402.dev/mcp",
        api: "https://atlas.code402.dev/v1/search",
        directory: "https://atlas.code402.dev/directory.md",
        llms_txt: "https://atlas.code402.dev/llms.txt",
        openapi: "https://atlas.code402.dev/openapi.json",
        ecosystem: ["https://code402.dev", "https://gateway.code402.dev/v1/services"],
        register: "https://atlas.code402.dev/sellers/claim",
      });
    }

    // The full machine catalog: every indexed service, compact markdown.
    if (path === "/directory.md") {
      const hits = await search(env, { q: "", aliveOnly: false, limit: 500 });
      const md = [
        "# The x402 Atlas Directory",
        `> ${hits.length}+ payable endpoints for AI agents. Measured prices (hourly 402 probes), uptime, on-chain seller trust. Generated ${new Date().toISOString().slice(0, 10)}.`,
        "> Agents: search live via MCP (atlas.code402.dev/mcp) or GET /v1/search?q=. Sellers: claim your profile at /sellers/claim.",
        "",
        ...hits.map((h) => `- **${h.title}** (${h.baseUrl}${h.endpointPath}) — $${h.priceMin ?? "?"}/call · trust ${h.sellerTrust}/100 · ${h.probedAlive ? "verified" : h.alive ? "asserted" : "unverified"} — ${h.description}`),
      ].join("\n");
      return new Response(md, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=3600" } });
    }

    // IndexNow key file — instant search-engine notification on updates.
    if (path === "/atlas4f3110dd16e7cbce2625e3df34b593f8.txt") return new Response("atlas4f3110dd16e7cbce2625e3df34b593f8\n", { headers: { "content-type": "text/plain" } });

    if (path === "/admin/indexnow") {
      const token = url.searchParams.get("token");
      if (!(await tokenOk(env, token))) return json({ error: "unauthorized" }, 401);
      const urls = ["https://atlas.code402.dev/", "https://atlas.code402.dev/services", "https://atlas.code402.dev/leaderboard", "https://atlas.code402.dev/directory.md", "https://atlas.code402.dev/reports/state-of-x402", "https://atlas.code402.dev/compliance", "https://atlas.code402.dev/sellers/claim"];
      const res = await fetch("https://api.indexnow.org/indexnow", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ host: "atlas.code402.dev", key: "atlas4f3110dd16e7cbce2625e3df34b593f8", keyLocation: "https://atlas.code402.dev/atlas4f3110dd16e7cbce2625e3df34b593f8.txt", urlList: urls }),
      });
      return json({ pinged: urls.length, indexnow_status: res.status });
    }

    if (path === "/robots.txt") {
      return new Response(
        `User-agent: *\nAllow: /\n\n# AI crawlers and RAG pipelines explicitly welcome\nUser-agent: GPTBot\nAllow: /\nUser-agent: ClaudeBot\nAllow: /\nUser-agent: PerplexityBot\nAllow: /\nUser-agent: Bytespider\nAllow: /\n\nSitemap: https://atlas.code402.dev/sitemap.xml\n`,
        { headers: { "content-type": "text/plain" } },
      );
    }
    if (path === "/openapi.json") {
      return json({
        openapi: "3.1.0",
        info: { title: "x402 Atlas", version: "0.1.0", description: "Live, verified search + deterministic purchase policy + agent reputation for x402 machine-payable APIs. All money in 6-decimal integer USDC units." },
        servers: [{ url: "https://atlas.code402.dev" }],
        paths: {
          "/v1/search": { get: {
            summary: "Ranked search over indexed x402 services. Each result carries ready-to-pay settlement terms and an honest liveness tier. Send Authorization: Bearer <agent key> to personalize.",
            parameters: [
              { name: "q", in: "query", schema: { type: "string" } },
              { name: "chain", in: "query", description: "CAIP-2 network filter, e.g. eip155:8453", schema: { type: "string" } },
              { name: "price_max_usd", in: "query", schema: { type: "number" } },
              { name: "alive_only", in: "query", description: "Any-evidence liveness (default true)", schema: { type: "boolean", default: true } },
              { name: "verified_only", in: "query", description: "Only directly probe-observed live endpoints", schema: { type: "boolean", default: false } },
              { name: "limit", in: "query", schema: { type: "integer", default: 25, maximum: 100 } },
            ],
          } },
          "/v1/plan": { post: { summary: "Deterministic purchase gate: ACCEPT/REJECT/ESCALATE. Auth applies your saved policy + history.", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["endpoint_url"], properties: { endpoint_url: { type: "string", format: "uri" }, budget_usd: { type: "number" }, price_ceiling_usd: { type: "number" } } } } } } } },
          "/v1/agent/register": { post: { summary: "Register an agent; returns a bearer api_key (shown once)." } },
          "/v1/agent/outcome": { post: { summary: "Report a pay outcome (ok true/false, optional amount_units) to your ledger + reputation chain. Auth: Bearer agent key.", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["endpoint_url", "ok"], properties: { endpoint_url: { type: "string", format: "uri" }, ok: { type: "boolean" }, amount_units: { type: "integer" } } } } } } } },
          "/v1/agent/attestation": { get: { summary: "Your signed, exportable reputation credential. Auth: Bearer agent key." } },
          "/v1/agent/{id}/reputation": { get: { summary: "Public signed reputation credential for an agent (sellers read this). ?audit=1 adds a full chain proof.", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } },
          "/v1/reputation/verify": { post: { summary: "Verify a reputation credential's Atlas signature + freshness without the secret; returns the authenticated fields.", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["payload", "signature"], properties: { payload: { type: "string" }, signature: { type: "string" } } } } } } } },
          "/v1/fee/quote": { get: { summary: "Deterministic signed fee quote (expires in 300s)", parameters: [{ name: "notional_units", in: "query", schema: { type: "integer" } }, { name: "client", in: "query", schema: { type: "string" } }] } },
          "/v1/invite": { post: { summary: "Signed propagation invitation with verifiable economic surplus" } },
          "/mcp": { post: { summary: "MCP server: search_x402, plan_purchase, report_outcome, get_my_reputation, get_ecosystem_stats" } },
        },
      });
    }

    // Admin: run pipeline inline (ops/testing — protects with ADMIN_TOKEN if set)
    if (path === "/admin/crawl") {
      const token = url.searchParams.get("token");
      if (!(await tokenOk(env, token))) return json({ error: "unauthorized" }, 401);
      if (url.searchParams.get("bootstrap") === "1") await ensureSeeds(env);
      const serviceId = url.searchParams.get("service");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 5), 20);
      const targets = serviceId
        ? [{ id: serviceId }]
        : (await env.DB.prepare(
            `SELECT DISTINCT s.id FROM services s LEFT JOIN endpoints e ON e.service_id = s.id
             WHERE e.last_probe_at IS NULL OR e.last_probe_at < ?1 LIMIT ?2`,
          ).bind(Date.now() - 3600_000, limit).all<{ id: string }>()).results;
      const out: Record<string, unknown>[] = [];
      for (const t of targets) {
        const ing = await ingestService(env, t.id);
        const eps = await env.DB.prepare(`SELECT id FROM endpoints WHERE service_id = ?1`).bind(t.id).all<{ id: string }>();
        for (const e of eps.results) {
          await runProbe(env, t.id, e.id);
        }
        const st = await env.DB.prepare(`SELECT COUNT(*) n, SUM(alive) a FROM endpoints WHERE service_id = ?1`).bind(t.id).first<{ n: number; a: number }>();
        out.push({ service: t.id, manifest: ing.updated, endpoints: st?.n ?? 0, alive: st?.a ?? 0 });
      }
      return json({ processed: out });
    }

    // Static web UI
    return env.ASSETS.fetch(req);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      await ensureSeeds(env);
      // Health alerting: check every property; email on failure (deduped 1/hour via KV).
      try {
        const targets = [
          ["atlas", "https://atlas.code402.dev/healthz"],
          ["gateway", "https://gateway.code402.dev/healthz"],
          ["code402", "https://code402.dev/healthz"],
          ["tollbooth", "https://tollbooth.code402.dev/healthz"],
        ];
        const failures: string[] = [];
        for (const [name, u] of targets as [string, string][]) {
          try {
            const r = await fetch(u, { signal: AbortSignal.timeout(10_000) });
            if (r.status !== 200) failures.push(`${name}: HTTP ${r.status}`);
          } catch (e) {
            failures.push(`${name}: ${e instanceof Error ? e.message : "unreachable"}`);
          }
        }
        const dedupeKey = `alert:${Math.floor(Date.now() / 3600_000)}`;
        const alreadyAlerted = await env.CACHE.get(dedupeKey);
        if (failures.length > 0 && !alreadyAlerted && env.EMAIL) {
          await env.EMAIL.send({
            to: "drjsarat@gmail.com",
            from: { email: "alerts@code402.dev", name: "x402 Atlas Monitoring" },
            subject: `[ALERT] ${failures.length} health check(s) failing`,
            text: `Health check failures at ${new Date().toISOString()}:\n\n${failures.join("\n")}\n\n— atlas.code402.dev cron monitor (hourly, deduped)`,
            html: `<h2>Health check failures</h2><p>${new Date().toISOString()}</p><pre>${failures.join("\n")}</pre>`,
          });
          await env.CACHE.put(dedupeKey, "1", { expirationTtl: 3600 });
          console.error("HEALTH ALERT SENT", failures);
        }
      } catch (e) { console.error("health alerting failed", e); }
      // Daily kaizen (02:00 UTC): bazaar ingestion + metrics snapshot
      if (new Date().getUTCHours() === 2) {
        try {
          const { ingestBazaar } = await import("./ingest/bazaar");
          await ingestBazaar(env);
        } catch (e) { console.error("bazaar ingest failed", e); }
        try {
          const { dailyKaizen } = await import("./ingest/kaizen");
          await dailyKaizen(env);
        } catch (e) { console.error("kaizen snapshot failed", e); }
      }
      // GDPR data minimization: purge anonymous search logs after 90 days
      await env.DB.prepare(`DELETE FROM search_log WHERE ts < ?1`).bind(Date.now() - 90 * 24 * 3600_000).run();
      // Weekly (Monday 03:00) re-curation from on-chain leaderboard
      if (new Date().getUTCDay() === 1 && new Date().getUTCHours() === 3) {
        try {
          const { curateFromLeaderboard } = await import("./ingest/curate");
          await curateFromLeaderboard(env);
        } catch (e) {
          console.error("curation failed", e);
        }
      }
      const due = await env.DB.prepare(
        `SELECT DISTINCT s.id FROM services s LEFT JOIN endpoints e ON e.service_id = s.id
         WHERE e.last_probe_at IS NULL OR e.last_probe_at < ?1 ORDER BY COALESCE(e.last_probe_at, 0) ASC LIMIT 50`,
      ).bind(Date.now() - 3600_000).all<{ id: string }>();
      for (const r of due.results) {
        await env.CRAWL_QUEUE.send({ kind: "manifest", serviceId: r.id });
      }
    })());
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env) {
    for (const msg of batch.messages) {
      try {
        if (msg.body.kind === "manifest") await ingestService(env, msg.body.serviceId);
        else if (msg.body.kind === "probe" && msg.body.endpointId) await runProbe(env, msg.body.serviceId, msg.body.endpointId);
      } catch (e) {
        console.error("queue task failed", msg.body, e);
        msg.retry({ delaySeconds: 60 });
      }
      msg.ack();
    }
  },
};
