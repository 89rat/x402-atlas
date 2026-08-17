/**
 * Untrusted-metadata sanitizer (controls #51, #52, #12).
 * Seller-provided descriptions/manifest text is DATA, never instructions.
 * Everything we emit to agent contexts (MCP, llms.txt, search API) passes here.
 */

/** Patterns that look like instruction-injection inside seller metadata. */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all|any|previous|prior|above) (instructions?|prompts?|rules?)/i,
  /disregard (all|any|the) (previous|prior|above)/i,
  /system\s*prompt/i,
  /you (are|must) (now )?(a|an|the) /i,
  /new instructions?\s*:/i,
  /<\/?(system|assistant|developer|tool|function)_?\w*>/i, // fake role/tool tags
  /\bexecute\b.*\bcommand/i,
  /transfer (all )?(funds|usdc|tokens)/i,
  /send (your |the )?(wallet|private key|funds)/i,
  /private key|seed phrase|mnemonic/i,
];

/** Cap seller text length; strip control chars and markdown code fences. */
export function sanitizeSellerText(raw: string, maxLen = 400): string {
  if (!raw) return "";
  let t = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/```[\s\S]*?```/g, "") // no embedded code blocks
    .replace(/\s+/g, " ")
    .trim();
  for (const p of INJECTION_PATTERNS) {
    if (p.test(t)) {
      // Redact the whole sentence containing the injection-shaped content
      t = t
        .split(/(?<=[.!?])\s+/)
        .filter((s) => !p.test(s))
        .join(" ");
    }
  }
  return t.slice(0, maxLen).trim();
}

/** True if raw text would fail sanitization (for telemetry/red-team tests). */
export function looksInjected(raw: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(raw));
}
