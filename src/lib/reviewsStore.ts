import type { AllReviews, Dimension, ReviewRow, ReviewSubmit, TeacherDims } from "./reviewDimensions";

// 评价系统 V2 数据层：模块级 pub/sub store（与 ratingsStore 同款范式）。
// real 数据两块：dims 聚合（Map<courseId, Map<teacherId, TeacherDims>>）+ 评语流缓存。
// 提交走 POST /api/reviews，响应带该 (course, teacher) 的权威聚合，直接覆盖 —— 不需要
// 旧 store 那套乐观对账（RatingSheet 在提交期间展示自己的本地状态）。

type Listener = () => void;

const dims = new Map<string, Map<string, TeacherDims>>();
const comments = new Map<string, ReviewRow[]>(); // key: `${courseId}|${teacherId ?? ""}`
const listeners = new Set<Listener>();
let version = 0;

function notify() {
  version++;
  for (const fn of listeners) fn();
}

export function subscribeReviews(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getReviewsVersion() {
  return version;
}

export function getDimsMap() {
  return dims;
}

export function getTeacherDims(courseId: string, teacherId: string): TeacherDims | null {
  return dims.get(courseId)?.get(teacherId) ?? null;
}

export function commentsKey(courseId: string | undefined, teacherId: string | undefined) {
  return `${courseId ?? ""}|${teacherId ?? ""}`;
}

export function getComments(courseId: string | undefined, teacherId: string | undefined): ReviewRow[] | null {
  return comments.get(commentsKey(courseId, teacherId)) ?? null;
}

// 与 ratingsStore 相同的容错解析：兜底 vite dev 无 Functions 时 /api/* 返回 SPA index.html。
async function readJson<T>(res: Response, fallback: T): Promise<T> {
  if (!res.ok) return fallback;
  if (!(res.headers.get("content-type") || "").includes("application/json")) return fallback;
  try {
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

function setTeacherDims(courseId: string, teacherId: string, next: TeacherDims) {
  let course = dims.get(courseId);
  if (!course) {
    course = new Map();
    dims.set(courseId, course);
  }
  course.set(teacherId, next);
}

/** 全站聚合 bulk-load（评价子页面 + 列表排序/AI 的 overall 来源） */
export async function fetchAllReviews() {
  const res = await fetch("/api/reviews/all", { cache: "no-cache" });
  const all = await readJson<AllReviews>(res, {});
  for (const [cid, teachers] of Object.entries(all)) {
    for (const [tid, t] of Object.entries(teachers)) {
      setTeacherDims(cid, tid, t);
    }
  }
  notify();
}

/** 单课程聚合刷新（详情页挂载时保鲜） */
export async function fetchCourseReviews(courseId: string) {
  const res = await fetch(`/api/reviews?courseId=${encodeURIComponent(courseId)}`, { cache: "no-cache" });
  const rows = await readJson<{ teacher_id: string; dims: TeacherDims }[]>(res, []);
  for (const row of rows) setTeacherDims(courseId, row.teacher_id, row.dims);
  notify();
}

/** 评语流。teacherId 省略 = 该课程全部教师的评价。 */
export async function fetchReviewComments(courseId: string | undefined, teacherId: string | undefined, voterId: string) {
  const params = new URLSearchParams();
  if (courseId) params.set("courseId", courseId);
  if (teacherId) params.set("teacherId", teacherId);
  params.set("voterId", voterId);
  params.set("limit", "100");
  const res = await fetch(`/api/reviews/comments?${params}`, { cache: "no-cache" });
  const rows = await readJson<ReviewRow[]>(res, []);
  comments.set(commentsKey(courseId, teacherId), rows);
  notify();
}

/** 我对该 (课程, 教师) 已提交的完整评价（编辑回填用） */
export async function fetchMyReview(
  courseId: string,
  teacherId: string,
  voterId: string
): Promise<ReviewRow | null> {
  const res = await fetch(
    `/api/reviews/mine?courseId=${encodeURIComponent(courseId)}&teacherId=${encodeURIComponent(teacherId)}&voterId=${encodeURIComponent(voterId)}`,
    { cache: "no-cache" }
  );
  const data = await readJson<{ exists: boolean; review?: ReviewRow }>(res, { exists: false });
  return data.exists && data.review ? data.review : null;
}

/** 提交/覆盖评价；成功后用响应里的权威聚合覆盖本地并刷新相关评语流。
 *  pending = 站点开启了审核模式，该条要等后台审核通过才公开。 */
export async function submitReview(payload: ReviewSubmit): Promise<{ ok: boolean; pending: boolean }> {
  const res = await fetch("/api/reviews", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await readJson<{ ok?: boolean; pending?: boolean; dims?: TeacherDims }>(res, {});
  if (!data.ok) return { ok: false, pending: false };
  if (data.dims) {
    setTeacherDims(payload.courseId, payload.teacherId, data.dims);
    notify();
  }
  // 已缓存的相关评语流后台保鲜（不阻塞提交反馈）
  for (const key of comments.keys()) {
    const [cid, tid] = key.split("|");
    if ((cid === "" || cid === payload.courseId) && (tid === "" || tid === payload.teacherId)) {
      void fetchReviewComments(cid || undefined, tid || undefined, payload.voterId);
    }
  }
  return { ok: true, pending: !!data.pending };
}

/** 「有用」toggle：不可变替换数组（保证依赖 rows 引用的 useMemo 重新计算）、
 *  同一条评价 in-flight 期间忽略连点、失败回滚乐观值、成功用服务器计数校准。 */
const helpfulInFlight = new Set<number>();

function patchReviewRow(reviewId: number, patch: (r: ReviewRow) => ReviewRow) {
  for (const [key, rows] of comments) {
    if (rows.some((r) => r.id === reviewId)) {
      comments.set(key, rows.map((r) => (r.id === reviewId ? patch(r) : r)));
    }
  }
  notify();
}

export async function toggleHelpful(reviewId: number, voterId: string) {
  if (helpfulInFlight.has(reviewId)) return;
  helpfulInFlight.add(reviewId);
  const flip = (r: ReviewRow): ReviewRow => ({
    ...r,
    myVote: !r.myVote,
    helpful: Math.max(0, r.helpful + (r.myVote ? -1 : 1)),
  });
  patchReviewRow(reviewId, flip);
  try {
    const res = await fetch("/api/reviews/helpful", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewId, voterId }),
    });
    const data = await readJson<{ ok?: boolean; helpful?: number; voted?: boolean }>(res, {});
    if (data.ok && typeof data.helpful === "number") {
      patchReviewRow(reviewId, (r) => ({ ...r, helpful: data.helpful!, myVote: !!data.voted }));
    } else {
      patchReviewRow(reviewId, flip); // 服务端未确认 → 回滚乐观翻转
    }
  } catch {
    patchReviewRow(reviewId, flip);
  } finally {
    helpfulInFlight.delete(reviewId);
  }
}

/** 综合分辅助：某课程全部教师 overall 均值（详情页头部「课程总体」用） */
export function courseOverallAvg(courseId: string): number | null {
  const teachers = dims.get(courseId);
  if (!teachers) return null;
  let total = 0;
  let n = 0;
  for (const t of teachers.values()) {
    const o = t.overall as { avg: number; count: number } | undefined;
    if (o && o.count > 0) {
      total += o.avg;
      n++;
    }
  }
  return n > 0 ? total / n : null;
}

export type { Dimension, TeacherDims, ReviewRow, ReviewSubmit };
