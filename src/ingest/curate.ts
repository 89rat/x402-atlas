/**
 * Auto-curator: ingest verified sellers from agent402.tools on-chain leaderboard
 * (scans 302k Base blocks/7d — settled calls, USD volume, unique buyers per wallet).
 * Fixes the thin-catalog problem with quality-trusted seeds instead of blog posts.
 */
import type { Env } from "../lib/types";
import { slugify } from "./pipeline";

const LEADERBOARD_URL = "https://agent402.tools/api/leaderboard";

interface LeaderEntry {
  rank: number;
  name: string;
  origins: string[];
  homepage?: string;
  wallet: string;
  network: string;
  callsSettled: number;
  totalUsd: number;
  uniqueBuyers: number;
}

export interface CurateResult {
  ingested: number;
  skipped: number;
  sellersUpdated: number;
}

/** Trust score 0-100 from on-chain evidence: log-scaled settled USD volume + buyer diversity. */
export function trustScore(totalUsd: number, uniqueBuyers: number, callsSettled: number): number {
  if (totalUsd <= 0 && callsSettled <= 0) return 0;
  const volumeComponent = Math.min(60, Math.log10(1 + Math.max(totalUsd, 0)) * 12); // $100k+ → 60
  const buyerComponent = Math.min(25, Math.log10(1 + Math.max(uniqueBuyers, 0)) * 8); // 1000 buyers → 24
  const activityComponent = Math.min(15, Math.log10(1 + Math.max(callsSettled, 0)) * 3); // 1M calls → 18→15
  return Math.round(Math.min(100, volumeComponent + buyerComponent + activityComponent));
}

export async function curateFromLeaderboard(env: Env): Promise<CurateResult> {
  const res = await fetch(LEADERBOARD_URL, {
    headers: { "user-agent": "x402-atlas/0.1 (curator)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`leaderboard fetch failed: ${res.status}`);
  const data = await res.json<{ leaderboard: LeaderEntry[] }>();
  const now = Date.now();
  let ingested = 0, skipped = 0, sellersUpdated = 0;

  for (const e of data.leaderboard) {
    const baseUrl = e.homepage ?? e.origins[0];
    if (!baseUrl || !/^https:\/\//.test(baseUrl)) { skipped++; continue; }

    // Upsert seller with on-chain evidence
    await env.DB.prepare(
      `INSERT INTO sellers (address, chain, settled_volume_usdc, settled_tx_count, unique_buyers, trust_score, first_seen_at, updated_at)
       VALUES (?1, 'eip155:8453', ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT(address) DO UPDATE SET settled_volume_usdc = ?2, settled_tx_count = ?3, unique_buyers = ?4, trust_score = ?5, updated_at = ?6`,
    )
      .bind(
        e.wallet.toLowerCase(),
        String(Math.round(e.totalUsd * 1e6)), // exact integer units
        e.callsSettled,
        e.uniqueBuyers,
        trustScore(e.totalUsd, e.uniqueBuyers, e.callsSettled),
        now,
      )
      .run();
    sellersUpdated++;

    const id = slugify(e.name);
    const r = await env.DB.prepare(
      `INSERT INTO services (id, base_url, title, description, categories, submitter, seller_address, source_url, created_at, updated_at)
       VALUES (?1, ?2, ?3, '', ?4, 'leaderboard', ?5, ?6, ?7, ?7)
       ON CONFLICT(base_url) DO UPDATE SET seller_address = ?5, updated_at = ?7`,
    )
      .bind(id, baseUrl, e.name, JSON.stringify(["leaderboard"]), e.wallet.toLowerCase(), LEADERBOARD_URL, now)
      .run();
    if (r.meta.changes > 0 || (r.meta.changes ?? 0) >= 0) {
      // Queue manifest fetch for this service (dedup naturally via ON CONFLICT)
      const existing = await env.DB.prepare(`SELECT id FROM services WHERE base_url = ?1`).bind(baseUrl).first<{ id: string }>();
      if (existing) {
        await env.CRAWL_QUEUE.send({ kind: "manifest", serviceId: existing.id });
        ingested++;
      }
    }
  }
  return { ingested, skipped, sellersUpdated };
}
