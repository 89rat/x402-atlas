/** Prober: sends real requests, expects a valid 402 paywall, records price/latency.
 *  Handles the ecosystem pattern: GET returns free buyer metadata (200),
 *  POST triggers the actual 402 payment challenge (observed on agenttoll.dev). */
import { parsePaywall } from "./adapters";
import type { ProbeResult, PaywallTerms } from "../lib/types";

/** Extract terms from a 200 "buyer metadata" body (free pre-payment metadata). */
function parseBuyerMetadata(bodyText: string): PaywallTerms | null {
  try {
    const j = JSON.parse(bodyText) as {
      protocol?: string;
      price_usd?: string;
      network?: string;
      facilitator?: string;
      buyer_contract?: {
        scheme?: string;
        network?: string;
        priceUsd?: string;
        maxPaymentUsd?: string;
        payTo?: string;
      };
    };
    const c = j.buyer_contract;
    const price = c?.priceUsd ?? j.price_usd;
    if ((j.protocol !== "x402" && !c) || price === undefined) return null;
    return {
      format: "v1",
      scheme: c?.scheme === "exact" ? "exact" : c?.scheme === "upto" ? "upto" : "other",
      priceUnits: { min: Math.round(Number(price) * 1e6), max: Math.round(Number(c?.maxPaymentUsd ?? price) * 1e6) },
      network: c?.network ?? j.network ?? null,
      asset: null,
      payTo: c?.payTo?.toLowerCase() ?? null,
      facilitatorUrl: j.facilitator ?? null,
    };
  } catch {
    return null;
  }
}

export async function probeEndpoint(
  baseUrl: string,
  path: string,
  method: string = "GET",
  probeBody?: unknown,
): Promise<ProbeResult> {
  const url = baseUrl.replace(/\/+$/, "") + path;
  const bodyStr = probeBody !== undefined ? JSON.stringify(probeBody) : "{}";
  const started = Date.now();
  try {
    let res = await fetch(url, {
      method,
      headers: {
        "user-agent": "x402-atlas/0.1 (liveness probe)",
        ...(method !== "GET" ? { "content-type": "application/json" } : {}),
      },
      ...(method !== "GET" ? { body: bodyStr } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    let bodyText = res.status === 402 ? await res.text() : null;
    let terms = parsePaywall(res, bodyText);
    let latencyMs = Date.now() - started;

    if (!terms && res.status === 200) {
      // Free buyer metadata pattern: 200 with x402 terms; confirm with POST challenge
      const metaText = await res.text();
      const metaTerms = parseBuyerMetadata(metaText);
      if (metaTerms) {
        const startedPost = Date.now();
        res = await fetch(url, {
          method: "POST",
          headers: { "user-agent": "x402-atlas/0.1 (liveness probe)", "content-type": "application/json" },
          body: bodyStr,
          signal: AbortSignal.timeout(10_000),
        });
        bodyText = res.status === 402 ? await res.text() : null;
        terms = parsePaywall(res, bodyText) ?? metaTerms;
        latencyMs = Date.now() - startedPost;
      }
    }

    return {
      ok: terms !== null,
      status: res.status,
      terms,
      latencyMs,
      error: terms
        ? undefined
        : res.status === 402
          ? "402 without recognizable paywall"
          : `expected 402, got ${res.status}`,
    };
  } catch (e) {
    return {
      ok: false,
      status: null,
      terms: null,
      latencyMs: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
