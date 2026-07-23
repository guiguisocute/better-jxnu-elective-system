import { useState } from "react";
import { Link } from "react-router-dom";
import type { Course } from "../types";
import { TagBadge } from "./TagBadge";
import { CopyIdButton } from "./CopyIdButton";
import { useCourseReviews } from "../hooks/useReviews";
import { DimensionBars } from "./ratings/DimensionBars";
import { RatingSheet, type RatingSheetTarget } from "./ratings/RatingSheet";
import { formatSemesterLabel } from "../lib/term";

interface Props {
  course: Course;
  onClose: () => void;
  /** 模拟选课模式：详情顶部出现「加入待选清单」主操作。 */
  simMode?: boolean;
  inCart?: boolean;
  onToggleCart?: () => void;
  /** 未开模拟选课时点灰色「加入待选清单」的回调（上层弹「是否开启模拟选课」）。 */
  onRequestEnableSim?: () => void;
}

export function CourseDetail({ course, onClose, simMode = false, inCart = false, onToggleCart, onRequestEnableSim }: Props) {
  const { getDims, refresh } = useCourseReviews(course.id);
  const [sheet, setSheet] = useState<RatingSheetTarget | null>(null);
  const [plansExpanded, setPlansExpanded] = useState(false);

  // 培养方案归属：按年级分组，2025→2022 倒序
  const plans = course.plans ?? [];
  const plansByYear: Record<string, typeof plans> = {};
  for (const p of plans) {
    (plansByYear[p.year] = plansByYear[p.year] || []).push(p);
  }
  const sortedYears = Object.keys(plansByYear).sort((a, b) => b.localeCompare(a));
  const uniqueMajorCount = new Set(plans.map((p) => `${p.year}|${p.major}|${p.direction}`)).size;
  const degreeMajorCount = new Set(
    plans.filter((p) => p.isDegree).map((p) => `${p.year}|${p.major}|${p.direction}`)
  ).size;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="relative px-6 py-5 border-b border-gray-100 shrink-0">
        <button
          onClick={onClose}
          aria-label="关闭"
          className="absolute top-2 right-2 w-11 h-11 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        <h2 className="text-base font-semibold text-gray-900 pr-8 leading-snug">
          <span className="align-middle">{course.name}</span>
          {course.isDegreeCourse && (
            <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-md bg-red-500 text-white text-[10px] font-bold align-middle shadow-sm ring-1 ring-red-300">
              学位课
            </span>
          )}
        </h2>
        <div className="flex items-center gap-1.5 mt-2.5">
          <span className="text-xs text-gray-500 font-mono">{course.id}</span>
          <CopyIdButton text={course.id} />
          <span className="ml-1 inline-flex items-center px-2 py-0.5 rounded-md bg-red-50 text-red-500 text-xs font-semibold">
            {course.credits} 学分
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-5 space-y-6">
          {/* Tags */}
          {course.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {course.tags.map((tag) => (
                <TagBadge key={tag} tag={tag} />
              ))}
            </div>
          )}

          {/* 历史/实际授课提示 —— 顶部全详情页可见；仅当老师来自历史（非预选目录原始记录）时出现。
              覆盖两种情况：
                · teachersFromFormal=true：catalog 没老师，用了 formal 的真实老师补全；
                · inPre=false：master 里有但 catalog 没收录，整条都靠 formal 补出来。 */}
          {(course.teachersFromFormal || course.inPre === false) && (
            <p className="text-[12px] text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2 leading-relaxed">
              教师为历史 / 实际授课记录，不代表本选课阶段一定可选。
            </p>
          )}

          {/* 模拟选课：加入待选清单主操作。未开模拟选课时显示灰色按钮，点击弹「是否开启」。 */}
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
          {simMode && (
            <button
              onClick={onToggleCart}
              className={`group w-full h-11 rounded-full font-semibold text-sm inline-flex items-center justify-center gap-2 transition-all duration-200 active:scale-[0.98] ${
                inCart
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 hover:border-emerald-300"
                  : "bg-gradient-to-r from-red-500 to-rose-500 text-white shadow-md shadow-rose-200/70 hover:shadow-lg hover:shadow-rose-300 hover:from-red-600 hover:to-rose-600"
              }`}
            >
              {inCart ? (
                <>
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500 text-white shrink-0">
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                  </span>
                  <span>已加入待选清单</span>
                  <span className="text-[11px] font-normal text-emerald-600/70 group-hover:text-emerald-700">· 点此移出</span>
                </>
              ) : (
                <>
                  <svg className="w-4 h-4 transition-transform duration-200 group-hover:scale-110 group-hover:-rotate-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" /><path d="M1 1h4l2.7 13.4a2 2 0 002 1.6h9.7a2 2 0 002-1.6L23 6H6" />
                  </svg>
                  <span>加入待选清单</span>
                </>
              )}
            </button>
          )}

          {/* Info grid */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-4">
            <InfoItem label="开课学院" value={course.dept} />
            <InfoItem label="开课学期" value={course.semester ? formatSemesterLabel(course.semester) : "未指定"} />
            {course.englishName && (
              <InfoItem label="英文名称" value={course.englishName} span2 />
            )}
            {course.prereqDesc && (
              <InfoItem label="先修课程" value={course.prereqDesc} span2 />
            )}
          </div>

          {/* Description */}
          {course.desc && (
            <div>
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">课程简介</h3>
              <p className="text-[13px] text-gray-700 whitespace-pre-line bg-gray-50 rounded-xl px-5 py-4" style={{ lineHeight: 1.8 }}>
                {course.desc}
              </p>
            </div>
          )}

          {/* Plans (培养方案归属) */}
          {plans.length > 0 && (
            <div className="rounded-xl bg-gradient-to-br from-indigo-50/50 via-white to-white border border-indigo-100/70 overflow-hidden">
              {/* 标题栏 */}
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

              {/* 统计 banner */}
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

              {/* 展开内容 */}
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

          {/* Teachers */}
          {course.teachers.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                任课教师 ({course.teachers.length})
              </h3>
              <p className="text-[11px] text-gray-400 leading-relaxed mb-3">
                以下评分均为用户匿名主观评价，仅反映其对任课教师在本课程中表现的个人看法，不代表作者立场，仅供参考
              </p>
              <div className="space-y-2">
                {course.teachers.map((t, i) => {
                  const dims = getDims(t.id);
                  return (
                    <div key={i} className="bg-gray-50 rounded-xl px-4 py-3">
                      <div className="flex items-center gap-3.5">
                        <div className="w-9 h-9 rounded-full bg-red-50 text-red-400 flex items-center justify-center text-sm font-semibold shrink-0">
                          {t.name[0]}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-medium text-gray-800">
                            {t.name}
                            <span className="text-gray-400 font-normal ml-1.5 text-xs">{t.gender}</span>
                          </div>
                          <div className="text-xs text-gray-500 mt-0.5">
                            教号 {t.id} · {t.dept}
                          </div>
                        </div>
                        <button
                          onClick={() =>
                            setSheet({
                              teacherId: t.id,
                              teacherName: t.name,
                              courseOptions: [{ id: course.id, name: course.name }],
                              initialCourseId: course.id,
                            })
                          }
                          className="shrink-0 px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs font-semibold hover:bg-red-100 transition-colors self-center"
                        >
                          ✎ 写评价
                        </button>
                      </div>
                      <div className="mt-3">
                        <DimensionBars dims={dims} compact />
                        <Link
                          to={`/ratings?view=teacher&teacher=${encodeURIComponent(t.id)}`}
                          className="inline-block mt-2.5 text-[11px] text-gray-400 hover:text-red-500 transition-colors"
                        >
                          查看这位老师的全部评价 →
                        </Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {course.teachers.length === 0 && (
            <div className="text-center text-gray-400 py-10 text-sm">
              暂无教师信息
            </div>
          )}

          <div className="text-center">
            <a
              href={`https://xk.jxnu.edu.cn/Step1/AddCourse.aspx?kch=${course.id}`}
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

      {sheet && (
        <RatingSheet
          target={sheet}
          onClose={() => setSheet(null)}
          onSubmitted={() => void refresh()}
        />
      )}
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
