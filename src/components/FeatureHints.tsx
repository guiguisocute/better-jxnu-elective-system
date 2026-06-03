import { useState } from "react";
import type { Course } from "../types";
import type { CreditPlanView } from "../lib/creditPlan";
import { PlanSelector } from "./PlanSelector";

// 进站第一屏 = 「毕业规划入口」，而不是选课浏览器。
// 用户选课最痛的两件事:「找不到能选的课」+「算不清能不能毕业」—— 系统其实早就能解,
// 但这能力(buildCreditPlan)被锁在「模拟选课」二级模式里,默认浏览态根本看不到。
// 这一屏把那条主线提到台前,门槛压到最低:
//   学号一键导入 → 专业 + 已修 + 毕业缺口,一步到位(最省事,推荐)
//   或手动选专业 → 毕业目标 + 这学期该上的必修课
// 完整规划(加车/周课表/改已修)仍在模拟选课里做,这一屏只负责「预览 + 把人领进去」。
interface Props {
  variant: "desktop" | "mobile";
  /** 当前选中的培养方案 key（= filter.filters.plan）。空串 = 未选。 */
  selectedPlan: string;
  /** 全部方案选项（年级-专业）。 */
  allPlans: string[];
  /** 选择/切换方案（写入全局 filter.plan）。 */
  onSelectPlan: (plan: string) => void;
  /** 学分核算视图（持续在 useCreditPlan 计算；选了方案 + 方案课加载后才完整）。 */
  creditView: CreditPlanView;
  /** 方案课程清单(~5MB)是否仍在加载 —— 决定「这学期必修课」显示骨架还是真列表。 */
  planCoursesLoading: boolean;
  /** 是否已有真实已修记录（填过 / 学号导入过）—— 据此才亮「毕业还差多少」，避免零输入下显示假缺口。 */
  hasRecord?: boolean;
  /** 学号一键导入：拉档案 + 写已修 + 切方案。reject → 由本组件显示错误。 */
  onImportStudent?: (studentId: string) => Promise<void>;
  /** 学号导入功能开关（featureFlags.STUDENT_IMPORT_ENABLED）。 */
  studentImportEnabled?: boolean;
  /** 填已修 / 学号导入 → 打开模拟选课引导（精校缺口）。 */
  onFillRecord: () => void;
  /** 直接去挑选修课 → 进模拟选课工作台。 */
  onStartElectives: () => void;
  /** 旁路:不关心方案,只想随便逛 → 揭开全部课程列表。 */
  onShowAll: () => void;
  /** 已在模拟选课态(隐藏重复的「挑选修课」入口)。 */
  simActive?: boolean;
  /** 课程号 → Course,用于让「这学期必修课」可点开详情。 */
  coursesById?: Map<string, Course>;
  onSelectCourse?: (course: Course) => void;
}

/* ---------- 图标 ---------- */
function ArrowRightIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7m7-7H4" />
    </svg>
  );
}
function CartIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
      <circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.7 13.4a2 2 0 002 1.6h9.7a2 2 0 002-1.6L23 6H6" />
    </svg>
  );
}
function GradCapIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M22 10L12 5 2 10l10 5 10-5z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 12v4.5c0 1.1 2.7 2.5 6 2.5s6-1.4 6-2.5V12M22 10v5" />
    </svg>
  );
}
function CheckIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}
function IdCardIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.9} viewBox="0 0 24 24" aria-hidden>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="11" r="1.8" /><path strokeLinecap="round" d="M13 10h5M13 13.5h5M6 15.2c.5-1.3 4-1.3 4.5 0" />
    </svg>
  );
}
function PenIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.9} viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}
function SpinnerIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} fill="none" viewBox="0 0 24 24" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
    </svg>
  );
}

const Eyebrow = () => (
  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-50 text-red-500 text-[11px] font-semibold tracking-wide">
    <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
    JXNU 选课 PLUS
  </span>
);

/* ---------- 目标层:毕业要修多少（选方案即瞬时显示，不等方案课加载） ---------- */
function GoalStats({ view }: { view: CreditPlanView }) {
  const required = view.blocks.find((b) => b.key === "required")?.required ?? null;
  const majorElective = view.blocks.find((b) => b.key === "elective")?.subTarget?.required ?? null;
  const items = [
    { label: "毕业总学分", value: view.minTotal },
    { label: "必修", value: required },
    { label: "专业限选", value: majorElective },
  ].filter((it) => it.value != null);
  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map((it) => (
        <div key={it.label} className="rounded-xl bg-gray-50 px-2 py-3 text-center">
          <div className="text-[19px] font-bold text-gray-800 leading-none">{it.value}</div>
          <div className="mt-1.5 text-[11px] text-gray-400">{it.label}</div>
        </div>
      ))}
    </div>
  );
}

