import type { AllReviews, Dimension, ReviewRow, ReviewSubmit, TeacherDims } from "./reviewDimensions";

// 评价系统 V2 数据层：模块级 pub/sub store（与 ratingsStore 同款范式）。
// real 数据两块：dims 聚合（Map<courseId, Map<teacherId, TeacherDims>>）+ 评语流缓存。
// 提交走 POST /api/reviews，响应带该 (course, teacher) 的权威聚合，直接覆盖 —— 不需要
// 旧 store 那套乐观对账（RatingSheet 在提交期间展示自己的本地状态）。

type Listener = () => void;

/** 三类可等待资源（全站聚合 / 各评语流）的加载状态；idle=尚未发起 */
export type LoadStatus = "idle" | "loading" | "ready" | "error";

const dims = new Map<string, Map<string, TeacherDims>>();
const comments = new Map<string, ReviewRow[]>(); // key: `${courseId}|${teacherId ?? ""}`
const listeners = new Set<Listener>();
let version = 0;
let allStatus: LoadStatus = "idle";
const commentsStatus = new Map<string, LoadStatus>();
// dims 是就地变更的（setTeacherDims 直接 .set）；交给 React 的必须是每次 notify 后的新引用
// 快照（外层浅拷贝），否则依赖 [dimsMap] 的 useMemo 因引用恒等永不重算 ——
// 这正是「F5 直进 /ratings 后数据到了列表也永远空着，得回主页再进」的根因。
let dimsSnapshot: Map<string, Map<string, TeacherDims>> = new Map();

function notify() {
  version++;
  dimsSnapshot = new Map(dims);
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
  return dimsSnapshot;
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

export function getAllReviewsStatus(): LoadStatus {
  return allStatus;
}

export function getCommentsStatus(courseId: string | undefined, teacherId: string | undefined): LoadStatus {
  return commentsStatus.get(commentsKey(courseId, teacherId)) ?? "idle";
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

/** 批量加载专用：网络层异常 / 5xx 自动重试（退避），4xx 与 200-非JSON（dev 无 Functions）直接失败。
 *  失败返回 { ok:false } 而非静默空数据 —— 调用方据此进入 error 态，UI 才能给出重试入口。 */
const RETRY_ATTEMPTS = 3;
async function fetchJsonRetry<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false }> {
  for (let i = 0; i < RETRY_ATTEMPTS; i++) {
    try {
      const res = await fetch(url, init);
      const isJson = (res.headers.get("content-type") || "").includes("application/json");
      if (res.ok && isJson) return { ok: true, data: (await res.json()) as T };
      // 200 但非 JSON（dev 无 Functions 回落 index.html）或 4xx：重试无意义
      if (res.ok || (res.status >= 400 && res.status < 500)) return { ok: false };
      // 5xx（D1 抖动等）→ 退避后重试
    } catch {
      /* 网络层失败（断网 / 连接被杀 / 响应截断）→ 退避后重试 */
    }
    if (i < RETRY_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  return { ok: false };
}

function setTeacherDims(courseId: string, teacherId: string, next: TeacherDims) {
  let course = dims.get(courseId);
  if (!course) {
    course = new Map();
    dims.set(courseId, course);
  }
  course.set(teacherId, next);
}

/** 全站聚合 bulk-load（评价子页面 + 列表排序/AI 的 overall 来源）。
 *  状态机每次流转都 notify —— 失败也要让 UI 收到通知（error 态 + 重试按钮），
 *  而不是像旧版那样静默吞掉、页面永远停在"空数据"。 */
export async function fetchAllReviews() {
  allStatus = "loading";
  notify();
  const r = await fetchJsonRetry<AllReviews>("/api/reviews/all", { cache: "no-cache" });
  if (!r.ok) {
    allStatus = "error";
    notify();
    return;
  }
  for (const [cid, teachers] of Object.entries(r.data)) {
    for (const [tid, t] of Object.entries(teachers)) {
      setTeacherDims(cid, tid, t);
    }
  }
  allStatus = "ready";
  notify();
}

/** 幂等触发：idle/error → 发起加载；loading/ready → 不动。
 *  每次组件挂载都调它，等价于"失败后每次进页面自动重试 + 重试按钮可复用"。 */
export function ensureAllReviews() {
  if (allStatus === "loading" || allStatus === "ready") return;
  void fetchAllReviews();
}

/** 单课程聚合刷新（详情页挂载时保鲜） */
export async function fetchCourseReviews(courseId: string) {
  const r = await fetchJsonRetry<{ teacher_id: string; dims: TeacherDims }[]>(
    `/api/reviews?courseId=${encodeURIComponent(courseId)}`,
    { cache: "no-cache" }
  );
  if (!r.ok) return;
  for (const row of r.data) setTeacherDims(courseId, row.teacher_id, row.dims);
  notify();
}

/** 评语流。teacherId 省略 = 该课程全部教师的评价；两者都省略 = 全站广场流。
 *  失败时保留旧 rows（若有）—— 决不能像旧版那样把失败缓存成空数组冒充"已加载且无评价"。 */
export async function fetchReviewComments(courseId: string | undefined, teacherId: string | undefined, voterId: string) {
  const key = commentsKey(courseId, teacherId);
  commentsStatus.set(key, "loading");
  notify();
  const params = new URLSearchParams();
  if (courseId) params.set("courseId", courseId);
  if (teacherId) params.set("teacherId", teacherId);
  params.set("voterId", voterId);
  params.set("limit", "100");
  const r = await fetchJsonRetry<ReviewRow[]>(`/api/reviews/comments?${params}`, { cache: "no-cache" });
  if (!r.ok) {
    commentsStatus.set(key, "error");
    notify();
    return;
  }
  comments.set(key, r.data);
  commentsStatus.set(key, "ready");
  notify();
}

/** 幂等触发（同 ensureAllReviews 语义），供挂载时调用 */
export function ensureReviewComments(courseId: string | undefined, teacherId: string | undefined, voterId: string) {
  const st = getCommentsStatus(courseId, teacherId);
  if (st === "loading" || st === "ready") return;
  void fetchReviewComments(courseId, teacherId, voterId);
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

/** 举报一条评价（一人一条一次，重复幂等） */
export async function reportReview(reviewId: number, voterId: string, reason: string): Promise<boolean> {
  const res = await fetch("/api/reviews/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reviewId, voterId, reason: reason.trim().slice(0, 200) || undefined }),
  });
  const data = await readJson<{ ok?: boolean }>(res, {});
  return !!data.ok;
}

/** 站点评价配置（Turnstile site key 等）；模块级缓存一次 */
let reviewConfigCache: { turnstileSiteKey: string } | null = null;
export async function fetchReviewConfig(): Promise<{ turnstileSiteKey: string }> {
  if (reviewConfigCache) return reviewConfigCache;
  const res = await fetch("/api/reviews/config");
  reviewConfigCache = await readJson(res, { turnstileSiteKey: "" });
  return reviewConfigCache;
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
