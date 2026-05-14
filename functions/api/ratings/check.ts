interface Env {
  DB: D1Database;
}

// GET /api/ratings/check?courseId=xxx&teacherId=xxx&voterId=xxx
// Returns { rated: boolean, rating: number | null }

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const courseId = url.searchParams.get("courseId");
  const teacherId = url.searchParams.get("teacherId");
  const voterId = url.searchParams.get("voterId");

  if (!courseId || !teacherId || !voterId) {
    return Response.json({ error: "courseId, teacherId and voterId required" }, { status: 400 });
  }

  const row = await context.env.DB.prepare(
    "SELECT rating FROM ratings WHERE course_id = ? AND teacher_id = ? AND voter_id = ?"
  ).bind(courseId, teacherId, voterId).first<{ rating: number }>();

  return Response.json({
    rated: !!row,
    rating: row?.rating ?? null,
  });
};
