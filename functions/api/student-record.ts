interface Env {
  DB: D1Database;
}

// GET /api/student-record?sid=xxx
//   - 脱敏：仅凭学号查询，全程不涉及姓名（库里也不存姓名）。
//   - 防遍历交给 Cloudflare WAF 限流（控制台规则），代码侧不实现。

interface Row {
  student_id: string;
  class_name: string | null;
  plan_key: string | null;
  total_earned: number | null;
  taken_count: number | null;
  record_json: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const sid = (url.searchParams.get("sid") || "").trim();

  if (!sid) {
    return Response.json({ error: "sid required" }, { status: 400 });
  }

  const row = await context.env.DB.prepare(
    "SELECT student_id, class_name, plan_key, total_earned, taken_count, record_json FROM student_records WHERE student_id = ?"
  ).bind(sid).first<Row>();

  if (!row) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  let record: Record<string, unknown> = {};
  try {
    record = JSON.parse(row.record_json) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "corrupt record" }, { status: 500 });
  }

  return Response.json(
    {
      studentId: row.student_id,
      className: row.class_name,
      planKey: row.plan_key,
      totalEarned: row.total_earned ?? 0,
      takenCount: row.taken_count ?? 0,
      termLabel: record.termLabel ?? null,
      noSchedule: record.noSchedule ?? false,
      readingPlanTerm: record.readingPlanTerm ?? null,
      requiredCidsUpToReading: record.requiredCidsUpToReading ?? [],
      scheduleItems: record.scheduleItems ?? [],
      detailCourses: record.detailCourses ?? [],
    },
    { headers: { "Cache-Control": "no-store" } },
  );
};
