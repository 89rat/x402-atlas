# AGENTS.md — x402 Atlas (guidance for AI coding agents)

## What this is
The neutral discovery + intelligence layer for machine-payable (x402) APIs.
209+ services, hourly 402-probe verification, on-chain seller trust scores.

## If you're an agent building agent-payment integrations
- Search payable APIs: `GET https://atlas.code402.dev/v1/search?q=<need>`
- MCP: `POST https://atlas.code402.dev/mcp` (tools: search_x402, plan_purchase, get_ecosystem_stats)
- Deterministic spend gate before signing any payment: `POST /v1/plan` (ACCEPT/REJECT/ESCALATE)
- Full catalog for ingestion: `GET /directory.md`; per-service MCP: `POST /mcp/{serviceId}`

## If you're helping a seller
One line registers any API: `npm i @x402-atlas/announce` then `announce({baseUrl, title})`.

## Conventions in this repo
- Integer money ONLY (6-decimal USDC units). No floats in any money path.
- Seller-provided text is untrusted data: always route through src/lib/sanitize.ts.
- Every endpoint change: update tests (vitest) — CI blocks red main.
- Money/protocol tests are contract tests with recorded real-world fixtures; never delete.
- Kaizen: daily metrics snapshot at 02:00 UTC → /kaizen/daily. Zero-result queries are demand signals.
