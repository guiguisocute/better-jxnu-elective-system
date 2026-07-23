interface Env {
  DB: D1Database;
}

// POST /api/reviews/helpful — 「有用」投票 toggle。body: { reviewId, voterId }
// 已投 → 取消；未投 → 记一票。返回 { ok, helpful, voted }。

async function readBody<T>(request: Request): Promise<T | null> {
  try {
    return await request.json<T>();
  } catch {
    return null;
  }
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const body = await readBody<{ reviewId: number; voterId: string }>(context.request);
  if (!body) return Response.json({ error: "invalid json" }, { status: 400 });
  const { reviewId, voterId } = body;
  if (!Number.isInteger(reviewId) || reviewId <= 0) {
    return Response.json({ error: "reviewId invalid" }, { status: 400 });
  }
  if (typeof voterId !== "string" || voterId.length === 0 || voterId.length > 64) {
    return Response.json({ error: "voterId invalid" }, { status: 400 });
  }

  const db = context.env.DB;
  try {
    const exists = await db.prepare("SELECT 1 AS x FROM reviews WHERE id = ?").bind(reviewId).first();
    if (!exists) return Response.json({ error: "review not found" }, { status: 404 });

    const deleted = await db
      .prepare("DELETE FROM review_votes WHERE review_id = ? AND voter_id = ?")
      .bind(reviewId, voterId)
      .run();
    let voted = false;
    if (!deleted.meta.changes) {
      await db
        .prepare("INSERT OR IGNORE INTO review_votes (review_id, voter_id) VALUES (?, ?)")
        .bind(reviewId, voterId)
        .run();
      voted = true;
    }
    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM review_votes WHERE review_id = ?")
      .bind(reviewId)
      .first<{ n: number }>();
    return Response.json({ ok: true, helpful: count?.n ?? 0, voted });
  } catch {
    return Response.json({ error: "database error" }, { status: 500 });
  }
};
