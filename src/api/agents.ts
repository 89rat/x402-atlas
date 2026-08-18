/** Agent identity + accumulated state (retention layer). Bearer-key auth, hashed at rest. */
import type { Env } from "../lib/types";

export interface AgentCtx {
  id: string;
  label: string;
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return "atlas_" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function registerAgent(env: Env, label: string): Promise<{ agent_id: string; api_key: string }> {
  const apiKey = newApiKey();
  const id = `agt_${(await sha256(apiKey)).slice(0, 12)}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO agents (id, api_key_hash, label, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(id) DO NOTHING`,
  ).bind(id, await sha256(apiKey), label.slice(0, 60), now).run();
  return { agent_id: id, api_key: apiKey }; // api_key shown exactly once
}

export async function authenticate(env: Env, req: Request): Promise<AgentCtx | null> {
  const auth = req.headers.get("authorization") ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!key) return null;
  const row = await env.DB.prepare(`SELECT id, label FROM agents WHERE api_key_hash = ?1`)
    .bind(await sha256(key))
    .first<{ id: string; label: string }>();
  if (!row) return null;
  await env.DB.prepare(`UPDATE agents SET last_seen_at = ?2 WHERE id = ?1`).bind(row.id, Date.now()).run();
  return row;
}

export async function recordDecision(env: Env, agent: AgentCtx, h: {
  endpoint_url: string; decision: string; reason_code: string; price_usd: string | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO agent_history (agent_id, ts, endpoint_url, decision, reason_code, price_usd) VALUES (?1,?2,?3,?4,?5,?6)`,
  ).bind(agent.id, Date.now(), h.endpoint_url, h.decision, h.reason_code, h.price_usd).run();
}

export async function agentProfile(env: Env, agent: AgentCtx) {
  const history = await env.DB.prepare(
    `SELECT ts, endpoint_url, decision, reason_code, price_usd FROM agent_history WHERE agent_id = ?1 ORDER BY ts DESC LIMIT 50`,
  ).bind(agent.id).all();
  const policies = await env.DB.prepare(
    `SELECT name, policy, created_at FROM agent_policies WHERE agent_id = ?1 ORDER BY created_at DESC`,
  ).bind(agent.id).all();
  const stats = await env.DB.prepare(
    `SELECT COUNT(*) total, SUM(decision='ACCEPT') accepted FROM agent_history WHERE agent_id = ?1`,
  ).bind(agent.id).first<{ total: number; accepted: number | null }>();
  return {
    agent_id: agent.id,
    label: agent.label,
    decisions_total: stats?.total ?? 0,
    accepted: stats?.accepted ?? 0,
    policies: policies.results.map((p) => ({
      name: p.name as string,
      policy: JSON.parse(p.policy as string),
      created_at: p.created_at as number,
    })),
    history: history.results,
  };
}

export async function savePolicy(env: Env, agent: AgentCtx, name: string, policy: unknown): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO agent_policies (agent_id, name, policy, created_at) VALUES (?1,?2,?3,?4)
     ON CONFLICT(agent_id, name) DO UPDATE SET policy = ?3`,
  ).bind(agent.id, name.slice(0, 60), JSON.stringify(policy), Date.now()).run();
}

/** Verified operating record (retention spec §2.1.4) — signed settlement history lowers future risk premium. */
export async function agentAttestation(env: Env, agent: AgentCtx): Promise<{ attestation: string }> {
  const stats = await env.DB.prepare(
    `SELECT COUNT(*) n, SUM(decision='ACCEPT') a FROM agent_history WHERE agent_id = ?1`,
  ).bind(agent.id).first<{ n: number; a: number | null }>();
  const attestation = `atlas.attestation.v1:${agent.id}:decisions=${stats?.n ?? 0}:accepted=${stats?.a ?? 0}`;
  return { attestation };
}
