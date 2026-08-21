/** Search API: SQL filters + ranking (liveness ▸ freshness ▸ price-accuracy ▸ relevance). */
import type { Env } from "../lib/types";
import { unitsToUsd } from "../ingest/adapters";
import { sanitizeSellerText } from "../lib/sanitize";
import { USDC_DECIMALS } from "../lib/types";

export interface SearchParams {
  q: string;
  chain?: string; // CAIP-2, e.g. eip155:8453 — now actually filters
  priceMaxUnits?: number;
  aliveOnly: boolean;
  /** When true, only services with at least one PROBE-observed live endpoint
   *  (evidence='probe'); excludes catalog/manifest-asserted liveness. */
  verifiedOnly?: boolean;
  limit: number;
}

/** Ready-to-pay settlement terms for the representative (cheapest) endpoint.
 *  Present so an agent can budget/verify WITHOUT a second live probe. */
export interface SettlementTerms {
  /** Settlement address (payTo). Null if not yet observed. */
  payTo: string | null;
  /** Asset/token identifier or address. Null if not yet observed. */
  asset: string | null;
  /** CAIP-2 network, e.g. eip155:8453. Null if not yet observed. */
  network: string | null;
  /** Exact price in integer USDC base units (6 decimals), as a string for
   *  lossless handling. This is the x402 `maxAmountRequired`. */
  amountUnits: string | null;
  /** Decimals for `asset` (USDC = 6). */
  assetDecimals: number;
  /** x402 scheme: exact | upto | other. */
  scheme: "exact" | "upto" | "other" | null;
  /** How this endpoint's liveness/terms were established. */
  evidence: "probe" | "catalog" | "manifest" | "none";
}

export interface SearchHit {
  serviceId: string;
  title: string;
  description: string;
  baseUrl: string;
  categories: string[];
  /** Any-evidence liveness (probe OR catalog OR manifest). Back-compat field. */
  alive: boolean;
  /** True only if a live 402 was directly observed on some endpoint. */
  probedAlive: boolean;
  /** Evidence tier of the representative (cheapest) endpoint. */
  evidence: "probe" | "catalog" | "manifest" | "none";
  uptime7d: number;
  priceMin: string | null; // human USD label (convenience only; see settlement.amountUnits for money)
  priceMax: string | null;
  /** Ready-to-pay terms for the representative endpoint. Null if no priced endpoint yet. */
  settlement: SettlementTerms | null;
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
            MAX(e.alive) AS alive,
            MAX(CASE WHEN e.evidence = 'probe' AND e.alive = 1 THEN 1 ELSE 0 END) AS probed_alive,
            MAX(e.uptime_7d) AS uptime_7d,
            MIN(CASE WHEN e.price_min_units IS NOT NULL THEN e.price_min_units END) AS price_min_units,
            MAX(e.price_max_units) AS price_max_units,
            (SELECT e2.path FROM endpoints e2 WHERE e2.service_id = s.id
              AND e2.price_min_units = (SELECT MIN(price_min_units) FROM endpoints WHERE service_id = s.id AND price_min_units IS NOT NULL)
              LIMIT 1) AS path,
            (SELECT json_object(
                      'payTo', e3.pay_to, 'asset', e3.asset, 'network', e3.network,
                      'amountUnits', e3.price_min_units, 'scheme', e3.paywall_scheme,
                      'evidence', e3.evidence)
              FROM endpoints e3 WHERE e3.service_id = s.id
              AND e3.price_min_units = (SELECT MIN(price_min_units) FROM endpoints WHERE service_id = s.id AND price_min_units IS NOT NULL)
              LIMIT 1) AS rep_terms,
            MAX(e.last_probe_at) AS last_probe_at, MIN(e.last_latency_ms) AS last_latency_ms,
            COALESCE(MAX(sel.trust_score), 0) AS trust_score
     FROM services s
     LEFT JOIN endpoints e ON e.service_id = s.id
     LEFT JOIN sellers sel ON sel.address = s.seller_address
     WHERE 1=1
     GROUP BY s.id
     HAVING (?1 = 0 OR MAX(e.alive) = 1)
       AND (?2 IS NULL OR MIN(CASE WHEN e.price_min_units IS NOT NULL THEN e.price_min_units END) <= ?2)
       AND (?3 IS NULL OR MAX(CASE WHEN e.network = ?3 THEN 1 ELSE 0 END) = 1)
     ORDER BY trust_score DESC
     LIMIT 500`,
  )
    .bind(params.aliveOnly ? 1 : 0, params.priceMaxUnits ?? null, params.chain ?? null)
    .all<{
      service_id: string; title: string; description: string; base_url: string; categories: string;
      alive: number; probed_alive: number; uptime_7d: number; price_min_units: number | null; price_max_units: number | null;
      path: string | null; rep_terms: string | null; last_probe_at: number | null; last_latency_ms: number | null;
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
    const probedAlive = r.probed_alive === 1;
    const freshness = r.last_probe_at ? Math.max(0, 1 - (now - r.last_probe_at) / (7 * 24 * 3600 * 1000)) : 0;
    const priceAccuracy = r.price_min_units !== null ? 1 : 0;

    let rt: {
      payTo: string | null; asset: string | null; network: string | null;
      amountUnits: number | null; scheme: string | null; evidence: string | null;
    } | null = null;
    try {
      rt = r.rep_terms ? JSON.parse(r.rep_terms) : null;
    } catch {
      rt = null;
    }
    const evidence = (rt?.evidence ?? "none") as SearchHit["evidence"];
    const settlement: SettlementTerms | null =
      rt && rt.amountUnits !== null
        ? {
            payTo: rt.payTo ?? null,
            asset: rt.asset ?? null,
            network: rt.network ?? null,
            amountUnits: rt.amountUnits !== null ? String(rt.amountUnits) : null,
            assetDecimals: USDC_DECIMALS,
            scheme: (rt.scheme === "exact" || rt.scheme === "upto" ? rt.scheme : rt.scheme ? "other" : null) as SettlementTerms["scheme"],
            evidence,
          }
        : null;

    // Ranking: probe-observed liveness is worth more than asserted liveness.
    const livenessScore = probedAlive ? 100 : alive ? 60 : 0;
    const score =
      livenessScore +
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
      probedAlive,
      evidence,
      uptime7d: r.uptime_7d,
      priceMin: r.price_min_units !== null ? unitsToUsd(r.price_min_units) : null,
      priceMax: r.price_max_units !== null ? unitsToUsd(r.price_max_units) : null,
      settlement,
      endpointPath: r.path ?? "/",
      lastProbeAt: r.last_probe_at,
      latencyMs: r.last_latency_ms,
      sellerTrust: r.trust_score ?? 0,
      score,
    };
  });

  // Query terms must match at least once (unless empty query = directory browse)
  let filtered = terms.length
    ? hits.filter((h) =>
        terms.some((t) => `${h.title} ${h.description} ${h.categories.join(" ")} ${h.baseUrl}`.toLowerCase().includes(t)),
      )
    : hits;

  // verified_only: keep only services with a directly probe-observed live endpoint.
  if (params.verifiedOnly) filtered = filtered.filter((h) => h.probedAlive);

  const seen = new Set<string>();
  return filtered
    .sort((a, b) => b.score - a.score)
    .filter((h) => (seen.has(h.serviceId + h.endpointPath) ? false : (seen.add(h.serviceId + h.endpointPath), true)))
    .slice(0, params.limit);
}
