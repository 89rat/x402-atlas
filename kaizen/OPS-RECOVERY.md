# Operations & Recovery Runbook (key-man risk mitigation)

**Owner:** drjsarat@gmail.com (Cloudflare account "Akrivis", id 3092b8a1c360e22a9f0c069bc589da23)
**Purpose:** if the primary operator is unavailable, this document lets any engineer restore/operate the system.

## Assets & locations
| Asset | Where | Recovery |
|---|---|---|
| x402-atlas source | `C:\Projects\x402-atlas` (git) | Push to GitHub remote (TODO: add remote + push — currently local-only!) |
| code402 source | `~/Documents/kimi/workspace/code402` (git) | Same — add remote |
| Cloudflare account | dash.cloudflare.com, OAuth via drjsarat@gmail.com | Add a second account member (TODO — needs owner action) |
| D1 databases | x402-atlas-db, code402-ledger-staging/prod | Built-in 30-day Time Travel (`wrangler d1 time-travel restore`) |
| R2 snapshots | x402-atlas-snapshots, code402-receipts-* | Bucket-level, durable by default |

## Secrets (all in `wrangler secret` store — recoverable only by reset, never read-out)
| Secret | Worker | If compromised |
|---|---|---|
| ADMIN_TOKEN | x402-atlas | `npx wrangler secret put ADMIN_TOKEN --name x402-atlas` (rotate) |
| ATLAS_SIGNING_KEY | x402-atlas | Rotate; old quotes/invitations invalidate on expiry (300s / 7d) |
| COMPANY_WALLET | code402-edge(-prod) | **CRITICAL: this is the USDC receiving address config.** Rotation requires updating and re-deploying |
| RECEIPT_SIGNING_KEY | code402-edge(-prod) | secp256k1 receipt-signing key; receipt verifier address in wrangler.toml `[vars]` must be updated together |
| RPC_PRIMARY/FALLBACK | code402 | Any Base RPC endpoint URLs |

## Critical wallets (ON-CHAIN — cannot be reset)
- code402 prod settlement: `0xdcd0fe977640add2dbe62ca0fb30c63f2fd9fdcf` (has real settled USDC)
- **Backup the private key/mnemonic NOW if not already in a hardware wallet or Safe.** Per BUILD-BLUEPRINT: move to a Safe multi-sig when balance > $1K.
- User funding wallet: `0xD654cD6E272571E1be074c5499Cb20fE855a4729`

## Restore procedures
```bash
# Atlas full rebuild from scratch (data recoverable via re-crawl; DB via Time Travel)
npx wrangler d1 time-travel restore x402-atlas-db --timestamp "<ISO>" --remote   # check exact syntax per wrangler version
npx wrangler deploy --config C:/Projects/x402-atlas/wrangler.jsonc

# code402 redeploy (staging/prod)
cd ~/Documents/kimi/workspace/code402 && npx wrangler deploy [--env production]

# Probe backlog catch-up
curl "https://atlas.code402.dev/admin/crawl?limit=10&token=$ADMIN_TOKEN"
```

## Immediate owner TODOs (key-man)
- [ ] Add GitHub remotes and push both repos (source is currently single-machine)
- [ ] Add second Cloudflare account member (Dashboard → Members)
- [ ] Verify wallet keys are backed up (hardware/Safe)
- [ ] Print/store this file offline
