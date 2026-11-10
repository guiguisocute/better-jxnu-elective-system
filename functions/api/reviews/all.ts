interface Env {
  DB: D1Database;
}

// GET /api/reviews/all — 全站 5 维度聚合（评价子页面 bulk-load + 列表排序/AI 的 overall 来源）。
// 返回 { [courseId]: { [teacherId]: { overall?: {avg,count}, assess?: ..., ... } } }
// 契约镜像 src/lib/reviewDimensions.ts 的 AllReviews。

const DIMS = ["overall", "assess", "attendance", "difficulty", "teaching"] as const;

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const started = performance.now();
  const cacheUrl = new URL(context.request.url);
  cacheUrl.search = "";
  const cacheKey = new Request(cacheUrl, { method: "GET" });
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const response = new Response(cached.body, { status: cached.status, headers: cached.headers });
    response.headers.set("X-Reviews-Cache", "HIT");
    response.headers.set("Server-Timing", `edge;dur=${(performance.now() - started).toFixed(1)}`);
    return response;
  }

  const queryStarted = performance.now();
  const select = DIMS.map((d) => `AVG(${d}) AS ${d}_avg, COUNT(${d}) AS ${d}_count`).join(", ");
  const { results } = await context.env.DB.prepare(
    `SELECT course_id, teacher_id, ${select} FROM reviews WHERE status = 'approved' GROUP BY course_id, teacher_id`
  ).all<Record<string, string | number | null>>();
  const queryMs = performance.now() - queryStarted;

  const grouped: Record<string, Record<string, Record<string, { avg: number; count: number }>>> = {};
  for (const row of results ?? []) {
    const cid = String(row.course_id);
    const tid = String(row.teacher_id);
    const dims: Record<string, { avg: number; count: number }> = {};
    for (const d of DIMS) {
      const count = Number(row[`${d}_count`] ?? 0);
      const avg = row[`${d}_avg`];
      if (count > 0 && typeof avg === "number") dims[d] = { avg, count };
    }
    if (Object.keys(dims).length === 0) continue;
    (grouped[cid] ??= {})[tid] = dims;
  }

  const response = Response.json(grouped, {
    headers: {
      "Cache-Control": "public, max-age=30, s-maxage=60, stale-while-revalidate=30",
      "Server-Timing": `d1;dur=${queryMs.toFixed(1)}, total;dur=${(performance.now() - started).toFixed(1)}`,
      "X-Reviews-Cache": "MISS",
    },
  });
  context.waitUntil(caches.default.put(cacheKey, response.clone()));
  return response;
};
