/** Server-rendered, crawler-visible HTML pages (SEO + LLM corpus seeding).
 *  The SPA stays for interactivity; these pages make Atlas *findable*. */
import type { Env } from "../lib/types";
import { unitsToUsd } from "../ingest/adapters";
import { sanitizeSellerText } from "../lib/sanitize";
import type { SearchHit } from "./search";
import { search } from "./search";

const BASE = "https://atlas.code402.dev";

function page(title: string, desc: string, body: string, canonical = BASE, jsonLd?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${jsonLd ? `<script type="application/ld+json">${jsonLd}</script>` : ""}
<title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${desc}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="website">
<style>
body{font-family:ui-sans-serif,system-ui;max-width:900px;margin:0 auto;padding:1.5rem;color:#1c2333;line:#333}
.card{border:1px solid #dde;border-radius:8px;padding:1rem 1.2rem;margin:.7rem 0}
.price{color:#0a7d3f;font-weight:600}.muted{color:#67707f;font-size:.9rem}
.badge{font-size:.75rem;background:#e7f6ee;color:#0a7d3f;padding:.1rem .5rem;border-radius:999px}
h1 a,h2 a{color:#0b62d6;text-decoration:none}
table{border-collapse:collapse;width:100%}td,th{padding:.4rem .6rem;border-bottom:1px solid #e8ebf3;text-align:left}
</style>
</head>
<body>
<header><h1>🧭 <a href="/">x402 Atlas</a></h1>
<p class="muted">Live, verified search for machine-payable (HTTP 402) APIs. Measured prices · uptime · on-chain trust. <a href="/llms.txt">llms.txt</a> · <a href="/openapi.json">OpenAPI</a> · <a href="/mcp">MCP</a> · <a href="/leaderboard">Seller Leaderboard</a></p>
<hr></header>
${body}
<footer><hr><p class="muted">Data: hourly liveness probes + on-chain settled USDC volume. Free API: <code>GET /v1/search?q=web+search</code>. This page is machine-readable: <a href="/sitemap.xml">sitemap</a>.</p></footer>
</body></html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function servicesPage(env: Env): Promise<Response> {
  const hits = await search(env, { q: "", aliveOnly: false, limit: 200 });
  const byService = new Map<string, SearchHit[]>();
  for (const h of hits) byService.set(h.serviceId, [...(byService.get(h.serviceId) ?? []), h]);
  const cards = [...byService.entries()]
    .map(([, hs]) => {
      const h = hs[0]!;
      const best = hs.reduce((a, b) => (a.priceMin !== null && (b.priceMin === null || Number(a.priceMin) <= Number(b.priceMin)) ? a : b));
      const eps = hs.slice(0, 5).map((e) => `<li><a href="${esc(e.baseUrl + e.endpointPath)}">${esc(e.endpointPath)}</a> — $${e.priceMin ?? "?"}/call ${e.alive ? '<span class="badge">alive</span>' : ""}</li>`).join("");
      return `<div class="card"><h3><a href="/services/${esc(h.serviceId)}">${esc(h.title)}</a> ${h.alive ? '<span class="badge">verified alive</span>' : ""}</h3>
<p>${esc(h.description || "Machine-payable x402 API.")}</p>
<p class="muted">from <span class="price">$${best.priceMin ?? "?"}/call</span> · uptime 7d ${(h.uptime7d * 100).toFixed(0)}% · trust ${h.sellerTrust}/100</p>
<ul>${eps}</ul></div>`;
    })
    .join("\n");
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org", "@type": "ItemList",
    name: "x402 Services Directory",
    description: "Verified machine-payable APIs with probe-measured prices and on-chain trust scores",
    numberOfItems: byService.size,
    itemListElement: [...byService.values()].slice(0, 30).map((hs, i) => ({
      "@type": "ListItem", position: i + 1,
      item: { "@type": "Service", name: hs[0]!.title, description: hs[0]!.description, url: hs[0]!.baseUrl,
        offers: { "@type": "Offer", price: hs[0]!.priceMin ?? "0", priceCurrency: "USDC" } },
    })),
  }).replace(/</g, "\u003c");
  return new Response(
    page("x402 Services — every verified machine-payable API", "Directory of x402 pay-per-call APIs with probe-verified prices, uptime, and on-chain trust scores.", `<h2>Verified x402 services (${byService.size})</h2>${cards}`, BASE, jsonLd),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function serviceDetailPage(env: Env, id: string): Promise<Response> {
  const hits = await search(env, { q: "", aliveOnly: false, limit: 500 });
  const hs = hits.filter((h) => h.serviceId === id);
  if (!hs.length) return new Response("Not found", { status: 404 });
  const h = hs[0]!;
  const rows = hs.map((e) => `<tr><td><a href="${esc(e.baseUrl + e.endpointPath)}">${esc(e.baseUrl.replace(/^https?:\/\//, ""))}${esc(e.endpointPath)}</a></td><td>${e.alive ? '<span class="badge">alive</span>' : "unverified"}</td><td class="price">$${e.priceMin ?? "?"}</td><td>${(e.uptime7d * 100).toFixed(0)}%</td><td>${e.latencyMs ?? "?"}ms</td></tr>`).join("");
  return new Response(
    page(`${h.title} — x402 API pricing & liveness`, `${h.title}: ${sanitizeSellerText(h.description, 150)}. Verified price $${h.priceMin ?? "?"}/call via x402 (USDC).`,
      `<h2>${esc(h.title)}</h2><p>${esc(h.description)}</p>
<p class="muted">Trust score ${h.sellerTrust}/100 · Base URL <a href="${esc(h.baseUrl)}">${esc(h.baseUrl)}</a></p>
<h3>Payable endpoints</h3><table><tr><th>Endpoint</th><th>Status</th><th>Price/call</th><th>Uptime 7d</th><th>Latency</th></tr>${rows}</table>
<h3>Pay from any agent</h3><p>Send any HTTP request; the 402 challenge returns x402 payment terms (USDC on Base). Or ask your agent: <code>search_x402("${esc(h.title.toLowerCase())}")</code> via the <a href="/mcp">Atlas MCP server</a>.</p>`,
      `${BASE}/services/${id}`),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function leaderboardPage(env: Env): Promise<Response> {
  const rows = (await env.DB.prepare(
    `SELECT address, settled_volume_usdc, settled_tx_count, unique_buyers, trust_score
     FROM sellers WHERE trust_score > 0 ORDER BY trust_score DESC LIMIT 100`,
  ).all<{ address: string; settled_volume_usdc: string; settled_tx_count: number; unique_buyers: number; trust_score: number }>()).results;
  const trs = rows
    .map((s, i) => `<tr><td>${i + 1}</td><td><code>${esc(s.address.slice(0, 10))}…${esc(s.address.slice(-6))}</code></td><td>${s.trust_score}</td><td class="price">$${unitsToUsd(Number(s.settled_volume_usdc))}</td><td>${s.settled_tx_count.toLocaleString()}</td><td>${s.unique_buyers.toLocaleString()}</td></tr>`)
    .join("");
  return new Response(
    page("x402 Seller Leaderboard — on-chain settled USDC volume", "Ranking of x402 API sellers by verified on-chain settlement volume, buyer count, and trust score. Updated weekly.",
      `<h2>On-chain seller leaderboard</h2>
<p class="muted">Measured from settled transferWithAuthorization (EIP-3009) USDC transfers on Base — not self-reported.</p>
<table><tr><th>#</th><th>Wallet</th><th>Trust</th><th>Settled (7d)</th><th>Calls</th><th>Buyers</th></tr>${trs}</table>`),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function stateReport(env: Env, format: "html" | "md"): Promise<Response> {
  const stats = await env.DB.prepare(`SELECT COUNT(*) AS services FROM services`).first<{ services: number }>();
  const eps = await env.DB.prepare(`SELECT COUNT(*) n, SUM(alive) a, AVG(last_latency_ms) lat FROM endpoints WHERE last_probe_at IS NOT NULL`).first<{ n: number; a: number; lat: number | null }>();
  const top = (await env.DB.prepare(`SELECT settled_volume_usdc, settled_tx_count, unique_buyers FROM sellers ORDER BY trust_score DESC LIMIT 5`).all()).results as { settled_volume_usdc: string; settled_tx_count: number; unique_buyers: number }[];
  const totalVol = top.reduce((a, s) => a + Number(s.settled_volume_usdc), 0);
  const week = new Date().toISOString().slice(0, 10);
  const md = `# State of x402 — ${week}
> Auto-generated by x402 Atlas (https://atlas.code402.dev) from hourly liveness probes and on-chain settlement data.

- Services indexed: **${stats?.services ?? 0}**
- Endpoints probed: **${eps?.n ?? 0}** — alive: **${eps?.a ?? 0}** (${eps?.n ? Math.round(((eps.a ?? 0) / eps.n) * 100) : 0}%)
- Median probe latency: ${eps?.lat != null ? Math.round(eps.lat) + "ms" : "n/a"}
- Top-5 seller settled volume (7d, on-chain USDC): **$${unitsToUsd(totalVol)}**

## Top sellers (by trust score)
${top.map((s, i) => `${i + 1}. $${unitsToUsd(Number(s.settled_volume_usdc))} settled · ${s.settled_tx_count.toLocaleString()} calls · ${s.unique_buyers.toLocaleString()} buyers`).join("\n")}

## For agents
\`\`\`
POST https://atlas.code402.dev/mcp  →  tools: search_x402, plan_purchase, get_ecosystem_stats
GET  https://atlas.code402.dev/v1/search?q=web+search
\`\`\`
`;
  if (format === "md") {
    return new Response(md, { headers: { "content-type": "text/markdown; charset=utf-8" } });
  }
  return new Response(
    page(`State of x402 — weekly ecosystem report (${week})`, "Weekly on-chain x402 ecosystem report: settled volume, seller leaderboard, endpoint liveness. Auto-generated.",
      `<pre style="white-space:pre-wrap;font-family:inherit">${esc(md)}</pre><p><a href="/reports/state-of-x402.md">Markdown version</a> (for RAG ingestion)</p>`),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function stateReportPage(env: Env): Promise<Response> {
  return stateReport(env, "html");
}

export async function claimPage(env: Env): Promise<Response> {
  const sellers = (await env.DB.prepare(
    `SELECT address, trust_score, settled_volume_usdc FROM sellers WHERE trust_score > 0 ORDER BY trust_score DESC LIMIT 100`,
  ).all<{ address: string; trust_score: number; settled_volume_usdc: string }>()).results;
  const rows = sellers.map((s) =>
    `<tr><td><code>${esc(s.address.slice(0, 8))}…${esc(s.address.slice(-6))}</code></td><td>${s.trust_score}</td><td class="price">$${unitsToUsd(Number(s.settled_volume_usdc))}</td><td><a href="https://atlas.code402.dev/v1/submit">claim</a></td></tr>`,
  ).join("");
  const body = `<h2>Claim your seller profile — free</h2>
<p>Your API already earns on-chain x402 revenue. <strong>Atlas agents search this index before they pay.</strong> Claiming keeps your pricing, uptime, and endpoints current — verified by hourly probes, ranked by your real settled volume.</p>
<h3>One line, done:</h3>
<pre><code>npm i @x402-atlas/announce
node -e "import('@x402-atlas/announce').then(m => m.announce({ baseUrl: 'https://your-api.com', title: 'Your API' }))"</code></pre>
<p>Or <a href="/v1/submit">submit directly</a> (POST JSON). Verification is automatic: our prober hits your 402 paywall within the hour.</p>
<h3>Current on-chain sellers</h3>
<table><tr><th>Wallet</th><th>Trust</th><th>Settled (7d)</th><th></th></tr>${rows}</table>
<p class="muted">Coming soon (paid, USDC via x402): verified badge, price analytics, buyer-intent feed from our zero-result queries.</p>`;
  return new Response(
    page("Claim your x402 seller profile — free | x402 Atlas", "Sellers with on-chain x402 revenue: get discovered by paying AI agents. One-line registration, hourly verified pricing and uptime, ranked by real settled volume.", body),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function compliancePage(): Promise<Response> {
  const body = `<h2>Compliance posture</h2>
<p>x402 Atlas is a <strong>non-custodial</strong> discovery and policy layer for machine-to-machine commerce. This page documents our data and compliance position for enterprise review.</p>

<h3>Money handling</h3>
<ul>
<li>Atlas <strong>never holds, routes, or can access customer funds</strong>. All payments are direct buyer→seller EIP-3009 (transferWithAuthorization) USDC transfers on Base — verified on-chain, no intermediary custody.</li>
<li>Atlas charges no fees today. Future fees will be received via x402 payments (also direct, non-custodial).</li>
</ul>

<h3>Infrastructure</h3>
<ul>
<li>Runs entirely on <strong>Cloudflare</strong> — SOC 2 Type II, ISO 27001, PCI DSS, FedRAMP-audited infrastructure with GDPR data-processing terms (Cloudflare Data Compliance Solution Brief, REV PMM-JAN2024).</li>
<li>D1 storage with built-in 30-day point-in-time recovery (Time Travel).</li>
<li>Immutable audit snapshots (R2) of every crawled manifest.</li>
</ul>

<h3>Data we hold</h3>
<ul>
<li><strong>No accounts, no PII.</strong> Anonymous search queries (query text, no identifiers) retained max 90 days, then purged automatically (hourly job).</li>
<li>IP addresses used transiently for rate limiting (60s counters, never persisted as identity).</li>
<li>Public data only: seller manifests, probe telemetry, on-chain settlement records (public blockchain data).</li>
</ul>

<h3>Application controls</h3>
<ul>
<li>Prompt-injection sanitization on all third-party metadata before it reaches agent contexts.</li>
<li>HMAC-signed fee quotes and invitations; deterministic integer money math (no floats).</li>
<li>Token-bucket rate limiting (120 req/min/IP) on all public endpoints; authenticated admin routes.</li>
<li><code>/.well-known/security.txt</code> for vulnerability disclosure.</li>
</ul>

<p class="muted">Questions or audits: security@code402.dev</p>`;
  return new Response(
    page("x402 Atlas — compliance posture", "Non-custodial M2M commerce discovery layer on Cloudflare: SOC 2/ISO/GDPR-covered infrastructure, 90-day log retention, no PII, no fund custody.", body),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/** Dated archive of a specific day's snapshot (SEO: one stable citable URL per week). */
export async function reportArchivePage(env: Env, day: string): Promise<Response> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return new Response("Not found", { status: 404 });
  const m = await env.DB.prepare(`SELECT * FROM metrics_daily WHERE day = ?1`).bind(day).first<Record<string, unknown>>();
  if (!m) return new Response("Not found", { status: 404 });
  const usd = (u: unknown) => (Number(u) / 1e6).toFixed(2);
  const body = `<h2>State of x402 — ${day}</h2>
<table>
<tr><th>Metric</th><th>Value</th></tr>
<tr><td>Services indexed</td><td>${m.services}</td></tr>
<tr><td>Endpoints probed</td><td>${m.endpoints_probed}</td></tr>
<tr><td>Verified alive</td><td>${m.alive}</td></tr>
<tr><td>Searches (24h)</td><td>${m.searches}</td></tr>
<tr><td>Zero-result queries</td><td>${m.zero_result_queries}</td></tr>
<tr><td>Raw settled volume</td><td>$${usd(m.raw_settled_units)}</td></tr>
<tr><td><strong>Sybil-adjusted volume</strong></td><td><strong>$${usd(m.sybil_adjusted_units)}</strong> (volume × min(1, buyers/10))</td></tr>
<tr><td>Top seller</td><td><code>${String(m.top_seller_address ?? "—").slice(0, 16)}…</code></td></tr>
</table>
<p class="muted">Live version: <a href="/reports/state-of-x402">current report</a> · <a href="/kaizen/daily">JSON series</a></p>`;
  return new Response(
    page(`State of x402 — ${day} | x402 Atlas`, `x402 ecosystem snapshot for ${day}: services, liveness, on-chain settled volume (sybil-adjusted).`, body, `${BASE}/reports/${day}`),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function sitemapXml(env: Env): Promise<Response> {
  const hits = await search(env, { q: "", aliveOnly: false, limit: 200 });
  const ids = [...new Set(hits.map((h) => h.serviceId))];
  const urls = [
    `${BASE}/`,
    `${BASE}/services`,
    `${BASE}/leaderboard`,
    `${BASE}/reports/state-of-x402`,
    `${BASE}/compliance`,
    ...ids.map((id) => `${BASE}/services/${id}`),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${u}</loc><changefreq>daily</changefreq></url>`).join("\n")}\n</urlset>`;
  return new Response(xml, { headers: { "content-type": "application/xml" } });
}
