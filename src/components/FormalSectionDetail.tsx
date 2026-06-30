import { useState, useEffect } from "react";
import type { Course, FormalSection } from "../types";
import { parseSchedule, unselectedIncludeSlots } from "../lib/scheduleParse";
import { formatSemesterLabel } from "../lib/term";
import type { ScheduleFilterMap } from "../lib/scheduleParse";
import { SectionScheduleGrid } from "./SectionScheduleGrid";
import { TagBadge } from "./TagBadge";
import { StarRating } from "./StarRating";
import { StarRatingInput } from "./StarRatingInput";
import { ConfirmModal } from "./ConfirmModal";
import { CopyIdButton } from "./CopyIdButton";
import { EnrollmentCapacityBadge } from "./EnrollmentCapacityBadge";
import { useRatings } from "../hooks/useRatings";
import { getVoterId } from "../lib/voter";
import { checkMyRating, deleteMyRating, removeOptimistic } from "../lib/ratingsStore";

interface Props {
  section: FormalSection;
  course?: Course;
  onClose: () => void;
  /** 课表时段筛选状态，用于把未选中的上课时段标红。 */
  scheduleFilter?: ScheduleFilterMap;
  /** 模拟选课模式：本班级信息下方出现「加入待选清单」操作。 */
  simMode?: boolean;
  /**
   * 三态购物车状态：
   *   "none"  = 该课未在车（红色加入按钮）
   *   "exact" = 该课在车 且 当前班级就是用户选定的那个（emerald 已加入）
   *   "other" = 该课在车 但 用户选的是同课其他班级（amber 提示 + 切换按钮）
   */
  cartStatus?: "none" | "exact" | "other";
  onToggleCart?: () => void;
  /** other 状态下，把 chosenSections[cid] 切换到当前 section。 */
  onSwitchChosenSection?: () => void;
  /** 未开模拟选课时点灰色「加入待选清单」的回调（上层弹「是否开启模拟选课」）。 */
  onRequestEnableSim?: () => void;
  /** VPS 实时授课人数；null 表示尚未匹配或服务不可用。 */
  enrolled?: number | null;
  enrollmentStale?: boolean;
}

