/**
 * Shared human-verification configuration for Pages Functions.
 *
 * The Go admin panel writes these values to D1 `app_settings`; keeping the
 * resolver here means the review and student-record endpoints cannot drift
 * apart when the provider is switched from Turnstile to Cap.
 */

export type CaptchaProvider = "off" | "turnstile" | "cap";
export type CaptchaFeature = "reviews" | "student-record";

export interface CaptchaConfig {
  provider: CaptchaProvider;
  reviewsEnabled: boolean;
  studentRecordEnabled: boolean;
  turnstileSiteKey: string;
  turnstileSecret: string;
  capApiEndpoint: string;
  capSiteKey: string;
  capSecret: string;
  capWasmUrl: string;
  configured: boolean;
}

interface CaptchaEnv {
  DB: D1Database;
  CAPTCHA_PROVIDER?: string;
  CAPTCHA_REVIEWS_ENABLED?: string;
  CAPTCHA_STUDENT_ENABLED?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  CAP_API_ENDPOINT?: string;
  CAP_SITE_KEY?: string;
  CAP_SECRET?: string;
  CAP_WASM_URL?: string;
}

const SETTINGS = [
  "captcha_provider",
  "captcha_reviews_enabled",
  "captcha_student_enabled",
  "turnstile_site_key",
  "turnstile_secret",
  "cap_api_endpoint",
  "cap_site_key",
  "cap_secret",
  "cap_wasm_url",
] as const;

type SettingKey = (typeof SETTINGS)[number];

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function enabled(value: string): boolean {
  return value === "on" || value === "true" || value === "1";
}

async function readSettings(db: D1Database): Promise<Partial<Record<SettingKey, string>>> {
  try {
    const rows = await db
      .prepare("SELECT key, value FROM app_settings WHERE key IN (" + SETTINGS.map(() => "?").join(",") + ")")
      .bind(...SETTINGS)
      .all<{ key: string; value: string }>();
    const out: Partial<Record<SettingKey, string>> = {};
    for (const row of rows.results ?? []) {
      if ((SETTINGS as readonly string[]).includes(row.key)) {
        out[row.key as SettingKey] = clean(row.value);
      }
    }
    return out;
  } catch {
    // Local Vite / an old D1 without app_settings should simply use env fallbacks.
    return {};
  }
}

function value(
  settings: Partial<Record<SettingKey, string>>,
  key: SettingKey,
  fallback: string | undefined,
): string {
  // An explicitly stored empty value is meaningful (it lets the panel turn off
  // an environment fallback), so distinguish “missing row” from “empty row”.
  return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] ?? "" : clean(fallback);
}

function explicit(settings: Partial<Record<SettingKey, string>>, key: SettingKey): boolean {
  return Object.prototype.hasOwnProperty.call(settings, key);
}

function normalizeProvider(raw: string): CaptchaProvider | "" {
  if (raw === "off" || raw === "turnstile" || raw === "cap") return raw;
  return "";
}

