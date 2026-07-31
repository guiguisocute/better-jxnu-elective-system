import { verifyCaptcha } from "../lib/captcha";

interface Env {
  DB: D1Database;
  // 学号快照的专用库（jxnu-students）。它和评价库分开，是因为这张表有 289MB /
  // 28818 行，而评价数据只有 0.4MB：D1 按页从远端惰性拉取，两者同库时评价查询要为
  // 这堆数据的体量买单（同一条语句 D1 自报 sql_duration_ms=0.8，HTTP 却要 26s）。
  // 可选 + 回落到 DB，这样绑定还没生效的那次构建也不会 500。
  DB_STUDENTS?: D1Database;
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

// POST /api/student-record { "sid": "xxx" }
//   - 优先实时：带 secret 打 VPS（LIVE_URL），成功则返回 source:"live" 并后台回写 D1 保鲜。
//   - 回落：VPS 超时/报错/未配置 → 查 D1 快照，返回 source:"snapshot"。
//   - 脱敏：全程不涉及姓名（VPS 侧已剥，库里也不存）。
//   - 学号只放请求体，不进入浏览器历史、Referer 或代理默认 access log。
//   - 防遍历交给 Cloudflare WAF 限流（控制台规则），代码侧不实现。

// 一次真实教务查询通常需要 10~15 秒（登录、ASP.NET 表单和课表抓取）。
// 10 秒会在后端即将成功时提前中止，导致所有请求看起来都像 D1 离线回落。
// VPS 端自身还有 75 秒硬上限；这里给 30 秒，在实时可用性和故障回退之间取中间值。
const LIVE_TIMEOUT_MS = 30_000;
const MAX_REQUEST_CHARS = 4_096;

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

/** 学号快照所在的库：优先专用库，未绑定时回落到评价库（迁移期兼容）。 */
function studentDB(env: Env): D1Database {
  return env.DB_STUDENTS ?? env.DB;
}

/** 实时结果回写 D1，让快照兜底自动保鲜（后台跑，不阻塞响应）。 */
async function upsertD1(env: Env, sid: string, payload: LivePayload): Promise<void> {
  try {
    await studentDB(env).prepare(
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
    const res = await fetch(env.LIVE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Secret": env.LIVE_SECRET,
      },
      body: JSON.stringify({ sid }),
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

export const onRequestPost: PagesFunction<Env> = async (context) => {
  if (new URL(context.request.url).search) {
    return Response.json({ error: "query parameters are not allowed" }, { status: 400 });
  }
  const rawBody = await context.request.text();
  if (rawBody.length > MAX_REQUEST_CHARS) {
    return Response.json({ error: "request too large" }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const bodyIsValid =
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    Object.keys(body).length === 1 &&
    Object.hasOwn(body, "sid");
  const sid = (
    bodyIsValid && typeof (body as { sid?: unknown }).sid === "string"
      ? (body as { sid: string }).sid
      : ""
  ).trim();
  if (!/^\d{6,20}$/.test(sid)) {
    return Response.json({ error: "invalid sid" }, { status: 400 });
  }

  // Verification tokens stay in a header for the same reason as the SID body.
  const captchaToken =
    context.request.headers.get("X-Human-Verification-Token") ??
    context.request.headers.get("X-Captcha-Token");
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
  const row = await studentDB(context.env).prepare(
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

export const onRequestGet: PagesFunction<Env> = async () => Response.json(
  { error: "method not allowed" },
  { status: 405, headers: { Allow: "POST" } },
);
