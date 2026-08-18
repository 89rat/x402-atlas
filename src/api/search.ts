/** Search API: SQL filters + ranking (liveness ▸ freshness ▸ price-accuracy ▸ relevance). */
import type { Env } from "../lib/types";
import { unitsToUsd } from "../ingest/adapters";
import { sanitizeSellerText } from "../lib/sanitize";

export interface SearchParams {
  q: string;
  chain?: string; // CAIP-2
  priceMaxUnits?: number;
  aliveOnly: boolean;
  limit: number;
}

export interface SearchHit {
  serviceId: string;
  title: string;
  description: string;
  baseUrl: string;
  categories: string[];
  alive: boolean;
  uptime7d: number;
  priceMin: string | null; // human USD
  priceMax: string | null;
  endpointPath: string;
  lastProbeAt: number | null;
  latencyMs: number | null;
  /** 0-100 from on-chain settled volume + buyer diversity (0 = no on-chain evidence yet). */
  sellerTrust: number;
  score: number;
}

export async function search(env: Env, params: SearchParams): Promise<SearchHit[]> {
  const terms = params.q.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = await env.DB.prepare(
    `SELECT s.id AS service_id, s.title, s.description, s.base_url, s.categories,
            MAX(e.alive) AS alive, MAX(e.uptime_7d) AS uptime_7d,
            MIN(CASE WHEN e.price_min_units IS NOT NULL THEN e.price_min_units END) AS price_min_units,
            MAX(e.price_max_units) AS price_max_units,
            (SELECT e2.path FROM endpoints e2 WHERE e2.service_id = s.id
              AND e2.price_min_units = (SELECT MIN(price_min_units) FROM endpoints WHERE service_id = s.id AND price_min_units IS NOT NULL)
              LIMIT 1) AS path,
            MAX(e.last_probe_at) AS last_probe_at, MIN(e.last_latency_ms) AS last_latency_ms,
            COALESCE(MAX(sel.trust_score), 0) AS trust_score
     FROM services s
     LEFT JOIN endpoints e ON e.service_id = s.id
     LEFT JOIN sellers sel ON sel.address = s.seller_address
     WHERE 1=1
     GROUP BY s.id
     HAVING (?3 = 0 OR MAX(e.alive) = 1)
       AND (?4 IS NULL OR MIN(CASE WHEN e.price_min_units IS NOT NULL THEN e.price_min_units END) <= ?4)
     ORDER BY trust_score DESC
     LIMIT 500`,
  )
    .bind(params.aliveOnly ? 1 : 0, params.chain ?? null, params.aliveOnly ? 1 : 0, params.priceMaxUnits ?? null)
    .all<{
      service_id: string; title: string; description: string; base_url: string; categories: string;
      alive: number; uptime_7d: number; price_min_units: number | null; price_max_units: number | null;
      path: string | null; last_probe_at: number | null; last_latency_ms: number | null;
      trust_score: number;
    }>();

  const now = Date.now();
  const hits: SearchHit[] = rows.results.map((r) => {
    const hay = `${r.title} ${r.description} ${r.categories} ${r.base_url} ${r.path ?? ""}`.toLowerCase();
    let relevance = 0;
    for (const t of terms) {
      if (hay.includes(t)) relevance += t.length >= 4 ? 2 : 1; // weight meaningful terms
    }
    const alive = r.alive === 1;
    const freshness = r.last_probe_at ? Math.max(0, 1 - (now - r.last_probe_at) / (7 * 24 * 3600 * 1000)) : 0;
    const priceAccuracy = r.price_min_units !== null ? 1 : 0;
    const score =
      (alive ? 100 : 0) +
      r.uptime_7d * 30 +
      relevance * 10 +
      freshness * 20 +
      priceAccuracy * 10 +
      (r.trust_score ?? 0) * 0.5; // on-chain evidence: up to +50
    return {
      serviceId: r.service_id,
      title: r.title,
      description: sanitizeSellerText(r.description),
      baseUrl: r.base_url,
      categories: JSON.parse(r.categories || "[]") as string[],
      alive,
      uptime7d: r.uptime_7d,
      priceMin: r.price_min_units !== null ? unitsToUsd(r.price_min_units) : null,
      priceMax: r.price_max_units !== null ? unitsToUsd(r.price_max_units) : null,
      endpointPath: r.path ?? "/",
      lastProbeAt: r.last_probe_at,
      latencyMs: r.last_latency_ms,
      sellerTrust: r.trust_score ?? 0,
      score,
    };
  });

  // Query terms must match at least once (unless empty query = directory browse)
  const filtered = terms.length
    ? hits.filter((h) =>
        terms.some((t) => `${h.title} ${h.description} ${h.categories.join(" ")} ${h.baseUrl}`.toLowerCase().includes(t)),
      )
    : hits;

  const seen = new Set<string>();
  return filtered
    .sort((a, b) => b.score - a.score)
    .filter((h) => (seen.has(h.serviceId + h.endpointPath) ? false : (seen.add(h.serviceId + h.endpointPath), true)))
    .slice(0, params.limit);
}
