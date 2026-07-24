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

// GET /api/captcha/config — only public widget settings. Secrets never leave
// the Pages Function; the Go panel writes them to D1.
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const config = await loadCaptchaConfig(context.env);
  return Response.json(publicCaptchaConfig(config), {
    headers: {
      // The panel changes D1 directly. Keep the browser cache short enough for
      // a switch to take effect without a deployment.
      "Cache-Control": "max-age=60",
    },
  });
};