/* ---------- 「这学期你该上的必修课」 ---------- */
function RequiredCourses({
  view, loading, coursesById, onSelectCourse,
}: {
  view: CreditPlanView;
  loading: boolean;
  coursesById?: Map<string, Course>;
  onSelectCourse?: (c: Course) => void;
}) {
  const list = view.nextSemRequired;
  const totalCredits = list.reduce((s, c) => s + c.credits, 0);

  if (loading && list.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 py-7 text-[13px] text-gray-400">
        <SpinnerIcon className="w-4 h-4" />
        正在载入你的方案课程…
      </div>
    );
  }
  if (list.length === 0) {
    return (
      <p className="py-6 text-center text-[13px] text-gray-500">
        这学期没有必修课需要安排 —— 直接去挑选修课吧 👇
      </p>
    );
  }
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-[12px] font-semibold text-gray-600">这学期你该上的必修课</span>
        <span className="text-[11px] text-gray-400">{list.length} 门 · {totalCredits} 学分</span>
      </div>
      <div className="space-y-1.5">
        {list.map((pc) => {
          const course = coursesById?.get(pc.cid);
          const clickable = !!course && !!onSelectCourse;
          return (
            <button
              key={pc.cid}
              type="button"
              disabled={!clickable}
              onClick={() => clickable && onSelectCourse!(course!)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl bg-gray-50 text-left transition-colors ${
                clickable ? "hover:bg-gray-100 cursor-pointer" : "cursor-default"
              }`}
            >
              <span className="shrink-0 w-5 h-5 rounded-md bg-blue-50 text-blue-600 inline-flex items-center justify-center">
                <CheckIcon className="w-3 h-3" />
              </span>
              <span className="min-w-0 flex-1 text-[13px] font-medium text-gray-700 truncate">{pc.name}</span>
              <span className="shrink-0 text-[11px] font-medium text-gray-500">{pc.credits} 分</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- 主组件 ---------- */
export function FeatureHints({
  variant, selectedPlan, allPlans, onSelectPlan, creditView, planCoursesLoading, hasRecord,
  onImportStudent, studentImportEnabled, onFillRecord, onStartElectives, onShowAll,
  simActive, coursesById, onSelectCourse,
}: Props) {
  // 选了方案后默认收起选择器(显示徽章 + 换);点「换」再展开。未选方案时一直展开。
  const [editingPlan, setEditingPlan] = useState(false);
  // 学号一键导入(首屏直接进行,不跳引导)。
  const [sid, setSid] = useState("");
  const [importing, setImporting] = useState(false);
  const [importErr, setImportErr] = useState<string | null>(null);

  const hasPlan = !!selectedPlan;
  const showSelector = !hasPlan || editingPlan;
  const compact = variant === "mobile";
  const importEnabled = studentImportEnabled !== false && !!onImportStudent;

  const doImport = async () => {
    const v = sid.trim();
    if (!v || importing) return;
    setImporting(true);
    setImportErr(null);
    try {
      await onImportStudent!(v);
      // 成功:onImportStudent 内部已切方案 + 写已修 → 本组件重渲染为规划面板。
    } catch (e) {
      setImportErr((e as Error).message || "导入失败，请稍后再试。");
    } finally {
      setImporting(false);
    }
  };

  // 未选方案:学号一键导入(主) + 手动选专业(次)。
  const entry = (
    <div className="space-y-3 text-left">
      {importEnabled && (
        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm p-4">
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-2.5 focus-within:border-red-300 transition-colors">
              <IdCardIcon className="w-4 h-4 text-gray-400 shrink-0" />
              <input
                value={sid}
                onChange={(e) => setSid(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") doImport(); }}
                inputMode="numeric"
                placeholder="输入学号"
                className="flex-1 min-w-0 bg-transparent outline-none text-sm text-gray-700 placeholder-gray-400"
              />
            </div>
            <button
              type="button"
              onClick={doImport}
              disabled={importing || !sid.trim()}
              className="shrink-0 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-red-500 text-white text-sm font-semibold shadow-sm shadow-red-500/20 hover:bg-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {importing ? <SpinnerIcon className="w-4 h-4" /> : null}
              一键导入
            </button>
          </div>
          <p className="mt-2 text-[12px] text-gray-400">自动带出你的专业、已修学分和毕业缺口，最省事</p>
          {importErr && <p className="mt-2 text-[12px] text-red-500 leading-relaxed">{importErr}</p>}
        </div>
      )}

      {importEnabled && (
        <div className="flex items-center gap-3 text-[11px] text-gray-300">
          <span className="flex-1 h-px bg-gray-200" />或手动选专业<span className="flex-1 h-px bg-gray-200" />
        </div>
      )}

      <div className="rounded-2xl border border-gray-200 bg-white shadow-sm p-4">
        <PlanSelector value={selectedPlan} onChange={(v) => { onSelectPlan(v); if (v) setEditingPlan(false); }} options={allPlans} />
      </div>
    </div>
  );

  // 选了方案后的规划面板。
  const planPanel = creditView.found ? (
    <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden text-left">
      {/* 当前方案 + 换 */}
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-100">
        <div className="min-w-0 flex items-center gap-2">
          <GradCapIcon className="w-4 h-4 text-red-500 shrink-0" />
          <span className="text-[13px] font-semibold text-gray-700 truncate">{selectedPlan}</span>
        </div>
        <button
          type="button"
          onClick={() => setEditingPlan(true)}
          className="shrink-0 text-[12px] font-medium text-gray-400 hover:text-red-600 transition-colors"
        >
          换
        </button>
      </div>
      <div className="p-4 space-y-4">
        {/* 毕业还差多少 —— 仅在有真实已修记录时显示，避免零输入下的假缺口。 */}
        {hasRecord && creditView.totalRemaining != null && (
          <div className="text-center">
            <span className="text-[13px] text-gray-500">毕业还差 </span>
            <span className="text-[24px] font-bold text-red-500">{creditView.totalRemaining}</span>
            <span className="text-[13px] text-gray-500"> 学分</span>
          </div>
        )}
        <GoalStats view={creditView} />
        <RequiredCourses view={creditView} loading={planCoursesLoading} coursesById={coursesById} onSelectCourse={onSelectCourse} />
        <div className="space-y-2 pt-1">
          <button
            type="button"
            onClick={onFillRecord}
            className="group w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-red-500 text-white text-sm font-semibold shadow-sm shadow-red-500/20 hover:bg-red-600 transition-colors"
          >
            <PenIcon className="w-4 h-4" />
            {hasRecord ? "核对 / 修改已修" : "填写已修学分，算出毕业缺口"}
            <ArrowRightIcon className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
          </button>
          {!simActive && (
            <button
              type="button"
              onClick={onStartElectives}
              className="w-full inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-xl border border-red-200 bg-white text-red-600 text-sm font-semibold hover:bg-red-50 transition-colors"
            >
              <CartIcon className="w-4 h-4" />
              直接去挑选修课
            </button>
          )}
        </div>
      </div>
    </div>
  ) : (
    // 兜底:选了方案但无毕业要求数据(1154 全覆盖下基本不会发生)。
    <div className="rounded-2xl border border-gray-200 bg-white shadow-sm p-6 text-center">
      <p className="text-[13px] text-gray-500">没找到这个方案的毕业要求数据</p>
      <button type="button" onClick={() => setEditingPlan(true)} className="mt-2 text-[12px] font-medium text-red-500 hover:text-red-600">换个方案</button>
    </div>
  );

  const body = (
    <>
      <div className="text-center">
        <Eyebrow />
        <h2 className={`mt-3.5 font-bold text-gray-800 leading-snug ${compact ? "text-[19px]" : "text-[24px]"}`}>
          这学期，你该选哪些课？
        </h2>
      </div>

      <div className="mt-6">{showSelector ? entry : planPanel}</div>

      <div className="mt-4 text-center">
        <button
          type="button"
          onClick={onShowAll}
          className="text-[12px] font-medium text-gray-400 hover:text-red-600 transition-colors"
        >
          只想随便逛逛？浏览全部课程 →
        </button>
      </div>
    </>
  );

  if (compact) {
    return <div className="rounded-2xl bg-white border border-gray-100 shadow-sm px-5 py-7">{body}</div>;
  }

  // 桌面:渲染在表格白卡内,撑高到与左右侧栏齐平。
  return (
    <div className="flex flex-col justify-center px-8 py-16 min-h-[calc(100vh-220px)]">
      <div className="w-full max-w-md mx-auto">{body}</div>
    </div>
  );
}
