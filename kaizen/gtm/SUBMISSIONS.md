# GTM Submission Pack — make Atlas inevitable
Every listing below is free. Submit in order. Each creates a permanent inbound link + LLM-corpus seeding.

## 1. awesome-x402 PR (highest value — the ecosystem's canonical list)
Repo: https://github.com/xpaysh/awesome-x402 (274 PRs open — submit ours distinctly)
**PR title:** Add x402 Atlas — live search engine + on-chain seller leaderboard
**Entry:**
```md
- **[x402 Atlas](https://atlas.code402.dev)** — Live search engine over x402 services: hourly 402-probe verification (measured prices, uptime), on-chain seller trust scores (settled USDC volume), deterministic purchase policy API (ACCEPT/REJECT/ESCALATE), and an MCP server (`search_x402`, `plan_purchase`) so any agent can discover and safely pay. Free API: `GET /v1/search?q=...`. One-line seller registration: `npm i @x402-atlas/announce`.
```

## 2. MCP registries (agents find tools here)
- **Glama** (glama.ai/mcp/servers) — submit `https://atlas.code402.dev/mcp`
- **Smithery** (smithery.ai) — registry submit, streamable HTTP
- **PulseMCP / MCP Registry** (registry.modelcontextprotocol.io)
- **Claude Desktop / Kimi Code users:** config already in `~/.kimi-code/mcp.json`

## 3. x402 ecosystem directories
- **x402-list.com** — contact/submit form, list Atlas as tooling
- **agent402.tools** — `/api/wish` endpoint exists; also their leaderboard is our data source (build relationship)
- **Coinbase CDP Bazaar / x402 Foundation** — propose Atlas as discovery layer, x402 Foundation Discord

## 4. Developer channels (one post each, no spam)
- x402 / Base / Coinbase Developer Platform Discords (#showcase channels)
- r/CryptoCurrency + r/ClaudeAI (agent tooling angle), Hacker News Show HN:
**Show HN title:** `Show HN: A search engine for APIs that AI agents pay per-call (x402)`
Body: verified prices via real 402 probes + on-chain trust + MCP tool — 3 links, no marketing prose.

## 5. Content flywheel (weekly, automated data only we have)
- `/reports/state-of-x402` — auto-generated weekly on-chain ecosystem report
- Post highlights weekly to LinkedIn/X with data charts (seller counts, settled volume trend)
- This is the "Bloomberg terminal" positioning: nobody else has probe history + settlement data

## 6. Seller-side outreach (turn the 25 leaderboard sellers into evangelists)
Each already has on-chain revenue. Email/DM template:
> Your API ranks #N on Atlas (atlas.code402.dev/leaderboard) with $X settled this week.
> Claim your profile free: npm i @x402-atlas/announce — keeps your pricing/uptime current for the agents searching Atlas daily.
(Accurate, data-backed, zero flattery — their incentive: correct listing = more agent buyers.)

## Metrics that matter (weekly kaizen check)
- New services self-registered via /v1/submit
- MCP connections (distinct clients hitting /mcp initialize)
- Search queries/week (search_log)
- Referring domains (Cloudflare analytics)
