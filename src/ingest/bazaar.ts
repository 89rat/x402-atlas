/**
 * Coinbase Agentic.Market ingestion — "aggregate the aggregator."
 * Their catalog is public (api.agentic.market/v1/services); we ingest it,
 * probe it independently, and rank by measured data instead of curation.
 */
import type { Env } from "../lib/types";

const AGENTIC_MARKET_API = "https://api.agentic.market/v1/services";
import { slugify } from "./pipeline";

interface BazaarEndpoint {
  url: string;
  pricing?: { amount?: string; currency?: string; network?: string };
  method?: string;
  description?: string;
}

export async function ingestBazaar(env: Env, limit = 20): Promise<{ ingested: number; endpoints: number }> {
  const res = await fetch(AGENTIC_MARKET_API, {
    headers: { "user-agent": "x402-atlas/0.1 (neutral aggregator)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`agentic.market fetch failed: ${res.status}`);
  const data = await res.json<{ services: {
    name?: string; description?: string; domain?: string; providerUrl?: string;
    category?: string; endpoints?: BazaarEndpoint[]; enriched?: boolean;
  }[] }>();

  const now = Date.now();
  let ingested = 0, eps = 0;
  // Chunked: Workers subrequest limits; daily cron makes this incremental.
  for (const s of (data.services ?? []).slice(0, limit)) {
    const origin = s.providerUrl?.replace(/\/+$/, "") ?? (s.domain ? `https://${s.domain}` : null);
    if (!origin || !/^https:\/\//.test(origin)) continue;
    const id = slugify(`bazaar-${s.name ?? s.domain ?? origin}`);
    const r = await env.DB.prepare(
      `INSERT INTO services (id, base_url, title, description, categories, submitter, source_url, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'bazaar', ?6, ?7, ?7)
       ON CONFLICT(base_url) DO UPDATE SET updated_at = ?7`,
    ).bind(id, origin, s.name ?? s.domain ?? id, s.description ?? "",
      JSON.stringify([("category" in s ? String(s.category).toLowerCase() : ""), "coinbase-curated"].filter(Boolean)),
      AGENTIC_MARKET_API, now).run();
    if (r.meta.changes > 0) ingested++;
    const row = await env.DB.prepare(`SELECT id FROM services WHERE base_url = ?1`).bind(origin).first<{ id: string }>();
    if (!row) continue;
    for (const e of (s.endpoints ?? []).slice(0, 5)) {
      let path = "/";
      try { path = new URL(e.url).pathname || "/"; } catch { continue; }
      const pathId = `${slugify(path) || "root"}-${Math.abs([...e.url].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 0)) % 9973}`;
      const amountUnits = e.pricing?.amount ? Math.round(Number(e.pricing.amount) * 1e6) : null;
      await env.DB.prepare(
        `INSERT INTO endpoints (id, service_id, path, method, description, price_min_units, price_max_units, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?7)
         ON CONFLICT(service_id, path, method) DO UPDATE SET price_min_units = COALESCE(?6, price_min_units), updated_at = ?7`,
      ).bind(`${row.id}:${pathId}`, row.id, path, e.method ?? "GET",
        ((e.description ?? "").slice(0, 200)) || null, amountUnits, now).run();
      eps++;
    }
  }
  return { ingested, endpoints: eps };
}

/**
 * Sybil-adjusted settled volume: a seller's volume counts fully only with ≥10
 * distinct buyers (response to on-chain analysis that ~half of x402 activity
 * is self-dealing/testing). volume_adj = volume * min(1, buyers/10).
 */
export async function sybilAdjustedVolume(env: Env): Promise<{ raw: number; adjusted: number }> {
  const rows = await env.DB.prepare(
    `SELECT CAST(settled_volume_usdc AS INTEGER) vol, unique_buyers FROM sellers`,
  ).all<{ vol: number; unique_buyers: number }>();
  let raw = 0, adj = 0;
  for (const r of rows.results) {
    raw += r.vol;
    adj += r.vol * Math.min(1, r.unique_buyers / 10);
  }
  return { raw, adjusted: Math.round(adj) };
}
