import { verifyCaptcha } from "../../lib/captcha";
import { abuseActor } from "../../lib/abuseIdentity";

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
  ABUSE_ID_SECRET?: string;
}

// POST /api/reviews/report — 举报一条评价。body: { reviewId, reason? (≤200字), captchaToken? }
// 一人对一条评价只记一次（重复举报幂等返回 ok）。处理在 Go 后台面板。

async function readBody<T>(request: Request): Promise<T | null> {
  try {
    return await request.json<T>();
  } catch {
    return null;
  }
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const body = await readBody<{
    reviewId: number;
    reason?: string;
    captchaToken?: string | null;
    turnstileToken?: string | null;
  }>(context.request);
  if (!body) return Response.json({ error: "invalid json" }, { status: 400 });
  const { reviewId } = body;
  if (!Number.isInteger(reviewId) || reviewId <= 0) {
    return Response.json({ error: "reviewId invalid" }, { status: 400 });
  }
  let reason: string | null = null;
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== "string" || body.reason.length > 200) {
      return Response.json({ error: "reason must be a string <= 200 chars" }, { status: 400 });
    }
    reason = body.reason.trim() || null;
  }

  const voterId = await abuseActor(context.request, context.env, "reports");
  if (!voterId) {
    return Response.json({ error: "abuse identity unavailable" }, { status: 503 });
  }

  const captchaToken = body.captchaToken ?? body.turnstileToken;
  if (!(await verifyCaptcha(
    context.env,
    "reports",
    captchaToken,
    context.request.headers.get("CF-Connecting-IP"),
  ))) {
    return Response.json({ error: "human verification failed" }, { status: 403 });
  }

  const db = context.env.DB;
  try {
    const exists = await db.prepare("SELECT 1 AS x FROM reviews WHERE id = ?").bind(reviewId).first();
    if (!exists) return Response.json({ error: "review not found" }, { status: 404 });
    await db
      .prepare("INSERT OR IGNORE INTO review_reports (review_id, voter_id, reason) VALUES (?, ?, ?)")
      .bind(reviewId, voterId, reason)
      .run();
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "database error" }, { status: 500 });
  }
};
