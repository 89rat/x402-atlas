import { describe, expect, it } from "vitest";
import { calculateFee, CURRENT_FEE_POLICY, quoteId } from "../src/lib/fee";
import { expectedSurplusUnits } from "../src/lib/invite";

describe("deterministic fee engine (profit-spec guardrails)", () => {
  it("free tier while bootstrapping: zero fee for any notional", () => {
    expect(calculateFee(0, CURRENT_FEE_POLICY)).toBe(0);
    expect(calculateFee(5_000_000, CURRENT_FEE_POLICY)).toBe(0);
  });

  it("activated schedule: bps math is exact floor, clamped min/max + fixed", () => {
    const p = { ...CURRENT_FEE_POLICY, policy_version: 2, bps: 150, fixed_fee_units: 500, min_fee_units: 1000, max_fee_units: 50_000 };
    expect(calculateFee(0, p)).toBe(1500); // floor(0) -> min 1000 + fixed 500
    expect(calculateFee(100_000, p)).toBe(2000); // floor(1500) + 500
    expect(calculateFee(1_000_000_000, p)).toBe(50_500); // clamped max + fixed
  });

  it("rejects negative, non-integer, unsafe notionals", () => {
    expect(() => calculateFee(-1, CURRENT_FEE_POLICY)).toThrow();
    expect(() => calculateFee(1.5, CURRENT_FEE_POLICY)).toThrow();
    expect(() => calculateFee(Number.MAX_SAFE_INTEGER * 2, CURRENT_FEE_POLICY)).toThrow();
  });

  it("quote_id is deterministic (same input ⇒ same id ⇒ natural idempotency)", () => {
    expect(quoteId(5000, 1, "agent-a")).toBe(quoteId(5000, 1, "agent-a"));
    expect(quoteId(5000, 1, "agent-a")).not.toBe(quoteId(5000, 2, "agent-a"));
  });

  it("invitation surplus = savings - integration cost", () => {
    expect(expectedSurplusUnits({ expected_savings_units: 5000, integration_cost_estimate_units: 0 })).toBe(5000);
    expect(expectedSurplusUnits({ expected_savings_units: 500, integration_cost_estimate_units: 1000 })).toBe(-500);
  });
});
