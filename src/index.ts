/** x402 Atlas — main Worker entry. */
import type { Env, QueueMessage } from "./lib/types";
import { ensureSeeds, ingestService, runProbe } from "./ingest/pipeline";
import { search } from "./api/search";
import { planPurchase, PlanInput } from "./api/policy";
import { hmacSign } from "./lib/sign";
import { handleMcp } from "./mcp/server";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/mcp" && req.method === "POST") return handleMcp(env, req);

    if (path === "/v1/search") {
      const q = url.searchParams.get("q") ?? "";
      const chain = url.searchParams.get("chain") ?? undefined;
      const priceMaxUsd = url.searchParams.get("price_max_usd");
      const aliveOnly = url.searchParams.get("alive_only") !== "false";
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 25), 100);

      const cacheKey = `search:${q}:${chain ?? ""}:${priceMaxUsd ?? ""}:${aliveOnly}:${limit}`;
      const cached = await env.CACHE.get(cacheKey, "json");
      if (cached) return json(cached);

      const hits = await search(env, {
        q, chain,
        priceMaxUnits: priceMaxUsd !== null ? Math.round(Number(priceMaxUsd) * 1e6) : undefined,
        aliveOnly, limit,
      });

      // Kaizen telemetry: log every search (incl. zero-result queries → demand signal)
      ctx.waitUntil(
        env.DB.prepare(
          `INSERT INTO search_log (ts, q, chain, price_max_units, alive_only, result_count, zero_results) VALUES (?1,?2,?3,?4,?5,?6,?7)`,
        ).bind(Date.now(), q, chain ?? null, priceMaxUsd !== null ? Math.round(Number(priceMaxUsd) * 1e6) : null, aliveOnly ? 1 : 0, hits.length, hits.length === 0 ? 1 : 0).run(),
      );

      const payload = { query: { q, chain, price_max_usd: priceMaxUsd, alive_only: aliveOnly }, count: hits.length, results: hits };
      ctx.waitUntil(env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 60 }));
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
      const e = await env.DB.prepare(`SELECT COUNT(*) AS endpoints, SUM(alive) AS alive FROM endpoints WHERE last_probe_at IS NOT NULL`).first();
      const zeroQ = await env.DB.prepare(`SELECT COUNT(*) AS zero FROM search_log WHERE zero_results = 1`).first();
      return json({ services: s?.services ?? 0, endpoints_probed: e?.endpoints ?? 0, alive: e?.alive ?? 0, zero_result_queries: zeroQ?.zero ?? 0 });
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
      const id = slugify(title);
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
        "> Live search engine for x402 pay-per-call API services. Verified liveness, measured USDC prices.",
        "",
        "## API",
        "- GET /v1/search?q=web+search&chain=eip155:8453&price_max_usd=0.01 — ranked JSON results",
        "- POST /mcp (MCP): tools search_x402, get_ecosystem_stats",
        "",
        "## Services",
        ...hits.map((h) => `- [${h.title}](${h.baseUrl}${h.endpointPath}): $${h.priceMin ?? "?"}/call — ${h.description}`),
      ].join("\n");
      return new Response(body, { headers: { "content-type": "text/plain" } });
    }

    if (path === "/v1/plan") {
      const body = await req.json<Record<string, unknown>>();
      const parsed = PlanInput.safeParse(body);
      if (!parsed.success) {
        return json({ error: "INVALID_INPUT", issues: parsed.error.issues }, 400);
      }
      return json(await planPurchase(env, parsed.data));
    }

    if (path === "/admin/curate") {
      const token = url.searchParams.get("token");
      if (env.ADMIN_TOKEN && token !== env.ADMIN_TOKEN) return json({ error: "unauthorized" }, 401);
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
    if (path === "/reports/state-of-x402") {
      const { stateReportPage } = await import("./api/pages");
      return stateReportPage(env);
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

    if (path === "/robots.txt") {
      return new Response(
        `User-agent: *\nAllow: /\n\n# AI crawlers and RAG pipelines explicitly welcome\nUser-agent: GPTBot\nAllow: /\nUser-agent: ClaudeBot\nAllow: /\nUser-agent: PerplexityBot\nAllow: /\nUser-agent: Bytespider\nAllow: /\n\nSitemap: https://atlas.code402.dev/sitemap.xml\n`,
        { headers: { "content-type": "text/plain" } },
      );
    }
    if (path === "/openapi.json") {
      return json({
        openapi: "3.1.0",
        info: { title: "x402 Atlas", version: "0.1.0", description: "Live, verified search + deterministic purchase policy for x402 machine-payable APIs. All money in 6-decimal integer USDC units." },
        servers: [{ url: "https://atlas.code402.dev" }],
        paths: {
          "/v1/search": { get: { summary: "Ranked search over verified x402 services", parameters: [{ name: "q", in: "query", schema: { type: "string" } }, { name: "price_max_usd", in: "query", schema: { type: "number" } }, { name: "alive_only", in: "query", schema: { type: "boolean", default: true } }] } },
          "/v1/plan": { post: { summary: "Deterministic purchase gate: ACCEPT/REJECT/ESCALATE with policy checklist and surplus proof", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["endpoint_url"], properties: { endpoint_url: { type: "string", format: "uri" }, budget_usd: { type: "number" }, price_ceiling_usd: { type: "number" } } } } } } } },
          "/v1/fee/quote": { get: { summary: "Deterministic signed fee quote (expires in 300s)", parameters: [{ name: "notional_units", in: "query", schema: { type: "integer" } }, { name: "client", in: "query", schema: { type: "string" } }] } },
          "/v1/invite": { post: { summary: "Signed propagation invitation with verifiable economic surplus" } },
          "/mcp": { post: { summary: "MCP server: search_x402, plan_purchase, get_ecosystem_stats" } },
        },
      });
    }

    // Admin: run pipeline inline (ops/testing — protects with ADMIN_TOKEN if set)
    if (path === "/admin/crawl") {
      const token = url.searchParams.get("token");
      if (env.ADMIN_TOKEN && token !== env.ADMIN_TOKEN) return json({ error: "unauthorized" }, 401);
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
        let alive = 0;
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
