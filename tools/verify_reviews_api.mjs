#!/usr/bin/env node
// 评价系统 V2 API 验证程序。
// 用法：node tools/verify_reviews_api.mjs [baseURL]
//   本地：npx wrangler pages dev 起服务后  node tools/verify_reviews_api.mjs http://127.0.0.1:8788
//   线上：node tools/verify_reviews_api.mjs https://xk.betterjxnu.cn  （只跑只读用例 + 独立测试 voter 的写删）
// 断言失败即非零退出。写入用例全部使用 verify- 前缀的测试 voter/course，可在后台面板清理。

const base = process.argv[2] ?? "http://127.0.0.1:8788";
const V = `verify-voter-${Math.random().toString(16).slice(2, 10)}`;
const C = "VERIFY01";
const T = "9999";

let passed = 0;
let failed = 0;

function assert(cond, name, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name} ${extra}`);
  }
}

async function req(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

console.log(`验证目标: ${base}  测试voter: ${V}`);

// ===== 1. POST /api/reviews 校验 =====
{
  const r = await req("POST", "/api/reviews", {});
  assert(r.status === 400, "POST 空 body → 400", `got ${r.status}`);
}
{
  const r = await req("POST", "/api/reviews", { courseId: C, teacherId: T, voterId: V });
  assert(r.status === 400, "POST 全维度空 → 400", `got ${r.status}`);
}
{
  const r = await req("POST", "/api/reviews", { courseId: C, teacherId: T, voterId: V, overall: 4.3 });
  assert(r.status === 400, "POST 非法步进 4.3 → 400", `got ${r.status}`);
}
{
  const r = await req("POST", "/api/reviews", { courseId: C, teacherId: T, voterId: V, attendance: 6 });
  assert(r.status === 400, "POST 超范围 6 → 400", `got ${r.status}`);
}
{
  const r = await req("POST", "/api/reviews", {
    courseId: C, teacherId: T, voterId: V,
    avatar: "seedabc", nickname: "验证机器人",
    overall: 4.5, attendance: 5, attendanceC: "一次未点，很自由",
  });
  assert(r.status === 200 && r.json?.ok, "POST 部分维度合法提交 → ok", JSON.stringify(r.json));
  assert(r.json?.dims?.overall?.count >= 1, "POST 响应带 overall 聚合");
  assert(r.json?.dims?.attendance?.avg === 5, "POST 响应 attendance avg=5");
  assert(!r.json?.dims?.assess, "未评维度不出现在聚合里");
}

// ===== 2. GET 聚合 =====
{
  const r = await req("GET", `/api/reviews?courseId=${C}`);
  const row = Array.isArray(r.json) ? r.json.find((x) => x.teacher_id === T) : null;
  assert(!!row, "GET ?courseId 聚合含测试教师");
  assert(row?.dims?.overall?.count >= 1, "聚合 overall count ≥ 1");
}
{
  const r = await req("GET", "/api/reviews/all");
  assert(r.status === 200 && r.json?.[C]?.[T]?.overall, "GET /all 嵌套形状正确");
}

// ===== 3. mine 回填 + upsert 覆盖 =====
{
  const r = await req("GET", `/api/reviews/mine?courseId=${C}&teacherId=${T}&voterId=${V}`);
  assert(r.json?.exists === true, "GET /mine exists=true");
  assert(r.json?.review?.attendanceC === "一次未点，很自由", "mine 回填评语");
}
{
  await req("POST", "/api/reviews", { courseId: C, teacherId: T, voterId: V, overall: 2 });
  const r = await req("GET", `/api/reviews/mine?courseId=${C}&teacherId=${T}&voterId=${V}`);
  assert(r.json?.review?.overall === 2, "重复提交覆盖 overall=2");
  assert(r.json?.review?.attendance === null, "覆盖后未带的维度归空（宽表整行覆盖语义）");
}

// ===== 4. comments + helpful =====
{
  const r = await req("GET", `/api/reviews/comments?courseId=${C}&voterId=${V}`);
  const mineRow = Array.isArray(r.json) ? r.json.find((x) => x.mine) : null;
  assert(!!mineRow, "comments 列表含本人评价（mine=true）");
  if (mineRow) {
    const h1 = await req("POST", "/api/reviews/helpful", { reviewId: mineRow.id, voterId: V });
    assert(h1.json?.ok && h1.json?.voted === true && h1.json?.helpful === 1, "helpful 首投 → voted");
    const h2 = await req("POST", "/api/reviews/helpful", { reviewId: mineRow.id, voterId: V });
    assert(h2.json?.ok && h2.json?.voted === false && h2.json?.helpful === 0, "helpful 再投 → 取消");
  }
  const h3 = await req("POST", "/api/reviews/helpful", { reviewId: 99999999, voterId: V });
  assert(h3.status === 404, "helpful 不存在的评价 → 404", `got ${h3.status}`);
}

// ===== 5. 旧兼容端点（读 reviews.overall） =====
{
  const r = await req("GET", `/api/ratings?courseId=${C}`);
  const row = Array.isArray(r.json) ? r.json.find((x) => x.teacher_id === T) : null;
  assert(row?.avg_rating != null, "旧 GET /api/ratings 读到 overall");
  const chk = await req("GET", `/api/ratings/check?courseId=${C}&teacherId=${T}&voterId=${V}`);
  assert(chk.json?.rated === true && chk.json?.rating === 2, "旧 /check 读到 overall=2");
  const all = await req("GET", "/api/ratings/all");
  assert(all.json?.[C]?.[T]?.avg != null, "旧 /all 形状兼容");
}

// ===== 6. 清理（旧 DELETE 撤 overall；行内其他维度已为空 → 整行删除） =====
{
  const r = await req("DELETE", "/api/ratings", { courseId: C, teacherId: T, voterId: V });
  assert(r.json?.ok === true, "旧 DELETE 撤销 overall");
  const mine = await req("GET", `/api/reviews/mine?courseId=${C}&teacherId=${T}&voterId=${V}`);
  assert(mine.json?.exists === false, "全维度空后整行已删除（测试数据自清理）");
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
