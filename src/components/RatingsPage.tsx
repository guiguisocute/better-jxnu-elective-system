import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router-dom";
import { useCourseData } from "../hooks/useCourseData";
import { useFormalData } from "../hooks/useFormalData";
import { useAllReviews, useReviewComments } from "../hooks/useReviews";
import { usePlanCourses } from "../hooks/usePlanCourses";
import { useCreditPlan } from "../hooks/useCreditPlan";
import type { FormalSection } from "../types";
import type { Dimension, ReviewRow, TeacherDims } from "../lib/reviewDimensions";
import { DIMENSIONS, compositeOf } from "../lib/reviewDimensions";
import { toggleHelpful, fetchMyReview } from "../lib/reviewsStore";
import { getVoterId } from "../lib/voter";
import { deriveQuickReviewSections, formalSectionKey } from "../lib/quickReview";
import { StarRating } from "./StarRating";
import { ThemeToggle } from "./ThemeToggle";
import { DimensionBars } from "./ratings/DimensionBars";
import { ReviewCard } from "./ratings/ReviewCard";
import { RatingSheet, type RatingSheetTarget } from "./ratings/RatingSheet";

type ViewMode = "course" | "teacher";
type SortMode = "latest" | "helpful" | "best";
type ListSort = "rating" | "count" | "name";

interface TeacherEntry {
  id: string;
  name: string;
  dept: string;
  courseIds: string[];
}

interface CourseEntry {
  id: string;
  name: string;
  dept: string;
  teacherIds: string[];
}

/** 跨课程聚合一位老师的各维度（按 count 加权） */
function aggregateTeacherDims(courseDims: TeacherDims[]): TeacherDims {
  const out: TeacherDims = {};
  for (const d of DIMENSIONS as Dimension[]) {
    let sum = 0;
    let count = 0;
    for (const dims of courseDims) {
      const agg = dims[d];
      if (agg && agg.count > 0) {
        sum += agg.avg * agg.count;
        count += agg.count;
      }
    }
    if (count > 0) out[d] = { avg: sum / count, count };
  }
  return out;
}

function sortRows(rows: ReviewRow[], sort: SortMode): ReviewRow[] {
  const copy = [...rows];
  if (sort === "helpful") copy.sort((a, b) => b.helpful - a.helpful);
  else if (sort === "best") copy.sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1));
  // latest = 服务端默认 updated_at DESC
  return copy;
}

