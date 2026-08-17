/**
 * Manifest fetcher + parsers for the four discovery formats:
 * /.well-known/x402(.json), openapi.json, llms.txt, agent.json (A2A card).
 */
import { z } from "zod";

export interface ParsedManifest {
  type: "x402" | "openapi" | "llms-txt" | "agent-card";
  title: string | null;
  description: string;
  categories: string[];
  endpoints: { path: string; method: string; description?: string; priceUnits?: { min: number; max: number } }[];
  sellerAddress?: string;
}

const x402ManifestSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  categories: z.array(z.string()).optional(),
  payTo: z.string().optional(),
  // Some manifests list endpoints explicitly…
  endpoints: z
    .array(
      z.object({
        path: z.string(),
        method: z.string().optional(),
        description: z.string().optional(),
        price: z.union([z.string(), z.number()]).optional(),
      }),
    )
    .optional(),
  // …others (e.g. agenttoll.dev) list payable resource URIs
  resources: z.array(z.string()).optional(),
});

export async function fetchManifest(baseUrl: string): Promise<{ raw: string | null; parsed: ParsedManifest | null }> {
  const root = baseUrl.replace(/\/+$/, "");
  const candidates: [string, ParsedManifest["type"]][] = [
    ["/.well-known/x402.json", "x402"],
    ["/.well-known/x402", "x402"],
    ["/openapi.json", "openapi"],
    ["/llms.txt", "llms-txt"],
    ["/.well-known/agent.json", "agent-card"],
  ];
  for (const [path, type] of candidates) {
    try {
      const res = await fetch(root + path, {
        headers: { "user-agent": "x402-atlas/0.1 (+discovery crawler)" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const raw = await res.text();
      const parsed = parseManifest(raw, type, root);
      if (parsed) return { raw, parsed };
    } catch {
      // try next candidate
    }
  }
  return { raw: null, parsed: null };
}

export function parseManifest(raw: string, type: ParsedManifest["type"], _root: string): ParsedManifest | null {
  switch (type) {
    case "x402": {
      const j = x402ManifestSchema.safeParse(JSON.parse(raw));
      if (!j.success) return null;
      const resourceEndpoints = (j.data.resources ?? []).map((uri) => {
        // resource URIs may be absolute (https://host/path#frag) — keep path+fragment as path
        try {
          const u = new URL(uri);
          return { path: u.pathname + u.hash, method: "GET" };
        } catch {
          return { path: uri, method: "GET" };
        }
      });
      return {
        type: "x402",
        title: j.data.name ?? null,
        description: j.data.description ?? "",
        categories: j.data.categories ?? [],
        sellerAddress: j.data.payTo?.toLowerCase(),
        endpoints: [...(j.data.endpoints ?? []).map((e) => ({
          path: e.path,
          method: e.method ?? "GET",
          description: e.description,
        })), ...resourceEndpoints],
      };
    }
    case "openapi": {
      const j = JSON.parse(raw) as {
        info?: { title?: string; description?: string };
        paths?: Record<string, Record<string, { summary?: string; description?: string }>>;
      };
      const endpoints: ParsedManifest["endpoints"] = [];
      for (const [path, methods] of Object.entries(j.paths ?? {})) {
        for (const [method, op] of Object.entries(methods)) {
          if (["get", "post", "put", "delete", "patch"].includes(method)) {
            endpoints.push({ path, method: method.toUpperCase(), description: op.summary ?? op.description });
          }
        }
      }
      return {
        type: "openapi",
        title: j.info?.title ?? null,
        description: j.info?.description ?? "",
        categories: [],
        endpoints,
      };
    }
    case "llms-txt": {
      const titleMatch = raw.match(/^#\s+(.+)$/m);
      const descMatch = raw.match(/^>\s*(.+)$/m);
      return {
        type: "llms-txt",
        title: titleMatch?.[1] ?? null,
        description: descMatch?.[1] ?? "",
        categories: [],
        endpoints: [],
      };
    }
    case "agent-card": {
      const j = JSON.parse(raw) as { name?: string; description?: string; skills?: { id?: string }[] };
      return {
        type: "agent-card",
        title: j.name ?? null,
        description: j.description ?? "",
        categories: (j.skills ?? []).map((s) => s.id).filter((x): x is string => !!x),
        endpoints: [],
      };
    }
  }
}
