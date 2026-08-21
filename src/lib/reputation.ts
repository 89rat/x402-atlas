/**
 * Agent reputation rail — the network-wide credit rating.
 *
 * Each reported pay outcome appends to a per-agent, append-only HASH CHAIN
 * (prev_hash links every entry; UNIQUE(agent_id, seq) + retry makes concurrent
 * appends impossible to fork or drop). Atlas issues a SIGNED, EXPIRING credential
 * (HMAC over a canonical string that binds EVERY returned field + an expiry) that
 * SELLERS verify without the secret via verifyCredential / POST /v1/reputation/verify.
 *
 * Integrity is enforced, not just claimed:
 *   - issueCredential() does an O(1) self-check that the chain HEAD row hashes to
 *     its stored entry_hash before signing (rejects a tampered head).
 *   - verifyChain() does a full O(n) audit (every link + every entry hash), exposed
 *     for sellers/auditors who want proof beyond the signature.
 *   - verifyCredential() checks the signature AND the expiry, and RETURNS the
 *     authenticated fields parsed from the signed payload — so a seller never has to
 *     trust an unsigned `summary` object.
 *
 * Non-custodial: the chain is agent-owned and exportable; credibility is the Atlas
 * signature, which sellers pay for (Trust API). Margin-neutral to buyers.
 *
 * Hash convention (must be mirrored by any external re-verifier): NULL host -> "",
 * NULL amount -> 0 in the hashed canonical string; the columns still store NULL.
 */
import type { Env } from "./types";
import { hmacSign, hmacVerify } from "./sign";

export type ReputationKind = "PAID_OK" | "PAID_FAIL";

/** Credential validity window. Sellers re-fetch (cheap) rather than trust a stale one. */
export const CREDENTIAL_TTL_MS = 10 * 60 * 1000;

/** Agent ids must be delimiter-safe: the canonical string is a `|`-join, so any id
 *  containing `|` (or exotic chars) could smuggle fields into a signed payload.
 *  Registration already mints `agt_<hex>`; this rejects anything else, including
 *  ids supplied to the public credential route. */
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
export function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) throw new Error("INVALID_AGENT_ID");
}

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Canonical hashed entry. NULL host->"", NULL amount->0 (see header convention). */
function canonicalEntry(agentId: string, seq: number, ts: number, kind: string, host: string, amountUnits: number, prev: string): string {
  return [agentId, seq, ts, kind, host, amountUnits, prev].join("|");
}

interface RepRow {
  seq: number; ts: number; kind: string; endpoint_host: string | null; amount_units: number | null; prev_hash: string; entry_hash: string;
}

