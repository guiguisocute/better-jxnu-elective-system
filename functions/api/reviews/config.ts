import { loadCaptchaConfig, publicCaptchaConfig } from "../../lib/captcha";

interface Env {
  DB: D1Database;
  CAPTCHA_PROVIDER?: string;
  CAPTCHA_REVIEWS_ENABLED?: string;
  CAPTCHA_REPORTS_ENABLED?: string;
  CAPTCHA_STUDENT_ENABLED?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  CAP_API_ENDPOINT?: string;
  CAP_SITE_KEY?: string;
  CAP_SECRET?: string;
  CAP_WASM_URL?: string;
}

// Compatibility alias for older clients. New code reads /api/captcha/config,
// but keeping this route avoids breaking a cached RatingSheet bundle.

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const config = await loadCaptchaConfig(context.env);
  return Response.json(publicCaptchaConfig(config), { headers: { "Cache-Control": "max-age=60" } });
};
