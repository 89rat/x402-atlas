# x402 Atlas

Live, verified search engine for machine-payable (HTTP 402 / x402) APIs. The "Google + Bloomberg" layer for agentic commerce: agents ask *"best, cheapest, alive, trustworthy x402 endpoint for X right now?"* — Atlas answers with probe-verified truth, not seller claims.

## Why it wins
- **Measured, not claimed** — hourly probes hit every endpoint, validate the real 402 paywall, record price/latency/uptime
- **Adapter layer** — parses V1 (`accepts[]` body), V2 (`PAYMENT-REQUIRED` header), and the ecosystem's "GET = free buyer metadata / POST = 402 challenge" pattern (discovered live on agenttoll.dev). New spec versions = new adapter, never a rewrite
- **Agent-native** — JSON API, `/llms.txt`, and MCP server (`/mcp`) so Claude/Kimi/any agent can use it directly
- **On-chain ready** — seller identity = settlement address (`payTo`); phase-2 indexer tracks EIP-3009 `transferWithAuthorization` events (validated against a real tx: `0xc647…672d`, $0.005 USDC on Base)

## API
| Route | Description |
|---|---|
| `GET /v1/search?q=&chain=eip155:8453&price_max_usd=0.01&alive_only=true` | Ranked results (liveness ▸ uptime ▸ relevance ▸ freshness) |
| `GET /v1/services` / `/v1/services/history?id=` | Catalog / probe history |
| `GET /v1/stats` | Ecosystem stats |
| `POST /v1/submit` | Submit a service (`{"base_url": "https://…"}`) |
| `POST /mcp` | MCP server: `search_x402`, `get_ecosystem_stats` |
| `GET /llms.txt` | LLM-readable index |
| `GET /admin/crawl?service=&limit=&token=` | Run pipeline inline (set `ADMIN_TOKEN` in prod) |

## Develop
```bash
npm install
npx wrangler d1 migrations apply x402-atlas-db --local
npx wrangler dev          # then: curl localhost:8787/cdn-cgi/local/scheduled
curl "localhost:8787/admin/crawl?limit=3"
npm test
```

## Deploy (first time)
```bash
npx wrangler login
npx wrangler d1 create x402-atlas-db        # put id in wrangler.jsonc
npx wrangler kv namespace create CACHE      # put id in wrangler.jsonc
npx wrangler r2 bucket create x402-atlas-snapshots
npx wrangler queues create x402-atlas-crawl
npx wrangler vectorize create x402-atlas-services --dimensions=768 --metric=cosine
npx wrangler d1 migrations apply x402-atlas-db --remote
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

## Kaizen loop
Every search is logged (`search_log`); zero-result queries are demand signals. Weekly reports land in `kaizen/reports/`. Ranking: liveness(100) + uptime(×30) + relevance(×10) + freshness(×20) + price-verified(×10).

## Roadmap
Phase 2: EIP-3009 settled-volume indexer + trust_score · Phase 3: USDC-paid seller tools & micropaid API tier (via x402 itself) · Phase 4: `@x402-atlas/announce` SDK, Bazaar interop, multi-chain.
