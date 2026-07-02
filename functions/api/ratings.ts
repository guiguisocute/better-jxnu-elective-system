interface Env {
  DB: D1Database;
}

// GET /api/ratings?courseId=xxx — get average ratings for all teachers of a course
// POST /api/ratings — submit a rating { courseId, teacherId, rating, voterId }
// DELETE /api/ratings — delete a rating { courseId, teacherId, voterId }

// 畸形 JSON body → null（调用方回 400），不再抛到运行时变 500。
async function readBody<T>(request: Request): Promise<T | null> {
  try {
    return await request.json<T>();
  } catch {
    return null;
  }
}

// id 类字段：非空字符串 + 长度上限（防超长垃圾写库；正常 courseId/teacherId 不超过 16，voterId 是 UUID=36）。
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
      "SELECT teacher_id, AVG(rating) as avg_rating, COUNT(*) as count FROM ratings WHERE course_id = ? GROUP BY teacher_id"
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
        "INSERT INTO ratings (course_id, teacher_id, rating, voter_id) VALUES (?, ?, ?, ?) ON CONFLICT(course_id, teacher_id, voter_id) DO UPDATE SET rating = excluded.rating"
      ).bind(courseId, teacherId, rating, voterId).run();

      // Return updated average for this teacher
      const avg = await env.DB.prepare(
        "SELECT AVG(rating) as avg_rating, COUNT(*) as count FROM ratings WHERE teacher_id = ? AND course_id = ?"
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
      await env.DB.prepare(
        "DELETE FROM ratings WHERE course_id = ? AND teacher_id = ? AND voter_id = ?"
      ).bind(courseId, teacherId, voterId).run();

      // Return updated average for this teacher (may be null if no ratings left)
      const avg = await env.DB.prepare(
        "SELECT AVG(rating) as avg_rating, COUNT(*) as count FROM ratings WHERE teacher_id = ? AND course_id = ?"
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
