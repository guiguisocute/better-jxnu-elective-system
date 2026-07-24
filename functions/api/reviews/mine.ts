interface Env {
  DB: D1Database;
}

// GET /api/reviews/mine?courseId=xxx&teacherId=xxx&voterId=xxx
// 回填当前用户对该 (课程, 教师) 已提交的完整评价；没有则 { exists: false }。

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const courseId = url.searchParams.get("courseId");
  const teacherId = url.searchParams.get("teacherId");
  const voterId = url.searchParams.get("voterId");
  if (!courseId || !teacherId || !voterId) {
    return Response.json({ error: "courseId, teacherId and voterId required" }, { status: 400 });
  }

  const row = await context.env.DB.prepare(
    `SELECT id, avatar, nickname, overall, assess, attendance, difficulty, teaching,
            overall_c, assess_c, attendance_c, difficulty_c, teaching_c, status, created_at, updated_at
     FROM reviews WHERE course_id = ? AND teacher_id = ? AND voter_id = ?`
  )
    .bind(courseId, teacherId, voterId)
    .first<Record<string, string | number | null>>();

  if (!row) {
    return Response.json({ exists: false }, { headers: { "Cache-Control": "no-cache" } });
  }
  return Response.json(
    {
      exists: true,
      review: {
        id: row.id,
        courseId,
        teacherId,
        avatar: row.avatar,
        nickname: row.nickname,
        overall: row.overall,
        assess: row.assess,
        attendance: row.attendance,
        difficulty: row.difficulty,
        teaching: row.teaching,
        overallC: row.overall_c,
        assessC: row.assess_c,
        attendanceC: row.attendance_c,
        difficultyC: row.difficulty_c,
        teachingC: row.teaching_c,
        status: row.status ?? "approved",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        helpful: 0,
        myVote: false,
        mine: true,
      },
    },
    { headers: { "Cache-Control": "no-cache" } }
  );
};