/** Resolve D1 settings plus development-only environment fallbacks. */
export async function loadCaptchaConfig(env: CaptchaEnv): Promise<CaptchaConfig> {
  const settings = await readSettings(env.DB);
  const turnstileSiteKey = value(settings, "turnstile_site_key", env.TURNSTILE_SITE_KEY);
  const turnstileSecret = value(settings, "turnstile_secret", env.TURNSTILE_SECRET);
  const capApiEndpoint = value(settings, "cap_api_endpoint", env.CAP_API_ENDPOINT).replace(/\/+$/, "");
  const capSiteKey = value(settings, "cap_site_key", env.CAP_SITE_KEY);
  const capSecret = value(settings, "cap_secret", env.CAP_SECRET);
  const capWasmUrl = value(settings, "cap_wasm_url", env.CAP_WASM_URL);

  const inferred: CaptchaProvider =
    turnstileSiteKey || turnstileSecret
      ? "turnstile"
      : capApiEndpoint || capSiteKey || capSecret
        ? "cap"
        : "off";
  const provider =
    normalizeProvider(value(settings, "captcha_provider", env.CAPTCHA_PROVIDER)) || inferred;

  // Before the generic switch existed, a complete Turnstile pair implicitly
  // protected reviews. Keep that behavior for existing installations. The
  // student lookup switch intentionally defaults to off until enabled in the
  // panel, so deploying this change does not unexpectedly block students.
  const reviewsEnabled = explicit(settings, "captcha_reviews_enabled")
    ? enabled(settings.captcha_reviews_enabled ?? "")
    : clean(env.CAPTCHA_REVIEWS_ENABLED)
      ? enabled(clean(env.CAPTCHA_REVIEWS_ENABLED))
      : provider === "turnstile" && (!!turnstileSiteKey || !!turnstileSecret);
  const studentRecordEnabled = explicit(settings, "captcha_student_enabled")
    ? enabled(settings.captcha_student_enabled ?? "")
    : enabled(clean(env.CAPTCHA_STUDENT_ENABLED));

  const configured =
    provider === "turnstile"
      ? !!turnstileSiteKey && !!turnstileSecret
      : provider === "cap"
        ? !!capApiEndpoint && !!capSiteKey && !!capSecret
        : false;

  return {
    provider,
    reviewsEnabled,
    studentRecordEnabled,
    turnstileSiteKey,
    turnstileSecret,
    capApiEndpoint,
    capSiteKey,
    capSecret,
    capWasmUrl,
    configured,
  };
}

export function featureEnabled(config: CaptchaConfig, feature: CaptchaFeature): boolean {
  if (config.provider === "off") return false;
  return feature === "reviews" ? config.reviewsEnabled : config.studentRecordEnabled;
}

function tokenValue(token: unknown): string {
  return typeof token === "string" && token.length <= 4096 ? token.trim() : "";
}

function capSiteverifyUrl(endpoint: string, siteKey: string): string {
  const base = endpoint.replace(/\/+$/, "");
  if (base.includes("{siteKey}")) {
    return base.replaceAll("{siteKey}", encodeURIComponent(siteKey)) + "/siteverify";
  }
  return `${base}/${encodeURIComponent(siteKey)}/siteverify`;
}

async function verifyTurnstile(config: CaptchaConfig, token: string, ip: string | null): Promise<boolean> {
  if (!config.turnstileSecret || !token) return false;
  try {
    const form = new FormData();
    form.set("secret", config.turnstileSecret);
    form.set("response", token);
    if (ip) form.set("remoteip", ip);
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    if (!response.ok) return false;
    const data = (await response.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

async function verifyCap(config: CaptchaConfig, token: string): Promise<boolean> {
  if (!config.capApiEndpoint || !config.capSiteKey || !config.capSecret || !token) return false;
  try {
    const response = await fetch(capSiteverifyUrl(config.capApiEndpoint, config.capSiteKey), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ secret: config.capSecret, response: token }),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

/** Verify a token for one protected feature. Disabled features always pass. */
export async function verifyCaptcha(
  env: CaptchaEnv,
  feature: CaptchaFeature,
  token: unknown,
  ip: string | null = null,
): Promise<boolean> {
  const config = await loadCaptchaConfig(env);
  if (!featureEnabled(config, feature)) return true;
  if (!config.configured) return false;
  const tokenText = tokenValue(token);
  if (!tokenText) return false;
  if (config.provider === "turnstile") return verifyTurnstile(config, tokenText, ip);
  if (config.provider === "cap") return verifyCap(config, tokenText);
  return true;
}

/** Public, non-secret subset used by the browser widgets. */
export function publicCaptchaConfig(config: CaptchaConfig) {
  return {
    provider: config.provider,
    reviewsEnabled: config.reviewsEnabled,
    studentRecordEnabled: config.studentRecordEnabled,
    turnstileSiteKey: config.provider === "turnstile" ? config.turnstileSiteKey : "",
    capApiEndpoint: config.provider === "cap" ? config.capApiEndpoint : "",
    capSiteKey: config.provider === "cap" ? config.capSiteKey : "",
    capWasmUrl: config.provider === "cap" ? config.capWasmUrl : "",
    configured: config.configured,
  };
}
