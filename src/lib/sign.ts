/** HMAC-SHA256 signing for quotes and invitations (Web Crypto, Workers-native). */

export async function hmacSign(env: { ATLAS_SIGNING_KEY?: string }, canonical: string): Promise<string> {
  const key = env.ATLAS_SIGNING_KEY;
  if (!key) throw new Error("ATLAS_SIGNING_KEY not configured");
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacVerify(env: { ATLAS_SIGNING_KEY?: string }, canonical: string, signature: string): Promise<boolean> {
  const expected = await hmacSign(env, canonical);
  // Constant-time-ish compare
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
