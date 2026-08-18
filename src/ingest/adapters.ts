/**
 * Adapter layer — protocol-evolution resilience moat.
 * Each adapter knows how to detect and normalize one paywall/manifest format.
 * When the x402 v1.0 spec ships, add an adapter; never rewrite.
 */
import type { PaywallFormat, PaywallTerms } from "../lib/types";
import { USDC_DECIMALS } from "../lib/types";

/** Convert raw amount string to integer units, exact (no floats for money).
 * x402 wire format uses integer unit strings ("5000" = $0.005 USDC),
 * but we also tolerate decimal strings ("0.005"). */
export function toUnits(raw: string | number, decimals: number = USDC_DECIMALS): number {
  const s = typeof raw === "number" ? String(raw) : raw.trim();
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  let units: number;
  if (body.includes(".")) {
    const [intPart = "0", fracPart = ""] = body.split(".");
    const frac = (fracPart + "0".repeat(decimals)).slice(0, decimals);
    units = Number.parseInt(intPart + frac, 10);
  } else {
    // Integer string: already denominated in units (x402 wire format)
    units = Number.parseInt(body, 10);
  }
  return neg ? -units : units;
}

/** units -> human string, e.g. 5000 -> "0.005" */
export function unitsToUsd(units: number, decimals: number = USDC_DECIMALS): string {
  const neg = units < 0;
  const abs = Math.abs(units).toString().padStart(decimals + 1, "0");
  const out = `${abs.slice(0, -decimals)}.${abs.slice(-decimals)}`.replace(/\.?0+$/, "");
  return neg ? `-${out}` : out || "0";
}

interface RawRequirements {
  scheme?: string;
  network?: string;
  asset?: string;
  payTo?: string;
  /** v2 field name (spec-verified). */
  amount?: string | number;
  maxAmountRequired?: string | number;
  amountRequired?: string | number;
  maxUnitsRequired?: string | number;
  price?: string | number;
  facilitatorURL?: string;
  facilitatorUrl?: string;
  [k: string]: unknown;
}

/** Decode base64 (standard or url-safe) to text; null if invalid. */
function b64ToText(raw: string): string | null {
  try {
    const bin = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** V2 accepts[] entry: amount (NOT maxAmountRequired per v2 spec). */
function normalize(
  format: PaywallFormat,
  reqs: RawRequirements | RawRequirements[],
): PaywallTerms | null {
  const r = Array.isArray(reqs) ? (reqs[0] ?? null) : reqs;
  if (!r || typeof r !== "object") return null;
  // Field name per protocol generation (cross-verified against spec):
  // v2 accepts[] uses `amount`; v1 used `maxAmountRequired`.
  const amount =
    r.amount ?? r.maxAmountRequired ?? r.amountRequired ?? r.maxUnitsRequired ?? r.price ?? null;
  if (amount === null) return null;
  const units = toUnits(amount);
  return {
    format,
    scheme: (r.scheme === "upto" ? "upto" : r.scheme === "exact" ? "exact" : "other"),
    priceUnits: { min: units, max: units },
    network: r.network ?? null,
    asset: r.asset ?? null,
    payTo: typeof r.payTo === "string" ? r.payTo.toLowerCase() : null,
    facilitatorUrl: r.facilitatorURL ?? r.facilitatorUrl ?? null,
  };
}

/**
 * Detect and normalize a paywall from an HTTP response.
 * - v1: 402 with JSON body { error, x402Version, accepts: [...] }
 * - v2: 402 with PAYMENT-REQUIRED header (JSON)
 */
export function parsePaywall(res: Response, bodyText: string | null): PaywallTerms | null {
  if (res.status !== 402) return null;

  // V2: payment data lives in headers as base64(JSON) per transports-v2/http.md.
  // PAYMENT-REQUIRED carries PaymentRequired{ x402Version, resource, accepts[] }.
  // Fallbacks: raw JSON (some deployments), legacy X-PAY.
  const headerRaw =
    res.headers.get("PAYMENT-REQUIRED") ??
    res.headers.get("PAYMENT-REQUIRED-DATA") ??
    res.headers.get("X-PAY");
  if (headerRaw) {
    for (const candidate of [b64ToText(headerRaw), headerRaw]) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate) as unknown;
        const reqs = Array.isArray(parsed)
          ? (parsed as RawRequirements[])
          : ((parsed as { accepts?: RawRequirements[]; paymentRequirements?: RawRequirements[] }).accepts ??
             (parsed as { paymentRequirements?: RawRequirements[] }).paymentRequirements ?? [
            parsed as RawRequirements,
          ]);
        const t = normalize("v2", reqs);
        if (t) return t;
      } catch {
        // try next candidate / fall through
      }
    }
  }

  // V1: JSON body with accepts[]
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText) as {
        accepts?: RawRequirements[];
        paymentRequirements?: RawRequirements[];
        // code402-style challenge: { price: { amount }, recipient, proof: { header: X-PAYMENT } }
        price?: { amount?: string | number; asset?: string; decimals?: number; token_address?: string };
        recipient?: string;
        network?: { chain_id?: number; name?: string };
      };
      if (parsed.accepts ?? parsed.paymentRequirements) {
        return normalize("v1", parsed.accepts ?? parsed.paymentRequirements ?? []);
      }
      if (parsed.price?.amount !== undefined) {
        return {
          format: "v1",
          scheme: "exact",
          priceUnits: { min: toUnits(parsed.price.amount), max: toUnits(parsed.price.amount) },
          network: parsed.network?.chain_id ? `eip155:${parsed.network.chain_id}` : null,
          asset: parsed.price.token_address ?? parsed.price.asset ?? null,
          payTo: parsed.recipient?.toLowerCase() ?? null,
          facilitatorUrl: null,
        };
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

/** V2 SettlementResponse (PAYMENT-RESPONSE header, base64 JSON):
 * { success, transaction, network, payer, errorReason }. */
export interface SettlementEvidence {
  success: boolean;
  transaction: string | null;
  network: string | null;
  payer: string | null;
  errorReason: string | null;
}

export function parseSettlementResponse(res: Response): SettlementEvidence | null {
  const raw = res.headers.get("PAYMENT-RESPONSE");
  if (!raw) return null;
  const txt = b64ToText(raw) ?? raw;
  try {
    const j = JSON.parse(txt) as {
      success?: boolean; transaction?: string; network?: string; payer?: string; errorReason?: string;
    };
    return {
      success: j.success === true,
      transaction: j.transaction ?? null,
      network: j.network ?? null,
      payer: j.payer?.toLowerCase() ?? null,
      errorReason: j.errorReason ?? null,
    };
  } catch {
    return null;
  }
}

export const ADAPTERS_META: { format: PaywallFormat; version: string; specRef: string }[] = [
  { format: "v1", version: "1.0", specRef: "github.com/coinbase/x402 (accepts[] body)" },
  { format: "v2", version: "2.0", specRef: "x402.org/x402-v2 (PAYMENT-* headers, CAIP-2)" },
];
