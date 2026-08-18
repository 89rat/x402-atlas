import { describe, expect, it } from "vitest";
import { parsePaywall, toUnits, unitsToUsd } from "../src/ingest/adapters";

function res(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

describe("exact money math (lesson from tx 0xc647…672d: 5000 units = $0.005)", () => {
  it("converts micro-amounts exactly", () => {
    expect(toUnits("0.005")).toBe(5000);
    expect(toUnits("0.005000")).toBe(5000);
    expect(unitsToUsd(5000)).toBe("0.005");
    expect(unitsToUsd(5000000)).toBe("5");
  });
});

describe("paywall adapters", () => {
  it("parses V1 body format (accepts[])", () => {
    const body = JSON.stringify({
      x402Version: 1,
      error: "X-PAYMENT header is required",
      accepts: [{
        scheme: "exact",
        network: "eip155:8453",
        maxAmountRequired: "5000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0xDCd0FE977640AdD2dBE62ca0Fb30c63f2FD9FdcF",
        facilitatorURL: "https://facilitator.example.com",
      }],
    });
    const t = parsePaywall(res(402), body);
    expect(t?.format).toBe("v1");
    expect(t?.priceUnits.min).toBe(5000);
    expect(t?.payTo).toBe("0xdcd0fe977640add2dbe62ca0fb30c63f2fd9fdcf"); // lowercase canonical
    expect(t?.scheme).toBe("exact");
  });

  it("parses V2 header format (PAYMENT-REQUIRED)", () => {
    const t = parsePaywall(
      res(402, {
        "PAYMENT-REQUIRED": JSON.stringify([{
          scheme: "upto",
          network: "eip155:8453",
          maxAmountRequired: "50000",
          payTo: "0xabc0000000000000000000000000000000000abc",
        }]),
      }),
      null,
    );
    expect(t?.format).toBe("v2");
    expect(t?.scheme).toBe("upto");
    expect(t?.priceUnits.max).toBe(50000);
  });

  it("rejects non-402 and malformed 402", () => {
    expect(parsePaywall(res(200), "{}")).toBeNull();
    expect(parsePaywall(res(402), "not json")).toBeNull();
  });

  it("parses code402-style challenge (price:{amount}, recipient, X-PAYMENT voucher) — captured live 2026-08-17", () => {
    const body = JSON.stringify({
      eip712: { name: "USD Coin", version: "2" },
      network: { chain_id: 8453, name: "base" },
      nonce: "0xb38a…",
      payment_intent_id: "a2cc5838d922fd70",
      price: { amount: "10000", asset: "USDC", decimals: 6, token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
      proof: { header: "X-PAYMENT", type: "eip3009_voucher" },
      recipient: "0xdcd0fe977640add2dbe62ca0fb30c63f2fd9fdcf",
      tool: "context-distill",
      x402_version: 1,
    });
    const t = parsePaywall(res(402), body);
    expect(t?.format).toBe("v1");
    expect(t?.priceUnits.min).toBe(10000); // $0.01
    expect(t?.payTo).toBe("0xdcd0fe977640add2dbe62ca0fb30c63f2fd9fdcf");
    expect(t?.network).toBe("eip155:8453");
  });
});

describe("x402 v2 wire format (spec-verified shapes)", () => {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  it("parses PAYMENT-REQUIRED: base64(PaymentRequired) with v2 `amount` field", () => {
    const payload = {
      x402Version: 2,
      error: "PAYMENT-SIGNATURE header is required",
      resource: { url: "https://api.example.com/data", mimeType: "application/json" },
      accepts: [{
        scheme: "exact", network: "base", amount: "5000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0xAbC1230000000000000000000000000000000123",
        maxTimeoutSeconds: 60, extra: null,
      }],
    };
    const t = parsePaywall(new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": b64(payload) } }), null);
    expect(t?.format).toBe("v2");
    expect(t?.priceUnits.min).toBe(5000); // v2 `amount`, not maxAmountRequired
    expect(t?.payTo).toBe("0xabc1230000000000000000000000000000000123");
    expect(t?.scheme).toBe("exact");
  });

  it("parses PAYMENT-REQUIRED even when a deployment sends raw JSON", () => {
    const t = parsePaywall(new Response(null, {
      status: 402,
      headers: { "PAYMENT-REQUIRED": JSON.stringify({ accepts: [{ scheme: "exact", amount: "1000", network: "base" }] }) },
    }), null);
    expect(t?.priceUnits.min).toBe(1000);
  });

  it("parseSettlementResponse: base64(SettlementResponse) evidence", async () => {
    const { parseSettlementResponse } = await import("../src/ingest/adapters");
    const ok = new Response(null, { status: 200, headers: { "PAYMENT-RESPONSE": b64({
      success: true, transaction: "0xabc", network: "base", payer: "0xPAYER",
    }) } });
    const ev = parseSettlementResponse(ok);
    expect(ev?.success).toBe(true);
    expect(ev?.transaction).toBe("0xabc");
    expect(ev?.payer).toBe("0xpayer");
    const fail = new Response(null, { status: 402, headers: { "PAYMENT-RESPONSE": b64({
      success: false, transaction: "", network: "base", payer: "", errorReason: "insufficient_funds",
    }) } });
    expect(parseSettlementResponse(fail)?.errorReason).toBe("insufficient_funds");
  });

  it("v1 maxAmountRequired fixtures still parse (dual-rail transition)", () => {
    // existing v1 test remains green — both generations coexist
    const t = parsePaywall(res(402), JSON.stringify({ accepts: [{ scheme: "exact", maxAmountRequired: "5000" }] }));
    expect(t?.priceUnits.min).toBe(5000);
  });
});
