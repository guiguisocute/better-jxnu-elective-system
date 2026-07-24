interface Env {
  DB: D1Database;
}

// 兼容期端点：GET /api/ratings/all — 旧客户端的 overall 聚合（读 reviews.overall）。
// Returns: { [courseId]: { [teacherId]: { avg: number, count: number } } }

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { results } = await context.env.DB.prepare(
    "SELECT course_id, teacher_id, AVG(overall) as avg_rating, COUNT(overall) as count FROM reviews WHERE overall IS NOT NULL AND status = 'approved' GROUP BY course_id, teacher_id"
  ).all();

  const grouped: Record<string, Record<string, { avg: number; count: number }>> = {};
  for (const row of results as { course_id: string; teacher_id: string; avg_rating: number; count: number }[]) {
    if (!grouped[row.course_id]) grouped[row.course_id] = {};
    grouped[row.course_id][row.teacher_id] = { avg: row.avg_rating, count: row.count };
  }

  return Response.json(grouped, {
    headers: { "Cache-Control": "no-cache" },
  });
};
