/** Daily kaizen snapshot — the compounding intelligence loop. */
import type { Env } from "../lib/types";
import { sybilAdjustedVolume } from "./bazaar";

export async function dailyKaizen(env: Env): Promise<void> {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const stats = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM services) services,
            (SELECT COUNT(*) FROM endpoints WHERE last_probe_at IS NOT NULL) probed,
            (SELECT COALESCE(SUM(alive),0) FROM endpoints WHERE last_probe_at IS NOT NULL) alive,
            (SELECT COUNT(*) FROM search_log WHERE zero_results=1 AND ts > ?1) zero_q,
            (SELECT COUNT(*) FROM search_log WHERE ts > ?1) searches`,
  ).bind(now.getTime() - 24 * 3600_000).first<{
    services: number; probed: number; alive: number; zero_q: number; searches: number;
  }>();
  const vol = await sybilAdjustedVolume(env);
  const top = await env.DB.prepare(
    `SELECT address FROM sellers ORDER BY trust_score DESC LIMIT 1`,
  ).first<{ address: string }>();
  await env.DB.prepare(
    `INSERT INTO metrics_daily (day, ts, services, endpoints_probed, alive, zero_result_queries, searches, raw_settled_units, sybil_adjusted_units, top_seller_address)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
     ON CONFLICT(day) DO UPDATE SET ts=?2, services=?3, endpoints_probed=?4, alive=?5, zero_result_queries=?6, searches=?7, raw_settled_units=?8, sybil_adjusted_units=?9, top_seller_address=?10`,
  ).bind(day, now.getTime(), stats?.services ?? 0, stats?.probed ?? 0, stats?.alive ?? 0,
    stats?.zero_q ?? 0, stats?.searches ?? 0, vol.raw, vol.adjusted, top?.address ?? null).run();
}
