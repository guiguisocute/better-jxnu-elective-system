import { verifyCaptcha } from "../lib/captcha";

interface Env {
  DB: D1Database;
  // 教务实时课表服务（VPS）。二者都配了才启用实时；否则直接查 D1。
  LIVE_URL?: string;
  LIVE_SECRET?: string;
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

// GET /api/student-record?sid=xxx
//   - 优先实时：带 secret 打 VPS（LIVE_URL），成功则返回 source:"live" 并后台回写 D1 保鲜。
//   - 回落：VPS 超时/报错/未配置 → 查 D1 快照，返回 source:"snapshot"。
//   - 脱敏：全程不涉及姓名（VPS 侧已剥，库里也不存）。
//   - 防遍历交给 Cloudflare WAF 限流（控制台规则），代码侧不实现。

const LIVE_TIMEOUT_MS = 10_000;

interface Row {
  student_id: string;
  class_name: string | null;
  plan_key: string | null;
  total_earned: number | null;
  taken_count: number | null;
  record_json: string;
}

// VPS 返回体：{ source, row:{className,planKey,totalEarned,takenCount}, record:{…StudentRecord} }
interface LivePayload {
  source: string;
  row: {
    className: string | null;
    planKey: string | null;
    totalEarned: number | null;
    takenCount: number | null;
  };
  record: Record<string, unknown> & { studentId?: string };
}

/** 把一条 record（StudentRecord 形状）+ 行级字段拼成前端契约响应（与 D1 分支同形状 + source）。 */
function shapeResponse(record: Record<string, unknown>, row: {
  className: string | null; planKey: string | null; totalEarned: number | null; taken_count?: number | null; takenCount?: number | null;
}, source: "live" | "snapshot") {
  return {
    studentId: record.studentId ?? null,
    className: record.className ?? row.className ?? null,
    planKey: row.planKey ?? null,
    totalEarned: row.totalEarned ?? 0,
    takenCount: (row.takenCount ?? row.taken_count) ?? 0,
    termLabel: record.termLabel ?? null,
    planningSemester: record.planningSemester ?? null,
    noSchedule: record.noSchedule ?? false,
    readingPlanTerm: record.readingPlanTerm ?? null,
    requiredCidsUpToReading: record.requiredCidsUpToReading ?? [],
    scheduleItems: record.scheduleItems ?? [],
    detailCourses: record.detailCourses ?? [],
    source,
  };
}

/** 实时结果回写 D1，让快照兜底自动保鲜（后台跑，不阻塞响应）。 */
async function upsertD1(env: Env, sid: string, payload: LivePayload): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO student_records
         (student_id, class_name, plan_key, total_earned, taken_count, record_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).bind(
      sid,
      payload.row.className ?? null,
      payload.row.planKey ?? null,
      payload.row.totalEarned ?? null,
      payload.row.takenCount ?? null,
      JSON.stringify(payload.record),
    ).run();
  } catch {
    // 回写失败不影响本次响应（下次再刷）。
  }
}

/** 打 VPS 实时服务；任何异常/超时/非 live 返回 null（触发 D1 回落）。 */
async function fetchLive(env: Env, sid: string): Promise<LivePayload | null> {
  if (!env.LIVE_URL || !env.LIVE_SECRET) return null;
  try {
    const url = `${env.LIVE_URL}?sid=${encodeURIComponent(sid)}`;
    const res = await fetch(url, {
      headers: { "X-Live-Secret": env.LIVE_SECRET },
      signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    if (!(res.headers.get("content-type") || "").includes("application/json")) return null;
    const data = (await res.json()) as LivePayload;
    if (data?.source !== "live" || !data.record) return null;
    return data;
  } catch {
    return null;
  }
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const sid = (url.searchParams.get("sid") || "").trim();

  if (!sid) {
    return Response.json({ error: "sid required" }, { status: 400 });
  }

  // The token is sent in a header so it never appears in browser history,
  // proxy access logs, or a Referer URL. Keep the query parameter as a small
  // compatibility fallback for older clients.
  const captchaToken =
    context.request.headers.get("X-Human-Verification-Token") ??
    context.request.headers.get("X-Captcha-Token") ??
    url.searchParams.get("captchaToken");
  if (!(await verifyCaptcha(context.env, "student-record", captchaToken, context.request.headers.get("CF-Connecting-IP")))) {
    return Response.json({ error: "human verification failed" }, { status: 403 });
  }

  // 1) 实时优先
  const live = await fetchLive(context.env, sid);
  if (live) {
    context.waitUntil(upsertD1(context.env, sid, live));
    return Response.json(
      shapeResponse(live.record, live.row, "live"),
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // 2) 回落 D1 快照
  const row = await context.env.DB.prepare(
    "SELECT student_id, class_name, plan_key, total_earned, taken_count, record_json FROM student_records WHERE student_id = ?"
  ).bind(sid).first<Row>();

  if (!row) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  let record: Record<string, unknown>;
  try {
    record = JSON.parse(row.record_json) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "corrupt record" }, { status: 500 });
  }

  return Response.json(
    shapeResponse(record, {
      className: row.class_name,
      planKey: row.plan_key,
      totalEarned: row.total_earned,
      taken_count: row.taken_count,
    }, "snapshot"),
    { headers: { "Cache-Control": "no-store" } },
  );
};
