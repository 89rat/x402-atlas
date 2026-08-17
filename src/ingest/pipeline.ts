/** Ingestion pipeline: upsert services from manifests, queue probes. */
import type { Env, SeedService } from "../lib/types";
import { fetchManifest } from "./manifest";
import seedsJson from "../../seeds/services.json";
const seeds: SeedService[] = seedsJson;

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60) || `svc-${Date.now()}`;
}

export async function ensureSeeds(env: Env): Promise<number> {
  const now = Date.now();
  let added = 0;
  for (const s of seeds) {
    const id = slugify(s.title);
    const r = await env.DB.prepare(
      `INSERT INTO services (id, base_url, title, description, categories, submitter, source_url, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'seed', ?6, ?7, ?7)
       ON CONFLICT(base_url) DO NOTHING`,
    )
      .bind(id, s.baseUrl, s.title, s.description ?? "", JSON.stringify(s.categories ?? []), s.baseUrl, now)
      .run();
    if (r.meta.changes > 0) {
      added++;
      for (const e of s.endpoints ?? []) {
        await env.DB.prepare(
          `INSERT INTO endpoints (id, service_id, path, method, description, probe_body, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) ON CONFLICT(service_id, path, method) DO NOTHING`,
        )
          .bind(`${id}:${slugify(e.path)}`, id, e.path, e.method ?? "GET", e.description ?? "", e.probe_body ? JSON.stringify(e.probe_body) : null, now)
          .run();
      }
    }
  }
  return added;
}

/** Fetch manifest for a service, upsert metadata + endpoints, snapshot to R2, queue probes. */
export async function ingestService(env: Env, serviceId: string): Promise<{ updated: boolean }> {
  const svc = await env.DB.prepare(`SELECT id, base_url FROM services WHERE id = ?1`).bind(serviceId).first<{ id: string; base_url: string }>();
  if (!svc) return { updated: false };
  const { raw, parsed } = await fetchManifest(svc.base_url);

  // Snapshot raw manifest to R2 (immutable audit trail)
  if (raw) {
    await env.SNAPSHOTS.put(`manifests/${serviceId}/${Date.now()}.json`, raw, {
      httpMetadata: { contentType: "application/json" },
    });
  }

  if (parsed) {
    const now = Date.now();
    await env.DB.prepare(
      `UPDATE services SET title = COALESCE(?2, title), description = COALESCE(NULLIF(?3, ''), description), categories = ?4, manifest_type = ?5,
       manifest_raw = ?6, seller_address = COALESCE(?7, seller_address), updated_at = ?8 WHERE id = ?1`,
    )
      .bind(
        serviceId,
        parsed.title,
        parsed.description,
        JSON.stringify(parsed.categories),
        parsed.type,
        raw,
        parsed.sellerAddress ?? null,
        now,
      )
      .run();
    if (parsed.sellerAddress) {
      await env.DB.prepare(
        `INSERT INTO sellers (address, first_seen_at, updated_at) VALUES (?1, ?2, ?2)
         ON CONFLICT(address) DO UPDATE SET updated_at = ?2`,
      ).bind(parsed.sellerAddress, now).run();
    }
    for (const e of parsed.endpoints) {
      await env.DB.prepare(
        `INSERT INTO endpoints (id, service_id, path, method, description, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(service_id, path, method) DO UPDATE SET description = ?5, updated_at = ?6`,
      )
        .bind(`${serviceId}:${slugify(e.path)}`, serviceId, e.path, e.method, e.description ?? "", now)
        .run();
    }
  }

  // Queue probes for all endpoints of this service
  const eps = await env.DB.prepare(`SELECT id FROM endpoints WHERE service_id = ?1`).bind(serviceId).all<{ id: string }>();
  for (const e of eps.results) {
    await env.CRAWL_QUEUE.send({ kind: "probe", serviceId, endpointId: e.id });
  }
  return { updated: parsed !== null };
}

