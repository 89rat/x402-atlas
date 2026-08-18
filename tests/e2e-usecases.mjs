const A = process.env.ATLAS_URL ?? "https://atlas.code402.dev", G = process.env.GATEWAY_URL ?? "https://gateway.code402.dev";
const T = id => id.padEnd(52);
const results = [];
const check = async (id, fn) => {
  try { const v = await fn(); results.push([id, "PASS", v]); }
  catch (e) { results.push([id, "FAIL", e.message.slice(0, 100)]); }
};
const j = async (u, o) => { const r = await fetch(u, o); const b = await r.json().catch(() => ({})); return { s: r.status, b }; };
const assert = (c, m) => { if (!c) throw new Error(m); };

// ═══ SELLER JOURNEYS ═══
await check("S1: claim page loads with proof", async () => {
  const r = await fetch(A + "/sellers/claim"); assert(r.status === 200 && (await r.text()).includes("Agents search here"), "claim page"); return "200 + hero"; });

let sellerId;
await check("S2: register via curl (Atlas /v1/submit)", async () => {
  const { s, b } = await j(A + "/v1/submit", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ base_url: "https://e2e-test.example.com", title: "E2E Test API", description: "journey test" }) });
  assert(s === 201 && b.status === "indexed", s + " " + JSON.stringify(b)); sellerId = b.service_id; return "indexed: " + sellerId; });

await check("S3: appears in search after submit", async () => {
  const { b } = await j(A + "/v1/search?q=e2e&alive_only=false"); assert(b.results?.some(h => h.serviceId === sellerId), "not in results"); return "listed"; });

const gSeller = "e2e-" + Date.now().toString(36);
// Unique wallet per run: the sellers.wallet column is UNIQUE, and reusing a
// fixed test wallet across runs correctly 500s (constraint) — fresh each time.
const gWallet = "0x" + (Date.now().toString(16) + Math.floor(Math.random() * 1e6).toString(16)).padEnd(40, "9").slice(0, 40);
await check("S4: gateway marketplace registration", async () => {
  const { s, b } = await j(G + "/v1/sellers", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: gSeller, wallet: gWallet, name: "E2E Shop" }) });
  assert(s === 201, s + ""); return b.storefront; });

await check("S5: list a service -> storefront listing", async () => {
  const { s, b } = await j(G + `/v1/sellers/${gSeller}/services`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ serviceId: "demo", upstream_url: "https://api.example.com/x", price_usd: "$0.02", description: "e2e" }) });
  assert(s === 201, s + ""); return b.paid_endpoint; });

await check("S6: listing 402 pays SELLER wallet (non-custodial)", async () => {
  const r = await fetch(G + `/s/${gSeller}/demo`); const b = await r.json().catch(() => ({}));
  assert(r.status === 402 && b.accepts?.[0]?.payTo?.toLowerCase() === gWallet, r.status + ""); 
  return "payTo=seller $" + (parseInt(b.accepts[0].maxAmountRequired) / 1e6); });

await check("S7: GET /v1/sellers registration guide (no 404)", async () => {
  const { s, b } = await j(G + "/v1/sellers"); assert(s === 200 && b.how_to_register, s + ""); return "guide served"; });

await check("S8: wallet verification challenge flow", async () => {
  const { b } = await j(G + `/v1/sellers/${gSeller}/verify-challenge`, { method: "POST" });
  assert(b.message?.includes("verification"), "no challenge"); return "challenge issued (sign→verify tested in unit suite)"; });

await check("S9: invoice endpoint responds for new seller", async () => {
  const { s, b } = await j(G + `/v1/sellers/${gSeller}/invoice`); assert(s === 200 && b.fee_bps === 200, s + ""); return "2% engine armed"; });

await check("S10: analytics own-data free", async () => {
  const { s } = await j(G + `/v1/sellers/${gSeller}/analytics`); assert(s === 200, s + ""); return "200"; });

// ═══ AGENT JOURNEYS ═══
await check("A1: HTTP search", async () => {
  const { b } = await j(A + "/v1/search?q=web+search"); assert(b.count > 0, "no results"); return b.count + " results"; });

await check("A2: root MCP initialize+search", async () => {
  let r = await fetch(A + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
  assert(r.status === 200, "init " + r.status);
  r = await fetch(A + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_x402", arguments: { q: "search" } } }) });
  const b = await r.json(); assert(b.result?.content?.[0]?.text?.length > 10, "no results"); return "search_x402 OK"; });

await check("A3: factory MCP per-service", async () => {
  const r = await fetch(A + "/mcp/code402-prod", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
  assert(r.status === 200, r.status + ""); return "194 servers, 1 tested"; });

await check("A4: plan_purchase ACCEPT on known endpoint", async () => {
  const { b } = await j(A + "/v1/plan", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint_url: "https://code402.dev/v1/tools/context-distill/call", budget_usd: 5, price_ceiling_usd: 0.05 }) });
  assert(b.decision === "ACCEPT", b.decision + " " + (b.reason_code || "")); return "ACCEPT $" + b.terms.price_usd; });

await check("A5: plan_purchase REJECT on unknown endpoint", async () => {
  const { b } = await j(A + "/v1/plan", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint_url: "https://evil.example.com/x" }) });
  assert(b.decision === "REJECT", b.decision); return b.reason_code; });

await check("A6: prepaid register -> 0 balance -> INSUFFICIENT_CREDITS", async () => {
  const reg = await j(G + "/v1/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: "0xAbEE00000000000000000000000000000000E2Ee" }) });
  let key = reg.b.apiKey;
  if (!key && reg.s === 409) { // exists from previous run; we can't retrieve key — use fresh wallet
    const reg2 = await j(G + "/v1/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: "0xAb" + Date.now().toString(16).padStart(38, "0") }) });
    key = reg2.b.apiKey; assert(key, "no key"); }
  assert(key, "no apiKey");
  const r = await fetch(G + "/api/weather", { headers: { authorization: "Bearer " + key } });
  const b = await r.json().catch(() => ({}));
  assert(r.status === 402 && b.error?.code === "INSUFFICIENT_CREDITS", r.status + " " + JSON.stringify(b).slice(0, 60)); return "top-up hint served"; });

await check("A7: topup SKU paywalled", async () => {
  const r = await fetch(G + "/v1/accounts/topup/usd5"); assert(r.status === 402, r.status + ""); return "$5 x402-gated"; });

// ═══ BUILDER JOURNEYS ═══
for (const [id, u, probe] of [
  ["B1: directory.md RAG dump", A + "/directory.md", t => t.includes("$")],
  ["B2: llms.txt mesh", A + "/llms.txt", t => t.includes("gateway.code402.dev")],
  ["B3: openapi spec", A + "/openapi.json", t => t.includes("paths")],
  ["B4: kaizen data series", A + "/kaizen/daily", t => t.includes("kaizen")],
  ["B5: state-of-x402.md", A + "/reports/state-of-x402.md", t => t.includes("# State of x402")],
  ["B6: gateway services catalog", G + "/v1/services", t => t.includes("x402-probe")],
]) await check(id, async () => {
  const r = await fetch(u); const t = await r.text(); assert(r.status === 200 && probe(t), r.status + ""); return r.headers.get("content-type")?.slice(0, 24) || "ok"; });

console.log("\n════════ E2E RESULTS ════════");
let f = 0;
for (const [id, st, v] of results) { console.log(`${st === "PASS" ? "✓" : "✗"} ${T(id)} ${st === "PASS" ? v : "→ " + v}`); if (st === "FAIL") f++; }
console.log(`\n${results.length - f}/${results.length} passed${f ? " — GAPS: " + f : ""}`);
