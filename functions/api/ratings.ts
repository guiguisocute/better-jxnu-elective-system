interface Env {
  DB: D1Database;
}

// 兼容期端点（评价系统 V2 后前端已切换到 /api/reviews*，此处只服务未刷新的旧客户端）。
// 内部改读写 reviews.overall（总体评分维度），不再碰旧 ratings 表，避免双写不一致。
// GET /api/ratings?courseId=xxx / POST { courseId, teacherId, rating, voterId } / DELETE 同 body

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

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (request.method === "GET") {
    const url = new URL(request.url);
    const courseId = url.searchParams.get("courseId");
    if (!courseId) {
      return Response.json({ error: "courseId required" }, { status: 400 });
    }

    const { results } = await env.DB.prepare(
      "SELECT teacher_id, AVG(overall) as avg_rating, COUNT(overall) as count FROM reviews WHERE course_id = ? AND overall IS NOT NULL GROUP BY teacher_id"
    ).bind(courseId).all();

    return Response.json(results, {
      headers: { "Cache-Control": "no-cache" },
    });
  }

  if (request.method === "POST") {
    const body = await readBody<{
      courseId: string;
      teacherId: string;
      rating: number;
      voterId: string;
    }>(request);
    if (!body) {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }

    const { courseId, teacherId, rating, voterId } = body;

    if (!isValidId(courseId) || !isValidId(teacherId) || !isValidId(voterId)) {
      return Response.json({ error: "missing fields" }, { status: 400 });
    }
    if (typeof rating !== "number" || rating < 0.5 || rating > 5 || rating % 0.5 !== 0) {
      return Response.json({ error: "rating must be 0.5-5.0 in 0.5 steps" }, { status: 400 });
    }

    try {
      await env.DB.prepare(
        "INSERT INTO reviews (course_id, teacher_id, voter_id, overall) VALUES (?, ?, ?, ?) ON CONFLICT(course_id, teacher_id, voter_id) DO UPDATE SET overall = excluded.overall, updated_at = datetime('now')"
      ).bind(courseId, teacherId, voterId, rating).run();

      const avg = await env.DB.prepare(
        "SELECT AVG(overall) as avg_rating, COUNT(overall) as count FROM reviews WHERE teacher_id = ? AND course_id = ? AND overall IS NOT NULL"
      ).bind(teacherId, courseId).first<{ avg_rating: number; count: number }>();

      return Response.json({ ok: true, avgRating: avg?.avg_rating ?? rating, count: avg?.count ?? 1 });
    } catch {
      return Response.json({ error: "database error" }, { status: 500 });
    }
  }

  if (request.method === "DELETE") {
    const body = await readBody<{
      courseId: string;
      teacherId: string;
      voterId: string;
    }>(request);
    if (!body) {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }

    const { courseId, teacherId, voterId } = body;

    if (!isValidId(courseId) || !isValidId(teacherId) || !isValidId(voterId)) {
      return Response.json({ error: "missing fields" }, { status: 400 });
    }

    try {
      // 只撤销总体评分维度；整行仅当其余维度也全空时才删（保留用户的其他维度评价）。
      await env.DB.prepare(
        "UPDATE reviews SET overall = NULL, overall_c = NULL, updated_at = datetime('now') WHERE course_id = ? AND teacher_id = ? AND voter_id = ?"
      ).bind(courseId, teacherId, voterId).run();
      await env.DB.prepare(
        "DELETE FROM reviews WHERE course_id = ? AND teacher_id = ? AND voter_id = ? AND overall IS NULL AND assess IS NULL AND attendance IS NULL AND difficulty IS NULL AND teaching IS NULL"
      ).bind(courseId, teacherId, voterId).run();

      const avg = await env.DB.prepare(
        "SELECT AVG(overall) as avg_rating, COUNT(overall) as count FROM reviews WHERE teacher_id = ? AND course_id = ? AND overall IS NOT NULL"
      ).bind(teacherId, courseId).first<{ avg_rating: number | null; count: number }>();

      return Response.json({
        ok: true,
        avgRating: avg?.avg_rating ?? null,
        count: avg?.count ?? 0,
      });
    } catch {
      return Response.json({ error: "database error" }, { status: 500 });
    }
  }

  return Response.json({ error: "method not allowed" }, { status: 405 });
};