/** Run a probe and persist results + rolling uptime. */
export async function runProbe(env: Env, serviceId: string, endpointId: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT s.base_url, e.path, e.method, e.probe_body FROM endpoints e JOIN services s ON s.id = e.service_id
     WHERE e.id = ?1`,
  )
    .bind(endpointId)
    .first<{ base_url: string; path: string; method: string; probe_body: string | null }>();
  if (!row) return;

  const { probeEndpoint } = await import("./prober");
  let result = await probeEndpoint(row.base_url, row.path, row.method, row.probe_body ?? undefined);

  // Fallback: same-account workers.dev subrequests can be intercepted by the asset
  // router (observed: 404 while direct requests 402). If direct challenge failed,
  // fall back to the service's authoritative /.well-known/x402.json manifest.
  if (!result.ok) {
    try {
      const mres = await fetch(`${row.base_url.replace(/\/+$/, "")}/.well-known/x402.json`, {
        headers: { "user-agent": "x402-atlas/0.1" },
        signal: AbortSignal.timeout(10_000),
      });
      if (mres.ok) {
        const m = await mres.json<{
          default_price?: { amount?: string };
          recipient?: string;
          network?: { chain_id?: number };
        }>();
        if (m.default_price?.amount) {
          const { toUnits } = await import("./adapters");
          const units = toUnits(m.default_price.amount);
          result = {
            ok: true,
            status: mres.status,
            terms: {
              format: "v1",
              scheme: "exact",
              priceUnits: { min: units, max: units },
              network: m.network?.chain_id ? `eip155:${m.network.chain_id}` : null,
              asset: null,
              payTo: m.recipient?.toLowerCase() ?? null,
              facilitatorUrl: null,
            },
            latencyMs: result.latencyMs,
            error: "verified via x402.json manifest (direct challenge unreachable)",
          };
        }
      }
    } catch {
      // keep direct result
    }
  }
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO probes (endpoint_id, ts, status, ok, format, price_min_units, price_max_units, latency_ms, error)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      endpointId,
      now,
      result.status,
      result.ok ? 1 : 0,
      result.terms?.format ?? null,
      result.terms?.priceUnits.min ?? null,
      result.terms?.priceUnits.max ?? null,
      result.latencyMs,
      result.error ?? null,
    )
    .run();

  // Recompute 7d uptime + latest terms
  await env.DB.prepare(
    `UPDATE endpoints SET
       alive = ?2, last_probe_at = ?3, last_latency_ms = ?4,
       price_min_units = COALESCE(?5, price_min_units), price_max_units = COALESCE(?6, price_max_units),
       paywall_scheme = COALESCE(?7, paywall_scheme), asset = COALESCE(?8, asset),
       uptime_7d = (SELECT CAST(SUM(ok) AS REAL) / COUNT(*) FROM probes
                    WHERE endpoint_id = ?1 AND ts > ?9),
       updated_at = ?3
     WHERE id = ?1`,
  )
    .bind(
      endpointId,
      result.ok ? 1 : 0,
      now,
      result.latencyMs,
      result.terms?.priceUnits.min ?? null,
      result.terms?.priceUnits.max ?? null,
      result.terms?.scheme ?? null,
      result.terms?.asset ?? null,
      now - 7 * 24 * 3600 * 1000,
    )
    .run();

  // Link seller identity from observed payTo
  if (result.terms?.payTo) {
    await env.DB.prepare(
      `INSERT INTO sellers (address, first_seen_at, updated_at) VALUES (?1, ?2, ?2)
       ON CONFLICT(address) DO UPDATE SET updated_at = ?2`,
    ).bind(result.terms.payTo, now).run();
    await env.DB.prepare(`UPDATE services SET seller_address = ?2 WHERE id = ?1 AND seller_address IS NULL`)
      .bind(serviceId, result.terms.payTo).run();
  }
}
