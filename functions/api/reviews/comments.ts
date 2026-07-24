interface Env {
  DB: D1Database;
}

// GET /api/reviews/comments?[courseId=xxx][&teacherId=xxx][&voterId=xxx][&limit=20][&offset=0]
// 评语流（评价卡列表）。voterId 可选：传了会标记 mine / myVote（是否投过「有用」）。
// courseId / teacherId 都不传 = 广场模式：全站按时间倒序（分页拉取）。
// 只返回审核通过的行。排序固定 updated_at DESC，
// 「最有帮助 / 好评优先」由前端在已拉数据集上重排。
// 行契约镜像 src/lib/reviewDimensions.ts 的 ReviewRow。

interface RawRow {
  id: number;
  course_id: string;
  teacher_id: string;
  avatar: string | null;
  nickname: string | null;
  overall: number | null;
  assess: number | null;
  attendance: number | null;
  difficulty: number | null;
  teaching: number | null;
  overall_c: string | null;
  assess_c: string | null;
  attendance_c: string | null;
  difficulty_c: string | null;
  teaching_c: string | null;
  created_at: string;
  updated_at: string;
  voter_id: string;
  helpful: number;
  my_vote: number;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const courseId = url.searchParams.get("courseId");
  const teacherId = url.searchParams.get("teacherId");
  const voterId = url.searchParams.get("voterId") ?? "";
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);

  const where: string[] = ["r.status = 'approved'"];
  const binds: (string | number)[] = [voterId];
  if (courseId) {
    where.push("r.course_id = ?");
    binds.push(courseId);
  }
  if (teacherId) {
    where.push("r.teacher_id = ?");
    binds.push(teacherId);
  }
  binds.push(limit, offset);

  const { results } = await context.env.DB.prepare(
    `SELECT r.*,
       (SELECT COUNT(*) FROM review_votes v WHERE v.review_id = r.id) AS helpful,
       (SELECT COUNT(*) FROM review_votes v WHERE v.review_id = r.id AND v.voter_id = ?1) AS my_vote
     FROM reviews r
     WHERE ${where.join(" AND ")}
     ORDER BY r.updated_at DESC, r.id DESC
     LIMIT ? OFFSET ?`
  )
    .bind(...binds)
    .all<RawRow>();

  const rows = (results ?? []).map((r) => ({
    id: r.id,
    courseId: r.course_id,
    teacherId: r.teacher_id,
    avatar: r.avatar,
    nickname: r.nickname,
    overall: r.overall,
    assess: r.assess,
    attendance: r.attendance,
    difficulty: r.difficulty,
    teaching: r.teaching,
    overallC: r.overall_c,
    assessC: r.assess_c,
    attendanceC: r.attendance_c,
    difficultyC: r.difficulty_c,
    teachingC: r.teaching_c,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    helpful: r.helpful,
    myVote: r.my_vote > 0,
    mine: voterId !== "" && r.voter_id === voterId,
  }));

  return Response.json(rows, { headers: { "Cache-Control": "no-cache" } });
};
