interface Env {
  DB: D1Database;
}

// 评价系统 V2 主端点。契约镜像 src/lib/reviewDimensions.ts（functions/ 不在 tsc -b 范围，改形状两侧同步）。
// GET  /api/reviews?courseId=xxx — 该课程每位教师的 5 维度聚合
// POST /api/reviews — 匿名提交/覆盖一条评价（宽表 upsert；≥1 维非空，各维度可选评语）
// 不提供公开 DELETE：删改监管一律走 Go 后台面板（用户重新提交即覆盖自己的评价）。

const DIMS = ["overall", "assess", "attendance", "difficulty", "teaching"] as const;
type Dim = (typeof DIMS)[number];

async function readBody<T>(request: Request): Promise<T | null> {
  try {
    return await request.json<T>();
  } catch {
    return null;
  }
}

function isValidId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 64;
}

function isValidScore(v: unknown): v is number {
  return typeof v === "number" && v >= 0.5 && v <= 5 && v % 0.5 === 0;
}

/** 可空短文本（评语/昵称/头像种子）；超长或非字符串 → undefined 表示非法 */
function normText(v: unknown, maxLen: number): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (t.length === 0) return null;
  if (t.length > maxLen) return undefined;
  return t;
}

function aggSelect(): string {
  const parts = DIMS.map(
    (d) => `AVG(${d}) AS ${d}_avg, COUNT(${d}) AS ${d}_count`
  );
  return parts.join(", ");
}

type AggRow = { teacher_id: string } & Record<string, number | string | null>;

/** 审核模式开关（app_settings.review_moderation = 'on'）；表不存在/无记录 = 关闭 */
async function moderationEnabled(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT value FROM app_settings WHERE key = 'review_moderation'")
      .first<{ value: string }>();
    return row?.value === "on";
  } catch {
    return false;
  }
}

function rowToDims(row: AggRow): Record<string, { avg: number; count: number }> {
  const dims: Record<string, { avg: number; count: number }> = {};
  for (const d of DIMS) {
    const count = Number(row[`${d}_count`] ?? 0);
    const avg = row[`${d}_avg`];
    if (count > 0 && typeof avg === "number") {
      dims[d] = { avg, count };
    }
  }
  return dims;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (request.method === "GET") {
    const url = new URL(request.url);
    const courseId = url.searchParams.get("courseId");
    if (!courseId) {
      return Response.json({ error: "courseId required" }, { status: 400 });
    }
    const { results } = await env.DB.prepare(
      `SELECT teacher_id, ${aggSelect()} FROM reviews WHERE course_id = ? AND status = 'approved' GROUP BY teacher_id`
    )
      .bind(courseId)
      .all<AggRow>();
    const out = (results ?? []).map((row) => ({
      teacher_id: row.teacher_id,
      dims: rowToDims(row),
    }));
    return Response.json(out, { headers: { "Cache-Control": "no-cache" } });
  }

  if (request.method === "POST") {
    const body = await readBody<Record<string, unknown>>(request);
    if (!body) {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }
    const courseId = body.courseId;
    const teacherId = body.teacherId;
    const voterId = body.voterId;
    if (!isValidId(courseId) || !isValidId(teacherId) || !isValidId(voterId)) {
      return Response.json({ error: "missing fields" }, { status: 400 });
    }

    const scores: Partial<Record<Dim, number | null>> = {};
    let hasScore = false;
    for (const d of DIMS) {
      const v = body[d];
      if (v === undefined || v === null) {
        scores[d] = null;
        continue;
      }
      if (!isValidScore(v)) {
        return Response.json({ error: `${d} must be 0.5-5.0 in 0.5 steps` }, { status: 400 });
      }
      scores[d] = v;
      hasScore = true;
    }
    if (!hasScore) {
      return Response.json({ error: "at least one dimension required" }, { status: 400 });
    }

    const comments: Partial<Record<Dim, string | null>> = {};
    for (const d of DIMS) {
      const t = normText(body[`${d}C`], 500);
      if (t === undefined) {
        return Response.json({ error: `${d}C must be a string <= 500 chars` }, { status: 400 });
      }
      // 评语只随打了分的维度存（没分的评语无处展示，直接丢弃）
      comments[d] = scores[d] === null ? null : t;
    }

    const avatar = normText(body.avatar, 64);
    const nickname = normText(body.nickname, 20);
    if (avatar === undefined || nickname === undefined) {
      return Response.json({ error: "avatar/nickname invalid" }, { status: 400 });
    }

    try {
      // 审核模式开启时新提交（含覆盖修改）先落 pending，审核通过后才公开
      const pending = await moderationEnabled(env.DB);
      const status = pending ? "pending" : "approved";
      await env.DB.prepare(
        `INSERT INTO reviews (course_id, teacher_id, voter_id, avatar, nickname,
           overall, assess, attendance, difficulty, teaching,
           overall_c, assess_c, attendance_c, difficulty_c, teaching_c, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(course_id, teacher_id, voter_id) DO UPDATE SET
           avatar = excluded.avatar, nickname = excluded.nickname,
           overall = excluded.overall, assess = excluded.assess, attendance = excluded.attendance,
           difficulty = excluded.difficulty, teaching = excluded.teaching,
           overall_c = excluded.overall_c, assess_c = excluded.assess_c, attendance_c = excluded.attendance_c,
           difficulty_c = excluded.difficulty_c, teaching_c = excluded.teaching_c,
           status = excluded.status,
           updated_at = datetime('now')`
      )
        .bind(
          courseId, teacherId, voterId, avatar, nickname,
          scores.overall, scores.assess, scores.attendance, scores.difficulty, scores.teaching,
          comments.overall, comments.assess, comments.attendance, comments.difficulty, comments.teaching,
          status
        )
        .run();

      const row = await env.DB.prepare(
        `SELECT teacher_id, ${aggSelect()} FROM reviews WHERE course_id = ? AND teacher_id = ? AND status = 'approved' GROUP BY teacher_id`
      )
        .bind(courseId, teacherId)
        .first<AggRow>();
      return Response.json({ ok: true, pending, dims: row ? rowToDims(row) : {} });
    } catch {
      return Response.json({ error: "database error" }, { status: 500 });
    }
  }

  return Response.json({ error: "method not allowed" }, { status: 405 });
};
