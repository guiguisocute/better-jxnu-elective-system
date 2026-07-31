interface Env {
  DB: D1Database;
}

// 兼容期只读端点（评价系统 V2 后前端已切换到 /api/reviews*）。
// 旧写协议没有验证码和审核字段，继续接受会绕过 V2 的安全控制，因此明确下线。

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (request.method === "GET") {
    const url = new URL(request.url);
    const courseId = url.searchParams.get("courseId");
    if (!courseId) {
      return Response.json({ error: "courseId required" }, { status: 400 });
    }

    const { results } = await env.DB.prepare(
      "SELECT teacher_id, AVG(overall) as avg_rating, COUNT(overall) as count FROM reviews WHERE course_id = ? AND overall IS NOT NULL AND status = 'approved' GROUP BY teacher_id"
    ).bind(courseId).all();

    return Response.json(results, {
      headers: { "Cache-Control": "no-cache" },
    });
  }

  if (request.method === "POST" || request.method === "DELETE") {
    return Response.json(
      { error: "legacy ratings mutations are disabled; use /api/reviews" },
      { status: 410, headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json({ error: "method not allowed" }, { status: 405 });
};
