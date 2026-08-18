/**
 * @x402-atlas/announce — one-line registration into the x402 Atlas index.
 *
 *   import { announce } from "@x402-atlas/announce";
 *   await announce({ baseUrl: "https://my-api.com", title: "My API", description: "..." });
 *
 * Or CI: node --input-type=module -e "import('@x402-atlas/announce').then(m=>m.announce({baseUrl:process.env.BASE_URL}))"
 */
const ATLAS = "https://atlas.code402.dev";

export async function announce({ baseUrl, title, description, categories, endpoints, atlas = ATLAS } = {}) {
  if (!baseUrl || !/^https:\/\//.test(baseUrl)) {
    throw new Error("baseUrl must be a full https:// URL");
  }
  const res = await fetch(`${atlas}/v1/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ base_url: baseUrl, title, description, categories, endpoints }),
  });
  if (!res.ok) throw new Error(`Atlas submit failed: ${res.status} ${await res.text()}`);
  const out = await res.json();
  // Verify the 402 paywall is reachable so listing shows "verified alive" fast
  let alive = null;
  try {
    const probe = await fetch(baseUrl.replace(/\/+$/, "") + (endpoints?.[0]?.path ?? ""), { method: "GET" });
    alive = probe.status === 402;
  } catch { /* Atlas's hourly prober will verify anyway */ }
  return { ...out, paywall_detected: alive, index: atlas };
}

export default announce;
