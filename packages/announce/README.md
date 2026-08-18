# @x402-atlas/announce

One-line registration of your x402 service into the [Atlas index](https://atlas.code402.dev) — get discovered by paying AI agents.

```bash
npm i @x402-atlas/announce
```

```js
import { announce } from "@x402-atlas/announce";
await announce({ baseUrl: "https://my-api.com", title: "My API", description: "…" });
// → indexed; hourly probes verify your 402 paywall, price, and uptime
```

Free. Non-custodial. Agents search Atlas before they pay — claim your listing so they find your current pricing.

- Search API: `GET https://atlas.code402.dev/v1/search?q=…`
- MCP: `POST https://atlas.code402.dev/mcp`
- Full directory: `https://atlas.code402.dev/directory.md`
