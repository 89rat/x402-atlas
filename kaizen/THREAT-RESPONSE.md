# Threat-Response Playbook (SWOT threats T1–T5, pre-committed strategies)

## T1/T3: Coinbase/Cloudflare ship native discovery; agent402/x402scan add probes+MCP
**Response: neutrality + data depth.** Rails operators can't be a neutral intelligence layer (their sellers would distrust a ranking they appear in). Our moats to deepen weekly:
- Probe *history* (they'd start at zero) — never delete probes table
- Multi-source aggregation (we index *their* data: leaderboard, lists, bazaar)
- The `plan_purchase` policy layer — buyers' side, which rails have no incentive to build
- **Trigger:** if a directory ships hourly probes + trust scores → differentiate on buyer tooling (policy engine, attestations, surplus proofs)

## T2: Agentic-commerce adoption stalls
**Response: cost floor is ~$0.** Atlas runs on Workers free/low tier; no burn means infinite patience. code402 keeps earning whatever the ecosystem does. Signal to watch: weekly settled volume trend in /v1/stats.

## T4: Protocol shift (V2 → v1.0, new discovery conventions)
**Response: adapter layer + conformance suite.** All format parsing is behind adapters.ts with recorded fixtures. Playbook when v1.0 ships: fetch spec → write adapter → add fixtures → run contract tests → deploy. Budget: 1 day. The 3 real-world formats we already parse (V1 body, V2 headers, code402 challenge, buyer-metadata-200) prove the pattern.

## T5: Adversarial sellers (injection, price gaming, fake liveness)
**Response: sanitizer (live) + trust scores (live, on-chain = expensive to fake). Residual:**
- Price gaming (bait cheap probe, charge more at call): next iteration — prober should compare challenge price vs settled amounts on-chain
- Liveness spoofing (serve 402 to our UA only): rotate probe user-agents; compare with fresh-agent probes
