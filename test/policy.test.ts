import { describe, expect, it } from "vitest";
import { PlanInput } from "../src/api/policy";

describe("policy engine output contract (controls #31-40) — golden set", () => {
  it("accepts a well-formed plan input", () => {
    const p = PlanInput.safeParse({
      endpoint_url: "https://code402.dev/v1/tools/context-distill/call",
      budget_usd: 5,
      price_ceiling_usd: 0.01,
    });
    expect(p.success).toBe(true);
  });

  it("rejects non-URL endpoints and bad ranges (schema failure tests)", () => {
    expect(PlanInput.safeParse({ endpoint_url: "not-a-url" }).success).toBe(false);
    expect(PlanInput.safeParse({ endpoint_url: "https://x.dev/a", min_uptime: 1.5 }).success).toBe(false);
    expect(PlanInput.safeParse({ endpoint_url: "https://x.dev/a", budget_usd: -1 }).success).toBe(false);
  });

  it("applies defaults deterministically", () => {
    const p = PlanInput.parse({ endpoint_url: "https://x.dev/a" });
    expect(p.min_uptime).toBe(0.9);
    expect(p.escalation_threshold_usd).toBe(1);
    expect(p.max_probe_age_hours).toBe(26);
  });
});
