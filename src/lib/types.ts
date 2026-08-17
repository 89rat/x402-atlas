/** Shared types for x402 Atlas. */

/** USDC uses 6 decimals. All money stored as integer units (5000 = $0.005). */
export const USDC_DECIMALS = 6;

export type PaywallFormat = "v1" | "v2" | "unknown";

/** Normalized paywall terms extracted by an adapter. */
export interface PaywallTerms {
  format: PaywallFormat;
  scheme: "exact" | "upto" | "other";
  priceUnits: { min: number; max: number };
  /** CAIP-2 network, e.g. eip155:8453 */
  network: string | null;
  /** Asset identifier or token address */
  asset: string | null;
  /** Settlement (payTo) address — canonical seller identity */
  payTo: string | null;
  facilitatorUrl: string | null;
}

export interface ProbeResult {
  ok: boolean;
  status: number | null;
  terms: PaywallTerms | null;
  latencyMs: number;
  error?: string;
}

export interface SeedService {
  baseUrl: string;
  title: string;
  description?: string;
  categories?: string[];
  endpoints?: { path: string; method?: string; description?: string; probe_body?: unknown }[];
}

export interface Env {
  DB: D1Database;
  SNAPSHOTS: R2Bucket;
  CACHE: KVNamespace;
  VECTOR_INDEX: VectorizeIndex;
  CRAWL_QUEUE: Queue<QueueMessage>;
  ASSETS: Fetcher;
  ADMIN_TOKEN?: string;
  ATLAS_SIGNING_KEY?: string;
}

export interface QueueMessage {
  kind: "manifest" | "probe";
  serviceId: string;
  endpointId?: string;
}
