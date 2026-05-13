interface Env {
  DB: D1Database;
}

// GET /api/ratings/check?teacherId=xxx&voterId=xxx
// Returns { rated: boolean, rating: number | null }

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const teacherId = url.searchParams.get("teacherId");
  const voterId = url.searchParams.get("voterId");

  if (!teacherId || !voterId) {
    return Response.json({ error: "teacherId and voterId required" }, { status: 400 });
  }

  const row = await context.env.DB.prepare(
    "SELECT rating FROM ratings WHERE teacher_id = ? AND voter_id = ?"
  ).bind(teacherId, voterId).first<{ rating: number }>();

  return Response.json({
    rated: !!row,
    rating: row?.rating ?? null,
  });
};
