import { describe, expect, it } from "vitest";
import { trustScore } from "../src/ingest/curate";

describe("on-chain trust score", () => {
  it("zero evidence = zero trust", () => {
    expect(trustScore(0, 0, 0)).toBe(0);
  });

  it("scales monotonically with volume (the agent402 #1: $27k, 163 buyers, 2.4M calls)", () => {
    const top = trustScore(27170, 163, 2425681);
    const mid = trustScore(500, 20, 10000);
    const small = trustScore(1, 1, 10);
    expect(top).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(small);
    expect(top).toBeLessThanOrEqual(100);
    expect(top).toBeGreaterThan(60); // strong on-chain evidence should rank visibly
  });

  it("saturates at 100, deterministic for identical inputs", () => {
    const huge = trustScore(1e9, 1e6, 1e9);
    expect(huge).toBe(100);
    expect(huge).toBe(trustScore(1e9, 1e6, 1e9));
  });

  it("real Kimi/code402 evidence: $0.005 settled, 1 buyer, 1 call — nonzero but tiny", () => {
    const s = trustScore(0.005, 1, 1);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(20);
  });
});
