/**
 * Build a stable, server-controlled anonymous scope for abuse controls.
 *
 * CF-Connecting-IP is supplied by Cloudflare Pages. The HMAC keeps the source
 * address out of D1 while preventing callers from choosing their own scope.
 */

export interface AbuseIdentityEnv {
  ABUSE_ID_SECRET?: string;
}

export type AbuseFeature = "helpful" | "reports" | "ai";

const MIN_SECRET_LENGTH = 32;

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function deriveAbuseActor(
  secret: string,
  feature: AbuseFeature,
  sourceIp: string,
): Promise<string | null> {
  const keyMaterial = secret.trim();
  const ip = sourceIp.trim();
  if (keyMaterial.length < MIN_SECRET_LENGTH || !ip) return null;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(keyMaterial),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`jxnu-abuse-v1\0${feature}\0${ip}`),
  );
  return `a1:${base64Url(signature)}`;
}

export async function abuseActor(
  request: Request,
  env: AbuseIdentityEnv,
  feature: AbuseFeature,
): Promise<string | null> {
  return deriveAbuseActor(
    env.ABUSE_ID_SECRET ?? "",
    feature,
    request.headers.get("CF-Connecting-IP") ?? "",
  );
}
