/** Browser-facing human-verification configuration and small URL helpers. */

export type HumanVerificationProvider = "off" | "turnstile" | "cap";
export type HumanVerificationFeature = "reviews" | "reports" | "student-record";

export interface HumanVerificationConfig {
  provider: HumanVerificationProvider;
  reviewsEnabled: boolean;
  reportsEnabled: boolean;
  studentRecordEnabled: boolean;
  turnstileSiteKey: string;
  capApiEndpoint: string;
  capSiteKey: string;
  capWasmUrl: string;
  configured: boolean;
}

const DEFAULT_CONFIG: HumanVerificationConfig = {
  provider: "off",
  reviewsEnabled: false,
  reportsEnabled: false,
  studentRecordEnabled: false,
  turnstileSiteKey: "",
  capApiEndpoint: "",
  capSiteKey: "",
  capWasmUrl: "",
  configured: false,
};

let cache: HumanVerificationConfig | null = null;
let pending: Promise<HumanVerificationConfig> | null = null;

function isProvider(value: unknown): value is HumanVerificationProvider {
  return value === "off" || value === "turnstile" || value === "cap";
}

function normalize(raw: unknown): HumanVerificationConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_CONFIG;
  const data = raw as Record<string, unknown>;
  const stringValue = (key: string) => (typeof data[key] === "string" ? data[key].trim() : "");
  const legacyTurnstileSiteKey = stringValue("turnstileSiteKey");
  const provider = isProvider(data.provider) ? data.provider : legacyTurnstileSiteKey ? "turnstile" : "off";
  const reviewsEnabled =
    data.reviewsEnabled === true ||
    (!Object.prototype.hasOwnProperty.call(data, "reviewsEnabled") && !!legacyTurnstileSiteKey);
  return {
    provider,
    reviewsEnabled,
    reportsEnabled:
      data.reportsEnabled === true ||
      (!Object.prototype.hasOwnProperty.call(data, "reportsEnabled") && reviewsEnabled),
    studentRecordEnabled: data.studentRecordEnabled === true,
    turnstileSiteKey: legacyTurnstileSiteKey,
    capApiEndpoint: stringValue("capApiEndpoint").replace(/\/+$/, ""),
    capSiteKey: stringValue("capSiteKey"),
    capWasmUrl: stringValue("capWasmUrl"),
    configured: data.configured === true || (!Object.prototype.hasOwnProperty.call(data, "configured") && !!legacyTurnstileSiteKey),
  };
}

async function readJson(response: Response): Promise<unknown | null> {
  if (!response.ok || !(response.headers.get("content-type") || "").includes("application/json")) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchJsonOrNull(url: string): Promise<unknown | null> {
  try {
    return await readJson(await fetch(url, { cache: "no-cache" }));
  } catch {
    return null;
  }
}

/** Load once per page; D1 changes are picked up on the next page/modal mount. */
export function fetchHumanVerificationConfig(force = false): Promise<HumanVerificationConfig> {
  if (!force && cache) return Promise.resolve(cache);
  if (!force && pending) return pending;
  pending = (async () => {
    let raw = await fetchJsonOrNull("/api/captcha/config");
    // Compatibility route for a deployment where the new function has not
    // propagated yet (or a cached old Pages build).
    if (!raw) raw = await fetchJsonOrNull("/api/reviews/config");
    const config = normalize(raw);
    cache = config;
    pending = null;
    return config;
  })();
  return pending;
}

export function clearHumanVerificationConfig(): void {
  cache = null;
  pending = null;
}

export function featureNeedsVerification(
  config: HumanVerificationConfig,
  feature: HumanVerificationFeature,
): boolean {
  if (config.provider === "off") return false;
  if (feature === "reviews") return config.reviewsEnabled;
  if (feature === "reports") return config.reportsEnabled;
  return config.studentRecordEnabled;
}

/** Full widget endpoint expected by @cap.js/widget. */
export function capWidgetEndpoint(config: HumanVerificationConfig): string {
  if (!config.capApiEndpoint || !config.capSiteKey) return "";
  return `${config.capApiEndpoint.replace(/\/+$/, "")}/${encodeURIComponent(config.capSiteKey)}/`;
}

/** Use the self-hosted asset server by convention when no explicit URL exists. */
export function capWasmEndpoint(config: HumanVerificationConfig): string {
  if (config.capWasmUrl) return config.capWasmUrl;
  if (!config.capApiEndpoint) return "";
  return `${config.capApiEndpoint.replace(/\/+$/, "")}/assets/cap_wasm_bg.wasm`;
}

// Backward-compatible name used by older rating code and external snippets.
export type ReviewHumanVerificationConfig = HumanVerificationConfig;