// 课程评价子页面：与主页同一条红 banner（像切换页面而非跳转），左列实体列表（独立滚动 +
// 基本筛选/排序）+ 右侧详情（综合评分 + 5 维彩条 + 写评价 + 全部评价卡片流 + 上学期快评）。
export function RatingsPage() {
  const { courses } = useCourseData();
  const formal = useFormalData();
  const { dimsMap, getDims } = useAllReviews();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>("latest");
  const [listDept, setListDept] = useState("");
  const [listSort, setListSort] = useState<ListSort>("rating");
  const [sheet, setSheet] = useState<RatingSheetTarget | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);

  // ===== 上学期快评推导（学号导入状态在 localStorage，与主页共享）=====
  const [currentPlan] = useState<string>(() => {
    try {
      const raw = sessionStorage.getItem("jxnu_filters");
      if (raw) return (JSON.parse(raw).filters?.plan as string) ?? "";
    } catch { /* ignore */ }
    return "";
  });
  // 只取 credit.term / stored.importedDetailCourses（均来自 localStorage）——
  // 不加载 5MB 方案课程表（open=false），不渲染任何模拟选课 UI。
  const planCourses = usePlanCourses(false, currentPlan);
  const credit = useCreditPlan(currentPlan, [], planCourses.courses, planCourses.coursesOf);

  const quickReview = useMemo(
    () =>
      deriveQuickReviewSections({
        plan: currentPlan,
        term: credit.term,
        importedDetailCourses: credit.stored.importedDetailCourses,
        formalSections: formal.sections,
        allSemesters: formal.allSemesters,
      }),
    [currentPlan, credit.term, credit.stored.importedDetailCourses, formal.sections, formal.allSemesters],
  );

  const view: ViewMode = params.get("view") === "course" ? "course" : "teacher";
  const selectedId = params.get(view === "course" ? "course" : "teacher") ?? "";

  // ---- 目录索引（courses.json ∪ formal_sections.json，覆盖往期课程/教师） ----
  const { teacherIndex, courseIndex } = useMemo(() => {
    const teachers = new Map<string, TeacherEntry>();
    const courseMap = new Map<string, CourseEntry>();
    const link = (tid: string, tname: string, tdept: string, cid: string, cname: string, cdept: string) => {
      if (!tid || !cid) return;
      let t = teachers.get(tid);
      if (!t) {
        t = { id: tid, name: tname, dept: tdept, courseIds: [] };
        teachers.set(tid, t);
      }
      if (!t.name && tname) t.name = tname;
      if (!t.dept && tdept) t.dept = tdept;
      if (!t.courseIds.includes(cid)) t.courseIds.push(cid);
      let c = courseMap.get(cid);
      if (!c) {
        c = { id: cid, name: cname, dept: cdept, teacherIds: [] };
        courseMap.set(cid, c);
      }
      if (!c.name && cname) c.name = cname;
      if (!c.teacherIds.includes(tid)) c.teacherIds.push(tid);
    };
    for (const c of courses) {
      if (!courseMap.has(c.id)) {
        courseMap.set(c.id, { id: c.id, name: c.name, dept: c.dept, teacherIds: [] });
      }
      for (const t of c.teachers) link(t.id, t.name, t.dept, c.id, c.name, c.dept);
    }
    for (const s of formal.sections) {
      link(s.teacherId, s.teacher, s.dept, s.id, s.name, s.dept);
    }
    return { teacherIndex: teachers, courseIndex: courseMap };
  }, [courses, formal.sections]);

  // ---- 每位老师的全量聚合（跨课程） ----
  const teacherAgg = useMemo(() => {
    const agg = new Map<string, TeacherDims>();
    const byTeacher = new Map<string, TeacherDims[]>();
    for (const [, tmap] of dimsMap) {
      for (const [tid, dims] of tmap) {
        (byTeacher.get(tid) ?? byTeacher.set(tid, []).get(tid)!).push(dims);
      }
    }
    for (const [tid, list] of byTeacher) agg.set(tid, aggregateTeacherDims(list));
    return agg;
  }, [dimsMap]);

  const courseOverall = useMemo(() => {
    const m = new Map<string, { avg: number; count: number }>();
    for (const [cid, tmap] of dimsMap) {
      let sum = 0;
      let n = 0;
      let count = 0;
      for (const dims of tmap.values()) {
        if (dims.overall && dims.overall.count > 0) {
          sum += dims.overall.avg;
          n++;
          count += dims.overall.count;
        }
      }
      if (n > 0) m.set(cid, { avg: sum / n, count });
    }
    return m;
  }, [dimsMap]);

  // ---- 左列列表：默认 = 有评价的实体；搜索 = 全目录。附基本筛选（学院）+ 排序 ----
  const q = search.trim().toLowerCase();

  const teacherList = useMemo(() => {
    let ids: string[];
    if (q) {
      ids = [...teacherIndex.values()]
        .filter((t) => {
          if (t.name.toLowerCase().includes(q) || t.id.includes(q) || t.dept.toLowerCase().includes(q)) return true;
          return t.courseIds.some((cid) => (courseIndex.get(cid)?.name ?? "").toLowerCase().includes(q));
        })
        .map((t) => t.id)
        .slice(0, 120);
    } else {
      ids = [...teacherAgg.keys()];
    }
    let list = ids.map((tid) => ({
      entry: teacherIndex.get(tid) ?? { id: tid, name: `教师 ${tid}`, dept: "", courseIds: [] },
      agg: teacherAgg.get(tid),
    }));
    if (listDept) list = list.filter((x) => x.entry.dept === listDept);
    if (listSort === "rating") {
      list.sort((a, b) => (b.agg?.overall?.avg ?? -1) - (a.agg?.overall?.avg ?? -1));
    } else if (listSort === "count") {
      list.sort((a, b) => (b.agg?.overall?.count ?? 0) - (a.agg?.overall?.count ?? 0));
    } else {
      list.sort((a, b) => a.entry.name.localeCompare(b.entry.name, "zh"));
    }
    return list;
  }, [q, teacherIndex, teacherAgg, courseIndex, listDept, listSort]);

  const courseList = useMemo(() => {
    let ids: string[];
    if (q) {
      ids = [...courseIndex.values()]
        .filter((c) => c.name.toLowerCase().includes(q) || c.id.includes(q) || c.dept.toLowerCase().includes(q))
        .map((c) => c.id)
        .slice(0, 120);
    } else {
      ids = [...courseOverall.keys()];
    }
    let list = ids.map((cid) => ({
      entry: courseIndex.get(cid) ?? { id: cid, name: `课程 ${cid}`, dept: "", teacherIds: [] },
      overall: courseOverall.get(cid),
    }));
    if (listDept) list = list.filter((x) => x.entry.dept === listDept);
    if (listSort === "rating") {
      list.sort((a, b) => (b.overall?.avg ?? -1) - (a.overall?.avg ?? -1));
    } else if (listSort === "count") {
      list.sort((a, b) => (b.overall?.count ?? 0) - (a.overall?.count ?? 0));
    } else {
      list.sort((a, b) => a.entry.name.localeCompare(b.entry.name, "zh"));
    }
    return list;
  }, [q, courseIndex, courseOverall, listDept, listSort]);

  /** 学院下拉选项：当前视图列表（未套学院筛选前）出现过的学院 */
  const deptOptions = useMemo(() => {
    const set = new Set<string>();
    if (view === "teacher") {
      const ids = q ? teacherList.map((x) => x.entry.id) : [...teacherAgg.keys()];
      for (const tid of ids) {
        const d = teacherIndex.get(tid)?.dept;
        if (d) set.add(d);
      }
    } else {
      const ids = q ? courseList.map((x) => x.entry.id) : [...courseOverall.keys()];
      for (const cid of ids) {
        const d = courseIndex.get(cid)?.dept;
        if (d) set.add(d);
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b, "zh"));
    // teacherList/courseList 已含 listDept 过滤，这里只取集合，轻微偏差可接受
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, q, teacherAgg, courseOverall, teacherIndex, courseIndex]);

  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("view", view);
    next.set(view === "course" ? "course" : "teacher", id);
    setParams(next, { replace: false });
  };

  const switchView = (v: ViewMode) => {
    const next = new URLSearchParams();
    next.set("view", v);
    setParams(next, { replace: false });
    setListDept("");
  };

  // ---- 右侧详情数据 ----
  const selTeacher = view === "teacher" && selectedId ? teacherIndex.get(selectedId) : undefined;
  const selCourse = view === "course" && selectedId ? courseIndex.get(selectedId) : undefined;
  const { rows: teacherRows, refresh: refreshTeacherRows } = useReviewComments(
    undefined,
    view === "teacher" && selectedId ? selectedId : undefined
  );
  const { rows: courseRows, refresh: refreshCourseRows } = useReviewComments(
    view === "course" && selectedId ? selectedId : undefined,
    undefined
  );
  const rows = view === "teacher" ? teacherRows : courseRows;
  const refreshRows = view === "teacher" ? refreshTeacherRows : refreshCourseRows;

  const sortedRows = useMemo(() => sortRows(rows ?? [], sort), [rows, sort]);
  const hotId = useMemo(() => {
    let best: ReviewRow | null = null;
    for (const r of rows ?? []) {
      if (r.helpful >= 3 && (!best || r.helpful > best.helpful)) best = r;
    }
    return best?.id ?? null;
  }, [rows]);

  const courseNameOf = (cid: string) => courseIndex.get(cid)?.name ?? cid;

  const openSheetForTeacher = (tid: string, initialCourseId?: string) => {
    const t = teacherIndex.get(tid);
    if (!t) return;
    setSheet({
      teacherId: tid,
      teacherName: t.name,
      courseOptions: t.courseIds.map((cid) => ({ id: cid, name: courseNameOf(cid) })),
      initialCourseId,
    });
  };

  const hasSelection = !!(selTeacher || selCourse);

  return (
    <div className="min-h-screen bg-page">
      {/* 与主页同一条红 banner（像切换页面而非跳转到别的站） */}
      <header className="sticky top-0 z-40">
        <div className="bg-header relative z-10 pt-[env(safe-area-inset-top)]">
          <div className="max-w-[2000px] mx-auto px-4 md:px-6 flex items-center justify-between py-2.5">
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              <img src="/img/JXNUlogo.png" alt="JXNU" className="w-7 h-7 rounded-lg object-contain shrink-0" />
              <h1 className="text-sm font-bold tracking-tight text-brand-fg truncate">JXNU选课PLUS</h1>
              <span className="text-xs hidden sm:inline shrink-0" style={{ color: "rgba(255,255,255,0.8)" }}>江西师范大学</span>
              <span className="shrink-0 inline-flex items-center gap-1 h-7 rounded-lg px-2 text-xs font-bold bg-white text-red-600">
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.2 1 5.9L12 17l-5.2 2.8 1-5.9-4.3-4.2 5.9-.9L12 3.5z" />
                </svg>
                课程评价
              </span>
            </div>
            <div className="flex items-center gap-2 md:gap-2.5 shrink-0">
              <Link
                to="/"
                className="shrink-0 h-8 rounded-lg px-2.5 text-xs font-semibold inline-flex items-center gap-1.5 bg-white/20 text-white hover:bg-white/30 transition-colors"
              >
                ← 返回选课
              </Link>
              <ThemeToggle />
            </div>
          </div>
        </div>

        {/* 工具条：视图切换 + 搜索 + 评语排序 */}
        <div className="bg-white border-b border-gray-100 shadow-sm">
          <div className="max-w-[2000px] mx-auto px-4 md:px-6 py-2.5 flex items-center gap-3 flex-wrap">
            <div className="inline-flex rounded-full bg-gray-100 p-0.5">
              {(["course", "teacher"] as ViewMode[]).map((v) => (
                <button
                  key={v}
                  onClick={() => switchView(v)}
                  className={`px-4 py-1.5 rounded-full text-[13px] font-semibold transition-colors ${
                    view === v ? "bg-white text-red-600 shadow-sm ring-1 ring-red-100" : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  {v === "course" ? "按课程" : "按老师"}
                </button>
              ))}
            </div>
            <div className="relative flex-1 min-w-[180px] max-w-sm">
              <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索课程、老师、学院…"
                className="w-full rounded-full border border-gray-200 pl-9 pr-3 py-1.5 text-[13px] bg-gray-50 focus:bg-white focus:border-red-200 outline-none transition-colors"
              />
            </div>
            <div className="hidden sm:flex items-center gap-1.5 ml-auto">
              <span className="text-[12px] text-gray-400">评价排序</span>
              {(
                [
                  ["latest", "最新"],
                  ["helpful", "最有帮助"],
                  ["best", "好评优先"],
                ] as [SortMode, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setSort(key)}
                  className={`px-3 py-1 rounded-full text-[12px] font-semibold transition-colors ${
                    sort === key
                      ? "bg-red-50 text-red-600 ring-1 ring-red-200"
                      : "text-gray-500 ring-1 ring-gray-200 hover:text-gray-700"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {/* 上学期快评入口：低调按钮（学号导入匹配到上学期班级时才出现） */}
            {quickReview.sections.length > 0 && (
              <button
                onClick={() => setQuickOpen(true)}
                title={`评价 ${quickReview.semester} 上过的 ${quickReview.sections.length} 门课`}
                className="shrink-0 px-3 py-1 rounded-full text-[12px] font-semibold text-gray-500 ring-1 ring-gray-200 hover:text-red-600 hover:ring-red-200 transition-colors"
              >
                ⭐ 评价上学期课程
                <span className="ml-1 tabular-nums text-gray-400">{quickReview.sections.length}</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* 主体：左列表与右详情各自滚动（desktop）。banner 48 + 工具条 ~54 ≈ 102px。 */}
      <main className="max-w-[2000px] mx-auto px-4 md:px-6 py-4 grid grid-cols-1 gap-5 lg:grid-cols-[320px_minmax(0,1fr)] items-start lg:h-[calc(100vh-118px)] overflow-x-clip">
        {/* 左列：实体列表（独立滚动；px-1 给选中描边留位，避免被 overflow 裁掉） */}
        <aside
          className={`${hasSelection ? "hidden lg:flex" : "flex"} min-w-0 flex-col gap-2 lg:h-full lg:overflow-y-auto lg:px-1 pb-6`}
        >
          {/* 左列筛选 + 排序 */}
          <div className="flex items-center gap-2 sticky top-0 bg-page z-10 pb-1">
            <select
              value={listDept}
              onChange={(e) => setListDept(e.target.value)}
              className="flex-1 min-w-0 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-[12px] text-gray-700"
              title="按学院筛选"
            >
              <option value="">全部学院</option>
              {deptOptions.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            <select
              value={listSort}
              onChange={(e) => setListSort(e.target.value as ListSort)}
              className="shrink-0 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-[12px] text-gray-700"
              title="列表排序"
            >
              <option value="rating">评分最高</option>
              <option value="count">评价最多</option>
              <option value="name">按名称</option>
            </select>
          </div>
          <p className="text-[12px] text-gray-400 px-1">
            {view === "teacher" ? `教师 · 共 ${teacherList.length} 位` : `课程 · 共 ${courseList.length} 门`}
            {!q && "（已有评价）"}
          </p>
          {view === "teacher"
            ? teacherList.map(({ entry, agg }) => (
                <button
                  key={entry.id}
                  onClick={() => select(entry.id)}
                  className={`w-full text-left rounded-xl bg-white px-4 py-3 transition-all shrink-0 ${
                    selectedId === entry.id
                      ? "ring-2 ring-red-400 shadow-sm"
                      : "ring-1 ring-gray-100 hover:ring-gray-200 hover:shadow-sm"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-[14px] font-bold truncate ${selectedId === entry.id ? "text-red-600" : "text-gray-800"}`}>
                      {entry.name}
                    </span>
                    <span className="shrink-0 text-[10px] text-gray-400 bg-gray-50 rounded px-1.5 py-0.5">
                      授课 {entry.courseIds.length} 门
                    </span>
                  </div>
                  <div className="text-[11px] text-gray-400 mt-0.5 truncate">{entry.dept || "—"}</div>
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <StarRating rating={agg?.overall?.avg ?? null} />
                    {agg?.overall && (
                      <span className="text-[12px] font-bold text-gray-700 tabular-nums">
                        {agg.overall.avg.toFixed(1)}
                        <span className="text-[10px] text-gray-400 font-normal ml-1">{agg.overall.count} 人</span>
                      </span>
                    )}
                  </div>
                </button>
              ))
            : courseList.map(({ entry, overall }) => (
                <button
                  key={entry.id}
                  onClick={() => select(entry.id)}
                  className={`w-full text-left rounded-xl bg-white px-4 py-3 transition-all shrink-0 ${
                    selectedId === entry.id
                      ? "ring-2 ring-red-400 shadow-sm"
                      : "ring-1 ring-gray-100 hover:ring-gray-200 hover:shadow-sm"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-[14px] font-bold truncate ${selectedId === entry.id ? "text-red-600" : "text-gray-800"}`}>
                      {entry.name}
                    </span>
                    <span className="shrink-0 text-[10px] text-gray-400 font-mono">{entry.id}</span>
                  </div>
                  <div className="text-[11px] text-gray-400 mt-0.5 truncate">{entry.dept || "—"}</div>
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <StarRating rating={overall?.avg ?? null} />
                    {overall && (
                      <span className="text-[12px] font-bold text-gray-700 tabular-nums">
                        {overall.avg.toFixed(1)}
                        <span className="text-[10px] text-gray-400 font-normal ml-1">{overall.count} 人</span>
                      </span>
                    )}
                  </div>
                </button>
              ))}
          {(view === "teacher" ? teacherList : courseList).length === 0 && (
            <div className="text-center text-gray-400 text-[13px] py-10 bg-white rounded-xl ring-1 ring-gray-100">
              {q ? "没有匹配的结果" : "还没有任何评价，搜索一位老师或一门课来抢首评"}
            </div>
          )}
        </aside>

        {/* 右侧详情（独立滚动） */}
        <section className={`${hasSelection ? "" : "hidden lg:block"} min-w-0 lg:h-full lg:overflow-y-auto lg:pr-1 pb-10`}>
          {/* 移动端返回列表 */}
          {hasSelection && (
            <button
              onClick={() => {
                const next = new URLSearchParams();
                next.set("view", view);
                setParams(next);
              }}
              className="lg:hidden mb-3 text-[13px] text-gray-500 inline-flex items-center gap-1 hover:text-red-500"
            >
              ← 返回{view === "teacher" ? "教师" : "课程"}列表
            </button>
          )}

          {!hasSelection && (
            <div className="rounded-2xl bg-white ring-1 ring-gray-100 py-24 text-center text-gray-300 text-sm">
              从左侧选择{view === "teacher" ? "一位老师" : "一门课程"}查看评价
            </div>
          )}

          {/* ===== 按老师 ===== */}
          {selTeacher && (
            <TeacherPanel
              entry={selTeacher}
              agg={teacherAgg.get(selTeacher.id)}
              courseNameOf={courseNameOf}
              onWrite={() => openSheetForTeacher(selTeacher.id)}
            />
          )}

          {/* ===== 按课程 ===== */}
          {selCourse && (
            <div className="rounded-2xl bg-white ring-1 ring-gray-100 p-5 sm:p-6 mb-5">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                    {selCourse.name}
                    <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 text-[10px] font-semibold">课程</span>
                  </h1>
                  <p className="text-[12px] text-gray-400 mt-1">
                    {selCourse.dept} · <span className="font-mono">{selCourse.id}</span>
                  </p>
                </div>
                {courseOverall.get(selCourse.id) && (
                  <div className="text-right">
                    <div className="text-3xl font-black text-red-600 tabular-nums leading-none">
                      {courseOverall.get(selCourse.id)!.avg.toFixed(1)}
                      <span className="text-sm text-gray-300 font-bold"> /5</span>
                    </div>
                    <div className="text-[11px] text-gray-400 mt-1">
                      {courseOverall.get(selCourse.id)!.count} 人评价 · {selCourse.teacherIds.length} 位老师
                    </div>
                  </div>
                )}
              </div>
              {/* 每位授课老师 */}
              <div className="mt-5 space-y-4">
                {selCourse.teacherIds.map((tid) => {
                  const t = teacherIndex.get(tid);
                  const dims = getDims(selCourse.id, tid);
                  return (
                    <div key={tid} className="rounded-xl bg-gray-50/70 px-4 py-3.5">
                      <div className="flex items-center justify-between gap-3 mb-2.5">
                        <button
                          onClick={() => {
                            const next = new URLSearchParams();
                            next.set("view", "teacher");
                            next.set("teacher", tid);
                            setParams(next);
                          }}
                          title="点击查看这位老师的主页与全部评价"
                          className="group/t text-left text-[14px] font-bold text-gray-800 hover:text-red-600 transition-colors cursor-pointer"
                        >
                          <span className="border-b border-dashed border-transparent group-hover/t:border-red-300">
                            {t?.name ?? tid}
                          </span>
                          <span className="text-[11px] text-gray-400 font-normal ml-2">{t?.dept}</span>
                          <span className="inline-flex items-center ml-1.5 text-[11px] text-red-400 opacity-0 group-hover/t:opacity-100 transition-opacity" aria-hidden>
                            查看主页 →
                          </span>
                        </button>
                        <button
                          onClick={() => openSheetForTeacher(tid, selCourse.id)}
                          className="shrink-0 px-3 py-1.5 rounded-full bg-gradient-to-r from-red-500 to-rose-500 text-white text-[12px] font-bold shadow-sm shadow-rose-200/60 hover:from-red-600 hover:to-rose-600 transition-all active:scale-[0.97]"
                        >
                          ✎ 写评价
                        </button>
                      </div>
                      <DimensionBars dims={dims} compact />
                    </div>
                  );
                })}
                {selCourse.teacherIds.length === 0 && (
                  <p className="text-[12px] text-gray-400">暂无该课程的教师记录</p>
                )}
              </div>
            </div>
          )}

          {/* 全部评价 */}
          {hasSelection && (
            <>
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <h2 className="text-[15px] font-bold text-gray-800">
                  全部评价 <span className="text-gray-400 font-normal text-[13px]">{rows?.length ?? 0}</span>
                </h2>
                <span className="text-[11px] text-gray-400">🐢 匿名发布 · 每条评价可只评你在意的维度</span>
              </div>
              <div className="columns-1 xl:columns-2 gap-4 [&>*]:break-inside-avoid [&>*]:mb-4">
                {sortedRows.map((r) => (
                  <ReviewCard
                    key={r.id}
                    row={r}
                    hot={r.id === hotId}
                    courseLabel={
                      view === "teacher"
                        ? courseNameOf(r.courseId)
                        : `${teacherIndex.get(r.teacherId)?.name ?? r.teacherId} 老师`
                    }
                    onToggleHelpful={(id) => void toggleHelpful(id, getVoterId())}
                    onEditMine={r.mine ? () => openSheetForTeacher(r.teacherId, r.courseId) : undefined}
                  />
                ))}
              </div>
              {(rows?.length ?? 0) === 0 && (
                <div className="rounded-2xl bg-white ring-1 ring-gray-100 py-14 text-center text-gray-300 text-sm">
                  还没有评价，点「写评价」抢首评
                </div>
              )}
            </>
          )}
        </section>
      </main>

      {/* 模拟选课悬浮球不在此页复刻 —— SimPanel 状态深度耦合主页；
          待面板提升到 App 层后再做真正的跨子页面共享，避免展示一个假状态的球。 */}

      {quickOpen && (
        <QuickReviewModal
          semester={quickReview.semester}
          sections={quickReview.sections}
          onClose={() => setQuickOpen(false)}
          onWrite={(s) => {
            setQuickOpen(false);
            setSheet({
              teacherId: s.teacherId,
              teacherName: s.teacher || s.teacherId,
              courseOptions: [{ id: s.id, name: s.name || s.id }],
              initialCourseId: s.id,
            });
          }}
        />
      )}

      {sheet && (
        <RatingSheet
          target={sheet}
          onClose={() => setSheet(null)}
          onSubmitted={() => void refreshRows()}
        />
      )}
    </div>
  );
}

function TeacherPanel({
  entry,
  agg,
  courseNameOf,
  onWrite,
}: {
  entry: TeacherEntry;
  agg: TeacherDims | undefined;
  courseNameOf: (cid: string) => string;
  onWrite: () => void;
}) {
  const composite = agg ? compositeOf(agg) : null;
  const totalPeople = agg?.overall?.count ?? 0;
  const big = composite ?? agg?.overall?.avg ?? null;
  return (
    <div className="rounded-2xl bg-white ring-1 ring-gray-100 p-5 sm:p-6 mb-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            {entry.name}
            <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 text-[10px] font-semibold">教师</span>
          </h1>
          <p className="text-[12px] text-gray-400 mt-1">{entry.dept || "—"}</p>
          <p className="text-[12px] text-gray-500 mt-1 truncate">
            开课：{entry.courseIds.slice(0, 3).map(courseNameOf).join("、")}
            {entry.courseIds.length > 3 && ` 等 ${entry.courseIds.length} 门`}
          </p>
        </div>
        <button
          onClick={onWrite}
          className="shrink-0 px-4 py-2 rounded-full bg-gradient-to-r from-red-500 to-rose-500 text-white text-[13px] font-bold shadow-md shadow-rose-200/70 hover:from-red-600 hover:to-rose-600 transition-all active:scale-[0.97]"
        >
          ✎ 写评价
        </button>
      </div>

      <div className="mt-5 grid grid-cols-1 sm:grid-cols-[150px_minmax(0,1fr)] gap-5 items-center">
        {/* 综合评分（4 新维度等权平均；无新维度时退回总体分） */}
        <div className="text-center sm:border-r sm:border-gray-100 sm:pr-4">
          <p className="text-[11px] text-gray-400 mb-1">综合评分</p>
          <div className="text-4xl font-black text-red-600 tabular-nums leading-none">
            {big != null ? big.toFixed(1) : "--"}
            <span className="text-sm text-gray-300 font-bold"> /5</span>
          </div>
          <div className="flex justify-center mt-2">
            <StarRating rating={big} size="md" />
          </div>
          <p className="text-[11px] text-gray-400 mt-2">
            {totalPeople} 人评价 · 授课 {entry.courseIds.length} 门
          </p>
        </div>
        <div className="min-w-0">
          <DimensionBars dims={agg ?? null} />
        </div>
      </div>
    </div>
  );
}

/** 上学期快评行：懒查本人是否已评（overall 是否非空），展示 已评/未评 徽章。 */
function QuickReviewRow({ section, onWrite }: { section: FormalSection; onWrite: () => void }) {
  const [rated, setRated] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchMyReview(section.id, section.teacherId, getVoterId()).then((mine) => {
      if (!cancelled) setRated(!!mine && DIMENSIONS.some((d) => typeof mine[d] === "number"));
    });
    return () => {
      cancelled = true;
    };
  }, [section.id, section.teacherId]);

  return (
    <div className="flex items-center gap-3 rounded-xl bg-white ring-1 ring-gray-100 px-3.5 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-gray-800 truncate" title={section.name}>
          {section.name}
        </div>
        <div className="text-[11px] text-gray-400 mt-0.5 truncate">
          {section.teacher || "未指定"} · <span className="font-mono">{section.id}</span>
        </div>
      </div>
      {rated !== null && (
        <span
          className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold ${
            rated ? "bg-emerald-50 text-emerald-600" : "bg-gray-100 text-gray-400"
          }`}
        >
          {rated ? "已评" : "未评"}
        </span>
      )}
      <button
        onClick={onWrite}
        disabled={!section.teacherId}
        className={`shrink-0 px-3 py-1.5 rounded-full text-[12px] font-bold transition-all active:scale-[0.97] ${
          rated
            ? "bg-amber-50 text-amber-700 hover:bg-amber-100"
            : "bg-gradient-to-r from-red-500 to-rose-500 text-white shadow-sm shadow-rose-200/60 hover:from-red-600 hover:to-rose-600"
        } disabled:opacity-40 disabled:cursor-not-allowed`}
      >
        {rated ? "修改" : "✎ 写评价"}
      </button>
    </div>
  );
}

function QuickReviewModal({
  semester,
  sections,
  onClose,
  onWrite,
}: {
  semester: string;
  sections: FormalSection[];
  onClose: () => void;
  onWrite: (s: FormalSection) => void;
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-6"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-xl max-h-[85vh] bg-white rounded-t-2xl sm:rounded-2xl shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-[15px] font-bold text-gray-900">评价上学期课程</h2>
            <p className="text-[11px] text-gray-400 mt-0.5 tabular-nums">
              {semester} · 学号导入匹配到 {sections.length} 门 · 五个维度都可以评，也可以只评在意的
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="w-9 h-9 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 grid gap-2 sm:grid-cols-2">
          {sections.map((s) => (
            <QuickReviewRow key={formalSectionKey(s)} section={s} onWrite={() => onWrite(s)} />
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
