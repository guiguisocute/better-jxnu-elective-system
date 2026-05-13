interface Env {
  DB: D1Database;
}

// GET /api/ratings?courseId=xxx — get average ratings for all teachers of a course
// POST /api/ratings — submit a rating { courseId, teacherId, rating, voterId }

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
      headers: { "Cache-Control": "public, max-age=60" },
    });
  }

  if (request.method === "POST") {
    const body = await request.json<{
      courseId: string;
      teacherId: string;
      rating: number;
      voterId: string;
    }>();

    const { courseId, teacherId, rating, voterId } = body;

    if (!courseId || !teacherId || !rating || !voterId) {
      return Response.json({ error: "missing fields" }, { status: 400 });
    }
    if (rating < 0.5 || rating > 5 || rating % 0.5 !== 0) {
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

  return Response.json({ error: "method not allowed" }, { status: 405 });
};
