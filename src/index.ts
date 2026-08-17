/** x402 Atlas — main Worker entry. */
import type { Env, QueueMessage } from "./lib/types";
import { ensureSeeds, ingestService, runProbe } from "./ingest/pipeline";
import { search } from "./api/search";
import { planPurchase, PlanInput } from "./api/policy";
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
      const body = await req.json<{ base_url?: string; note?: string }>();
      if (!body.base_url || !/^https:\/\//.test(body.base_url)) return json({ error: "base_url (https) required" }, 400);
      await env.DB.prepare(`INSERT INTO submissions (base_url, note, created_at) VALUES (?1, ?2, ?3)`).bind(body.base_url, body.note ?? null, Date.now()).run();
      return json({ status: "queued" }, 201);
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