// 正选/补退选详情页：以 section 为中心，course 命中时补齐 desc/plans/prereq/学位课。
// 任课教师永远只显示该 section 的一位，区别于 CourseDetail 的多教师视图。
export function FormalSectionDetail({
  section, course, onClose, scheduleFilter,
  simMode = false, cartStatus = "none", onToggleCart, onSwitchChosenSection, onRequestEnableSim,
  enrolled = null, enrollmentStale = false,
}: Props) {
  const { getAvg, applyOptimistic, refresh } = useRatings(section.id);
  const [rating, setRating] = useState(0);
  const [editing, setEditing] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [myRating, setMyRating] = useState<number | null>(null);
  const [plansExpanded, setPlansExpanded] = useState(false);

  const teacherId = section.teacherId;
  const teacherName = section.teacher;
  const hasTeacherId = Boolean(teacherId);

  // 培养方案归属：来自 course；按年级分组倒序，与 CourseDetail 同口径
  const plans = course?.plans ?? [];
  const plansByYear: Record<string, typeof plans> = {};
  for (const p of plans) {
    (plansByYear[p.year] = plansByYear[p.year] || []).push(p);
  }
  const sortedYears = Object.keys(plansByYear).sort((a, b) => b.localeCompare(a));
  const uniqueMajorCount = new Set(plans.map((p) => `${p.year}|${p.major}|${p.direction}`)).size;
  const degreeMajorCount = new Set(
    plans.filter((p) => p.isDegree).map((p) => `${p.year}|${p.major}|${p.direction}`)
  ).size;

  // Tags 优先用 course（含 学位课 / 公选课-子分类 等），降级用 section
  const tags = course?.tags?.length ? course.tags : section.tags;
  const dept = course?.dept || section.dept;
  const courseSemester = course?.semester;

  // 上课时间画成周课表网格；warnSlots 仅用于判断是否显示底部冲突说明。
  const meets = parseSchedule(section.schedule);
  const warnSlots = scheduleFilter ? unselectedIncludeSlots(section, scheduleFilter) : [];

  useEffect(() => {
    if (!hasTeacherId) return;
    const voterId = getVoterId();
    checkMyRating(section.id, teacherId, voterId).then((result) => {
      if (result.rated && result.rating !== null) {
        setMyRating(result.rating);
      } else {
        setMyRating(null);
      }
    });
  }, [section.id, teacherId, hasTeacherId]);

  const handleSubmit = () => {
    if (!hasTeacherId || rating === 0) return;
    applyOptimistic(teacherId, rating);
    setMyRating(rating);
    setEditing(false);
    setShowModal(false);
    fetch("/api/ratings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        courseId: section.id,
        teacherId,
        rating,
        voterId: getVoterId(),
      }),
    }).then(() => refresh(section.id)).catch(() => {});
  };

  const handleDelete = () => {
    if (!hasTeacherId) return;
    const voterId = getVoterId();
    removeOptimistic(section.id, teacherId);
    setMyRating(null);
    setEditing(false);
    deleteMyRating(section.id, teacherId, voterId)
      .then(() => refresh(section.id))
      .catch(() => {});
  };

  const avg = hasTeacherId ? getAvg(teacherId) : null;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="relative px-6 py-5 border-b border-gray-100 shrink-0">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        <h2 className="text-base font-semibold text-gray-900 pr-8 leading-snug">
          <span className="align-middle">{section.name || "—"}</span>
          {course?.isDegreeCourse && (
            <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-md bg-red-500 text-white text-[10px] font-bold align-middle shadow-sm ring-1 ring-red-300">
              学位课
            </span>
          )}
        </h2>
        <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
          <span className="text-xs text-gray-500 font-mono">{section.id}</span>
          <CopyIdButton text={section.id} />
          {section.credits > 0 && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-red-50 text-red-500 text-xs font-semibold">
              {section.credits} 学分
            </span>
          )}
          {section.semester && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-gray-50 text-gray-500 text-xs font-medium">
              {formatSemesterLabel(section.semester, { isFormalView: true })}
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-5 space-y-6">
          {/* Tags */}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <TagBadge key={tag} tag={tag} />
              ))}
            </div>
          )}

          {/* 本班级信息（section-specific） */}
          <div className="rounded-xl overflow-hidden">
            <div className="flex items-center gap-2.5 px-4 py-3">
              <span className="w-1 h-5 bg-red-500 rounded-sm" aria-hidden />
              <h3 className="text-[13px] font-semibold text-gray-800">本班级信息</h3>
            </div>
            <div className="mx-4 mb-3 px-3.5 py-3 bg-white rounded-lg ring-1 ring-red-200">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-[13px]">
                <dt className="text-[11px] text-gray-500 uppercase tracking-wider self-center">班级名称</dt>
                <dd className="text-gray-800 break-words">
                  {section.className || "—"}
                  {section.bjh && (
                    <span className="ml-1 font-mono text-[12px] text-gray-400">（{section.bjh}）</span>
                  )}
                </dd>
                <dt className="text-[11px] text-gray-500 uppercase tracking-wider self-center">教室代号</dt>
                <dd className="text-gray-800 break-words font-mono text-[12px]">{section.classroom || "—"}</dd>
                <dt className="text-[11px] text-gray-500 uppercase tracking-wider self-center">已选/容量</dt>
                <dd className="text-gray-800 tabular-nums">
                  <EnrollmentCapacityBadge enrolled={enrolled} capacity={section.capacity} stale={enrollmentStale} />
                </dd>
              </dl>

              {/* 上课时间：只读周课表网格（占用浅红 / 冲突深红），整张表比 dl 宽，单列一块 */}
              <div className="mt-3">
                <div className="text-[11px] text-gray-500 uppercase tracking-wider mb-1.5">上课时间</div>
                {meets.length === 0 ? (
                  <div className="text-[13px] text-gray-800 break-words">{section.schedule || "—"}</div>
                ) : (
                  <SectionScheduleGrid schedule={section.schedule} filter={scheduleFilter} />
                )}
              </div>

              {warnSlots.length > 0 && (
                <p className="mt-2.5 text-[11px] text-rose-600 leading-relaxed flex items-start gap-1">
                  <svg className="w-3.5 h-3.5 shrink-0 mt-px" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path fillRule="evenodd" clipRule="evenodd" d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 0 1 .75.75v3.75a.75.75 0 0 1-1.5 0V9a.75.75 0 0 1 .75-.75zm0 8.25a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5z" />
                  </svg>
                  <span>深红时段不在您筛选时段内，这门课会占用它，可能与您其它课程冲突。</span>
                </p>
              )}
            </div>
          </div>

          {/* 模拟选课：加入/管理待选清单（紧贴本班级信息下方）
              三态：
                none  → 红色"+ 加入待选清单"
                exact → emerald"已加入待选清单 · 点此移出"
                other → amber 提示「同课其他班级已在清单」+「切到本班级」+ 次要"移出"
              判断在 HomePage 完成（cart × chosenSections[cid] vs 本 section key）。
              未开模拟选课时显示灰色按钮，点击弹「是否开启」。 */}
          {!simMode && (
            <button
              onClick={onRequestEnableSim}
              title="模拟选课模式未开启，点击开启"
              className="group w-full h-11 rounded-full font-semibold text-sm inline-flex items-center justify-center gap-2 transition-colors duration-200 active:scale-[0.98] bg-gray-100 text-gray-400 border border-gray-200 hover:bg-gray-200 hover:text-gray-500"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" /><path d="M1 1h4l2.7 13.4a2 2 0 002 1.6h9.7a2 2 0 002-1.6L23 6H6" />
              </svg>
              <span>加入待选清单</span>
            </button>
          )}
          {simMode && cartStatus === "exact" && (
            <button
              onClick={onToggleCart}
              className="group w-full h-11 rounded-full font-semibold text-sm inline-flex items-center justify-center gap-2 transition-all duration-200 active:scale-[0.98] bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 hover:border-emerald-300"
            >
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500 text-white shrink-0">
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
              </span>
              <span>已加入待选清单</span>
              <span className="text-[11px] font-normal text-emerald-600/70 group-hover:text-emerald-700">· 点此移出</span>
            </button>
          )}
          {simMode && cartStatus === "other" && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3">
              <div className="flex items-start gap-2">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-400 text-white shrink-0 mt-px">
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3m0 3.5h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold text-amber-800">同课其他班级已在待选清单</div>
                </div>
              </div>
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  onClick={onSwitchChosenSection}
                  className="flex-1 h-9 rounded-lg bg-amber-500 text-white text-[13px] font-bold hover:bg-amber-600 transition-colors inline-flex items-center justify-center gap-1.5"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4" />
                  </svg>
                  切到本班级
                </button>
                <button
                  onClick={onToggleCart}
                  title="把这门课从待选清单移出"
                  className="shrink-0 h-9 px-3 rounded-lg bg-white border border-gray-200 text-gray-500 text-[12px] font-medium hover:bg-gray-50 hover:text-rose-500 hover:border-rose-200 transition-colors"
                >
                  移出待选
                </button>
              </div>
            </div>
          )}
          {simMode && cartStatus === "none" && (
            <button
              onClick={onToggleCart}
              className="group w-full h-11 rounded-full font-semibold text-sm inline-flex items-center justify-center gap-2 transition-all duration-200 active:scale-[0.98] bg-gradient-to-r from-red-500 to-rose-500 text-white shadow-md shadow-rose-200/70 hover:shadow-lg hover:shadow-rose-300 hover:from-red-600 hover:to-rose-600"
            >
              <svg className="w-4 h-4 transition-transform duration-200 group-hover:scale-110 group-hover:-rotate-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" /><path d="M1 1h4l2.7 13.4a2 2 0 002 1.6h9.7a2 2 0 002-1.6L23 6H6" />
              </svg>
              <span>加入待选清单</span>
            </button>
          )}

          {/* Course-level info grid */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-4">
            <InfoItem label="开课学院" value={dept || "—"} />
            <InfoItem label="开课学期" value={courseSemester || "未指定"} />
            {course?.englishName && (
              <InfoItem label="英文名称" value={course.englishName} span2 />
            )}
            {course?.prereqDesc && (
              <InfoItem label="先修课程" value={course.prereqDesc} span2 />
            )}
          </div>

          {/* 课程简介：正选自带 desc 优先（课程信息.内容简介），降级到预选 master 的 desc */}
          {(section.desc || course?.desc) && (
            <div>
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">课程简介</h3>
              <p className="text-[13px] text-gray-700 whitespace-pre-line bg-gray-50 rounded-xl px-5 py-4" style={{ lineHeight: 1.8 }}>
                {section.desc || course?.desc}
              </p>
            </div>
          )}

          {/* 培养方案归属（plans 块完全沿用 CourseDetail 样式） */}
          {plans.length > 0 && (
            <div className="rounded-xl bg-gradient-to-br from-indigo-50/50 via-white to-white border border-indigo-100/70 overflow-hidden">
              <button
                onClick={() => setPlansExpanded((v) => !v)}
                className="w-full flex items-center justify-between text-left px-4 py-3 hover:bg-indigo-50/40 transition-colors"
              >
                <div className="flex items-center gap-2.5">
                  <span className="w-1 h-5 bg-indigo-400 rounded-sm" aria-hidden />
                  <h3 className="text-[13px] font-semibold text-gray-800">培养方案归属</h3>
                  <span className="text-[10px] text-indigo-600 font-semibold bg-indigo-100/70 px-1.5 py-0.5 rounded tabular-nums">
                    {plans.length}
                  </span>
                </div>
                <svg
                  className={`w-4 h-4 text-indigo-400 transition-transform ${plansExpanded ? "rotate-180" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              <div className="mx-4 mb-3 flex items-baseline gap-4 px-3.5 py-2.5 bg-white/70 rounded-lg ring-1 ring-indigo-100/50">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[17px] font-bold text-indigo-600 tabular-nums leading-none">
                    {uniqueMajorCount}
                  </span>
                  <span className="text-[11px] text-gray-500">个专业开设</span>
                </div>
                {degreeMajorCount > 0 && (
                  <>
                    <div className="w-px h-4 bg-gray-200" aria-hidden />
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[17px] font-bold text-red-500 tabular-nums leading-none">
                        {degreeMajorCount}
                      </span>
                      <span className="text-[11px] text-gray-500">列为学位课</span>
                    </div>
                  </>
                )}
              </div>

              {plansExpanded && (
                <div className="px-4 pb-4 space-y-3">
                  {sortedYears.map((year) => (
                    <div key={year}>
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-indigo-100/70 text-indigo-700 text-[11px] font-semibold tabular-nums">
                          {year}级
                        </span>
                        <div className="flex-1 h-px bg-indigo-100/50" aria-hidden />
                        <span className="text-[10px] text-gray-400 tabular-nums">
                          {plansByYear[year].length}
                        </span>
                      </div>
                      <div className="space-y-1.5">
                        {plansByYear[year].map((p, i) => (
                          <div
                            key={`${year}-${p.major}-${p.direction}-${i}`}
                            className={`rounded-lg px-3 py-2 transition-colors ${
                              p.isDegree
                                ? "bg-red-50/50 ring-1 ring-red-200/60"
                                : "bg-white ring-1 ring-gray-100"
                            }`}
                          >
                            <div className="flex items-start gap-2">
                              <div className="flex-1 min-w-0">
                                <div className="text-[13px] text-gray-800 font-medium truncate leading-tight">
                                  {p.major}
                                </div>
                                {p.direction && (
                                  <div className="text-[11px] text-indigo-500 truncate mt-0.5 flex items-center gap-1">
                                    <span className="text-[10px] opacity-70" aria-hidden>↳</span>
                                    <span className="truncate">{p.direction}</span>
                                  </div>
                                )}
                              </div>
                              {p.semester && (
                                <span className="text-[10px] text-gray-400 tabular-nums shrink-0 mt-0.5 font-mono">
                                  {p.semester}
                                </span>
                              )}
                            </div>
                            {(p.nature || p.isDegree) && (
                              <div className="flex flex-wrap gap-1 mt-1.5">
                                {p.nature && <TagBadge tag={p.nature} />}
                                {p.isDegree && <TagBadge tag="学位课" />}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 任课教师（单个） */}
          <div>
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
              任课教师
            </h3>
            <p className="text-[11px] text-gray-400 leading-relaxed mb-3">
              以下评分均为用户主观评价，仅反映其对任课教师在本课程中表现的个人看法，不代表作者立场，仅供参考
            </p>
            <div className="bg-gray-50 rounded-xl px-4 py-3">
              <div className="flex items-center gap-3.5">
                <div className="w-9 h-9 rounded-full bg-red-50 text-red-400 flex items-center justify-center text-sm font-semibold shrink-0">
                  {teacherName ? teacherName[0] : "—"}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-gray-800">
                    {teacherName || "（未指定）"}
                  </div>
                  {hasTeacherId && (
                    <div className="text-xs text-gray-500 mt-0.5">教号 {teacherId}</div>
                  )}
                </div>
                {hasTeacherId && (
                  <button
                    onClick={() => {
                      const next = !editing;
                      setEditing(next);
                      if (next) setRating(myRating ?? 0);
                    }}
                    className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors self-center"
                    style={{
                      backgroundColor: editing ? "#FEE2E2" : myRating != null ? "#FEF3C7" : "#FEE2E2",
                      color: editing ? "#DC2626" : myRating != null ? "#D97706" : "#DC2626",
                    }}
                  >
                    {editing ? "收起" : myRating != null ? "修改评分" : "评分"}
                  </button>
                )}
              </div>
              <div className="flex items-center mt-2 pl-[52px]">
                <StarRating rating={avg?.avg_rating ?? null} count={avg?.count} />
              </div>
              {editing && hasTeacherId && (
                <div className="mt-3 pl-[52px]">
                  <StarRatingInput value={rating} onChange={setRating} />
                  <div className="flex gap-2 mt-2.5">
                    <button
                      onClick={() => setEditing(false)}
                      className="flex-1 py-1.5 rounded-lg border border-gray-200 text-[11px] text-gray-600 hover:bg-gray-50"
                    >
                      取消
                    </button>
                    {myRating != null && (
                      <button
                        onClick={handleDelete}
                        className="flex-1 py-1.5 rounded-lg border border-red-200 text-[11px] text-red-500 font-medium hover:bg-red-50 transition-colors"
                      >
                        撤销评分
                      </button>
                    )}
                    <button
                      onClick={() => rating > 0 && setShowModal(true)}
                      disabled={rating === 0}
                      className="flex-1 py-1.5 rounded-lg bg-red-500 text-white text-[11px] font-medium hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      提交评分
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="text-center">
            <a
              href={`https://xk.jxnu.edu.cn/Step1/AddCourse.aspx?kch=${section.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-1.5 text-red-400 hover:text-red-500 transition-colors"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
              </svg>
              <span className="text-base font-medium border-b border-dashed border-red-300">点击跳转此课程选课界面</span>
            </a>
          </div>
        </div>
      </div>

      <ConfirmModal
        open={showModal}
        teacherName={teacherName}
        rating={rating}
        existingRating={myRating}
        onConfirm={handleSubmit}
        onCancel={() => setShowModal(false)}
      />
    </div>
  );
}

function InfoItem({ label, value, span2 }: { label: string; value: string; span2?: boolean }) {
  return (
    <div className={span2 ? "col-span-2" : ""}>
      <div className="text-[11px] text-gray-500 mb-1 uppercase tracking-wider">{label}</div>
      <div className="text-[13px] text-gray-700 leading-relaxed">{value}</div>
    </div>
  );
}
