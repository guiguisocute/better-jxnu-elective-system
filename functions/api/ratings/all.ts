interface Env {
  DB: D1Database;
}

// GET /api/ratings/all — get all ratings grouped by course_id and teacher_id
// Returns: { [courseId]: { [teacherId]: { avg: number, count: number } } }

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { results } = await context.env.DB.prepare(
    "SELECT course_id, teacher_id, AVG(rating) as avg_rating, COUNT(*) as count FROM ratings GROUP BY course_id, teacher_id"
  ).all();

  const grouped: Record<string, Record<string, { avg: number; count: number }>> = {};
  for (const row of results as { course_id: string; teacher_id: string; avg_rating: number; count: number }[]) {
    if (!grouped[row.course_id]) grouped[row.course_id] = {};
    grouped[row.course_id][row.teacher_id] = { avg: row.avg_rating, count: row.count };
  }

  return Response.json(grouped, {
    headers: { "Cache-Control": "public, max-age=30" },
  });
};