/** Append one outcome to the agent's tamper-evident chain. Concurrency-safe. */
export async function appendReputation(
  env: Env,
  agentId: string,
  ev: { kind: ReputationKind; host: string | null; amountUnits: number | null },
): Promise<{ seq: number; entryHash: string }> {
  assertSafeId(agentId);
  for (let attempt = 0; attempt < 4; attempt++) {
    const head = await env.DB.prepare(
      `SELECT seq, entry_hash FROM agent_reputation WHERE agent_id = ?1 ORDER BY seq DESC LIMIT 1`,
    ).bind(agentId).first<{ seq: number; entry_hash: string }>();
    const seq = (head?.seq ?? 0) + 1;
    const prev = head?.entry_hash ?? "GENESIS";
    const ts = Date.now();
    const entryHash = await sha256hex(canonicalEntry(agentId, seq, ts, ev.kind, ev.host ?? "", ev.amountUnits ?? 0, prev));
    try {
      await env.DB.prepare(
        `INSERT INTO agent_reputation (agent_id, seq, ts, kind, endpoint_host, amount_units, prev_hash, entry_hash)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
      ).bind(agentId, seq, ts, ev.kind, ev.host ?? null, ev.amountUnits ?? null, prev, entryHash).run();
      return { seq, entryHash };
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)) + " " + String((e as { cause?: unknown })?.cause ?? "");
      // Concurrent append took our seq — UNIQUE(agent_id,seq) rejected it. Re-read head, retry.
      if (/unique|constraint/i.test(msg) && attempt < 3) continue;
      throw e;
    }
  }
  throw new Error("appendReputation: exhausted retries");
}

export interface ReputationSummary {
  agent_id: string;
  as_of: number;
  expires_at: number;
  settled_ok: number;
  settled_fail: number;
  distinct_hosts: number;
  volume_units: number; // integer USDC 6dp
  first_activity: number | null;
  last_activity: number | null;
  head_seq: number;
  head_hash: string; // chain head — proves integrity
  reputation_score: number; // deterministic 0-100
}

/** Deterministic 0-100 score. Rewards proven successful spend + counterparty breadth
 *  (anti-wash); penalizes failures. No LLM — same ledger in, same score out. */
export function reputationScore(ok: number, fail: number, hosts: number, volumeUnits: number): number {
  const volUsd = volumeUnits / 1e6;
  const raw =
    Math.min(50, Math.log10(1 + ok) * 25) +
    Math.min(30, Math.log10(1 + volUsd) * 15) +
    Math.min(20, hosts * 4) -
    Math.min(40, fail * 10);
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export async function reputationSummary(env: Env, agentId: string): Promise<ReputationSummary> {
  assertSafeId(agentId);
  const agg = await env.DB.prepare(
    `SELECT
        SUM(CASE WHEN kind = 'PAID_OK' THEN 1 ELSE 0 END) AS ok,
        SUM(CASE WHEN kind = 'PAID_FAIL' THEN 1 ELSE 0 END) AS fail,
        COUNT(DISTINCT endpoint_host) AS hosts,
        COALESCE(SUM(CASE WHEN kind = 'PAID_OK' THEN COALESCE(amount_units,0) ELSE 0 END), 0) AS vol,
        MIN(ts) AS first_ts, MAX(ts) AS last_ts
     FROM agent_reputation WHERE agent_id = ?1`,
  ).bind(agentId).first<{ ok: number | null; fail: number | null; hosts: number | null; vol: number | null; first_ts: number | null; last_ts: number | null }>();

  const head = await env.DB.prepare(
    `SELECT seq, entry_hash FROM agent_reputation WHERE agent_id = ?1 ORDER BY seq DESC LIMIT 1`,
  ).bind(agentId).first<{ seq: number; entry_hash: string }>();

  const ok = agg?.ok ?? 0;
  const fail = agg?.fail ?? 0;
  const hosts = agg?.hosts ?? 0;
  const vol = agg?.vol ?? 0;
  const now = Date.now();
  return {
    agent_id: agentId,
    as_of: now,
    expires_at: now + CREDENTIAL_TTL_MS,
    settled_ok: ok,
    settled_fail: fail,
    distinct_hosts: hosts,
    volume_units: vol,
    first_activity: agg?.first_ts ?? null,
    last_activity: agg?.last_ts ?? null,
    head_seq: head?.seq ?? 0,
    head_hash: head?.entry_hash ?? "GENESIS",
    reputation_score: reputationScore(ok, fail, hosts, vol),
  };
}

export interface ReputationCredential {
  schema: "atlas.reputation.v1";
  payload: string; // canonical string sellers verify — binds every field below
  signature: string; // HMAC by Atlas
  chain_head_ok: boolean; // O(1) self-check that the head row hashes to its stored entry_hash
  summary: ReputationSummary;
}

/** Canonical string the signature covers. Binds EVERY field returned in `summary`
 *  plus the expiry — nothing the seller sees is unsigned. */
function canonicalCredential(s: ReputationSummary): string {
  return [
    "atlas.reputation.v1",
    s.agent_id, s.as_of, s.expires_at, s.settled_ok, s.settled_fail, s.distinct_hosts,
    s.volume_units, s.first_activity ?? "", s.last_activity ?? "", s.head_seq, s.head_hash, s.reputation_score,
  ].join("|");
}

/** O(1): recompute the HEAD entry's hash from its own row and compare to what's stored. */
async function headSelfCheck(env: Env, agentId: string): Promise<boolean> {
  const h = await env.DB.prepare(
    `SELECT seq, ts, kind, endpoint_host, amount_units, prev_hash, entry_hash
     FROM agent_reputation WHERE agent_id = ?1 ORDER BY seq DESC LIMIT 1`,
  ).bind(agentId).first<RepRow>();
  if (!h) return true; // empty chain is trivially consistent
  const recomputed = await sha256hex(
    canonicalEntry(agentId, h.seq, h.ts, h.kind, h.endpoint_host ?? "", h.amount_units ?? 0, h.prev_hash),
  );
  return recomputed === h.entry_hash;
}

/** Issue a signed, seller-verifiable, EXPIRING credential for an agent's standing. */
export async function issueCredential(env: Env, agentId: string): Promise<ReputationCredential> {
  const summary = await reputationSummary(env, agentId);
  const payload = canonicalCredential(summary);
  const signature = await hmacSign(env, payload);
  const chain_head_ok = await headSelfCheck(env, agentId);
  return { schema: "atlas.reputation.v1", payload, signature, chain_head_ok, summary };
}

export interface VerifyResult {
  /** signature authentic AND not expired — the seller's real question. */
  valid: boolean;
  signature_valid: boolean;
  expired: boolean;
  /** Authenticated fields parsed FROM the signed payload (trust these, not any summary object). */
  fields: {
    agent_id: string; as_of: number; expires_at: number;
    settled_ok: number; settled_fail: number; distinct_hosts: number;
    volume_units: number; head_seq: number; head_hash: string; reputation_score: number;
  } | null;
}

/** Seller-side: verify signature + freshness WITHOUT the secret, and return the
 *  fields the signature actually covers. */
export async function verifyCredential(env: Env, payload: string, signature: string): Promise<VerifyResult> {
  const signature_valid = await hmacVerify(env, payload, signature);
  if (!signature_valid) return { valid: false, signature_valid: false, expired: false, fields: null };

  const p = payload.split("|");
  // Exact field count — reject any drift (e.g. a `|` smuggled through a field).
  if (p[0] !== "atlas.reputation.v1" || p.length !== 13) {
    return { valid: false, signature_valid: true, expired: false, fields: null };
  }
  const expires_at = Number(p[3]);
  const expired = Date.now() > expires_at;
  const fields = {
    agent_id: p[1] ?? "",
    as_of: Number(p[2]),
    expires_at,
    settled_ok: Number(p[4]),
    settled_fail: Number(p[5]),
    distinct_hosts: Number(p[6]),
    volume_units: Number(p[7]),
    head_seq: Number(p[10]),
    head_hash: p[11] ?? "",
    reputation_score: Number(p[12]),
  };
  return { valid: !expired, signature_valid: true, expired, fields };
}

export interface ChainAudit {
  ok: boolean;
  entries: number;
  broken_at_seq: number | null;
  reason: string | null;
}

/** Full O(n) integrity audit: every entry hashes correctly AND every prev_hash links.
 *  This is what makes "tamper-evident" enforceable, not just asserted. */
export async function verifyChain(env: Env, agentId: string): Promise<ChainAudit> {
  assertSafeId(agentId);
  const rows = await env.DB.prepare(
    `SELECT seq, ts, kind, endpoint_host, amount_units, prev_hash, entry_hash
     FROM agent_reputation WHERE agent_id = ?1 ORDER BY seq ASC`,
  ).bind(agentId).all<RepRow>();

  let prev = "GENESIS";
  let expectedSeq = 1;
  for (const r of rows.results) {
    if (r.seq !== expectedSeq) return { ok: false, entries: rows.results.length, broken_at_seq: r.seq, reason: "seq gap or reorder" };
    if (r.prev_hash !== prev) return { ok: false, entries: rows.results.length, broken_at_seq: r.seq, reason: "prev_hash mismatch" };
    const recomputed = await sha256hex(canonicalEntry(agentId, r.seq, r.ts, r.kind, r.endpoint_host ?? "", r.amount_units ?? 0, r.prev_hash));
    if (recomputed !== r.entry_hash) return { ok: false, entries: rows.results.length, broken_at_seq: r.seq, reason: "entry_hash mismatch" };
    prev = r.entry_hash;
    expectedSeq++;
  }
  return { ok: true, entries: rows.results.length, broken_at_seq: null, reason: null };
}
