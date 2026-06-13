import { useState, useMemo } from "react";
import type { Course, FormalSection, MajorRequirement, PlanCourse } from "../../types";
import type { CreditPlanView } from "../../lib/creditPlan";
import { REQUIRED_NATURES } from "../../lib/creditPlan";
import { termIndexOf, effectiveTermIndex, termToCalLabel, enrollYear } from "../../lib/term";
import { buildPlacement, previewSemsOf } from "../../lib/schedulePlacement";
import { importStudentRecord, deriveInputsFromRecord, isPassed, type StudentRecord, type ImportSuggestion } from "../../lib/studentRecord";
import { decodeBundle, type PlanBundle } from "../../lib/planShare";
import type { StoredInputs } from "../../hooks/useCreditPlan";
import { STUDENT_IMPORT_ENABLED } from "../../lib/featureFlags";
import { PlanSelector } from "../PlanSelector";
import { CreditRing, CreditRingLegend, FutureRequiredToggle } from "./CreditRing";
import { SimScheduleGrid } from "./SimScheduleGrid";

const JWC_URL =
  "https://jwc.jxnu.edu.cn/MyControl/All_Display.aspx?UserControl=xfz_bysh.ascx&Action=Personal";

interface Props {
  selectedPlan: string;
  allPlans: string[];
  onSelectPlan: (plan: string) => void;
  requirement: MajorRequirement | null;
  view: CreditPlanView;
  planCourses: PlanCourse[];
  cartCourses: Course[];
  formalSections: FormalSection[];
  chosen: Record<string, string>;
  onChooseSection: (cid: string, optionKey: string) => void;
  onRemoveCart: (cid: string) => void;
  term: number;
  totalEarned: number;
  electiveThisSem: number;
  takenMajorElectives: string[];
  excludedRequired: string[];
  setTotalEarned: (v: number) => void;
  setElectiveThisSem: (v: number) => void;
  toggleMajorElective: (cid: string) => void;
  toggleExcludedRequired: (cid: string) => void;
  /** 转专业「已抵」勾选切换（未检测到的前两学期必修）。 */
  toggleTransferOffset: (cid: string) => void;
  /** 已勾「已抵」的 cid 列表。 */
  transferOffsetCids: string[];
  /** 学号导入：一次性写入指定方案的已修信息（避免被方案切换的 loadStored 覆盖）。 */
  importInputs: (plan: string, inputs: Partial<StoredInputs>) => void;
  /** 按 planKey 取方案课程清单（学号导入算「核对必修」自动缺口用）。 */
  coursesOf: (key: string) => PlanCourse[];
  /** 转专业模式开关（前两学期在原专业修读）。 */
  transferMode: boolean;
  originalPlan: string;
  setTransferMode: (v: boolean) => void;
  setOriginalPlan: (v: string) => void;
  /** 原专业前两学期 cid 集合（已通过 hook 兜底，未激活时为空）。 */
  transferEarlyCids: string[];
  /** 显示未来学期必修课开关（核对列表追加 + 环图浅蓝；与面板共享持久化）。 */
  showFutureRequired: boolean;
  setShowFutureRequired: (v: boolean) => void;
  /** 引导模式：是否已浏览过 step 3「勾选已修专业限选」（即使空勾也算完成）。 */
  visitedMajorElective: boolean;
  setVisitedMajorElective: (v: boolean) => void;
  /** 从分享码恢复整套方案（覆盖 plan+已修+待选+选班，并进入 sim）。 */
  onApplyBundle: (bundle: PlanBundle) => void;
  /** 打开时定位到第几步（默认 1）。dock「放大查看课表」传 5 → 直接落到「下学期必修排课表」。 */
  initialStep?: number;
  onCancel: () => void;
  onFinish: () => void;
}

const STEPS = [
  { label: "方案", title: "确认培养方案", hint: "决定课程性质归类与毕业学分要求。" },
  { label: "学分", title: "导入已修学分", hint: "通过学籍预警填上你已经修过的课程的学分。" },
  { label: "限选", title: "勾选已修专业限选", hint: "勾出你已经修过的专业限选课，核算专业限选进度。" },
  { label: "核对", title: "核对必修", hint: "重修/未修可取消勾选；本学期在读必修默认计入。" },
  { label: "课表", title: "下学期必修排课表", hint: "点击单元格可查看详情、换班、退选。" },
];
const TOTAL = STEPS.length;

const TERM_LABEL = (n: number) => `第${n}学期`;

// 从 planKey / className 提取专业名，作为内联方案下拉的预填搜索词（把同专业各变体一次列出）。
function majorHint(planKey?: string, className?: string): string {
  if (planKey) {
    const m = planKey.split("-")[1] || "";
    return m.replace(/（.*?）|\(.*?\)/g, "").trim();
  }
  if (className) {
    return className
      .replace(/^\s*\d{2}级/, "")
      .replace(/\d*班.*$/, "")
      .replace(/（.*?）|\(.*?\)/g, "")
      .trim();
  }
  return "";
}

export function OnboardingModal({
  selectedPlan, allPlans, onSelectPlan, requirement, view, planCourses, cartCourses, formalSections,
  chosen, onChooseSection, onRemoveCart,
  term, totalEarned, electiveThisSem, takenMajorElectives, excludedRequired,
  setTotalEarned, setElectiveThisSem, toggleMajorElective, toggleExcludedRequired, importInputs, coursesOf,
  toggleTransferOffset, transferOffsetCids,
  transferMode, originalPlan, setTransferMode, setOriginalPlan, transferEarlyCids,
  showFutureRequired, setShowFutureRequired,
  visitedMajorElective, setVisitedMajorElective,
  onApplyBundle, onCancel, onFinish, initialStep,
}: Props) {
  // 每次开引导都重新挂载，lazy init 即可读到当次 initialStep；夹到合法步数范围。
  const [step, setStep] = useState(() => Math.min(Math.max(initialStep ?? 1, 1), TOTAL));
  const [dir, setDir] = useState<1 | -1>(1);
  const go = (n: number) => {
    setDir(n >= step ? 1 : -1);
    setStep(n);
    // 进入 step 3 即视为"已浏览专业限选" → 该步骤即使空勾也能打绿✓。
    if (n === 3 && !visitedMajorElective) setVisitedMajorElective(true);
  };

  // 学号一键导入（二级页：标题栏右侧入口打开；接 /api/student-record → D1）。脱敏：仅凭学号。
  const [importOpen, setImportOpen] = useState(false);
  const [importSid, setImportSid] = useState("");
  const [importLoading, setImportLoading] = useState(false);
  const [importErr, setImportErr] = useState<string | null>(null);
  // 拉到的档案 + 派生建议（先预览，确认后才回填引导）。
  const [preview, setPreview] = useState<{ rec: StudentRecord; sug: ImportSuggestion } | null>(null);
  // 方案识别纠错：内联下拉编辑（不跳转、不清空已查数据）。
  const [editingPlan, setEditingPlan] = useState(false);
  // 可编辑覆盖：已修学分 / 本学期已选选修（落地「学籍预警·手动修正」，改后即按此值导入）。
  const [edit, setEdit] = useState<{ totalEarned: number; electiveThisSem: number } | null>(null);
  // 导入页内的转专业暂存（apply 时随 importInputs 一起写入；抵扣计算在进入引导后由 useCreditPlan 处理）。
  const [editTransfer, setEditTransfer] = useState(false);
  const [editOriginalPlan, setEditOriginalPlan] = useState("");

  // 第1步「从分享码开始」：粘贴码 → 解码 → 恢复整套方案。
  const [shareOpen, setShareOpen] = useState(false);
  const [shareCode, setShareCode] = useState("");
  const [shareErr, setShareErr] = useState<string | null>(null);
  const [copiedCid, setCopiedCid] = useState<string | null>(null);
  const handleCopyCid = async (cid: string) => {
    try {
      await navigator.clipboard.writeText(cid);
      setCopiedCid(cid);
      setTimeout(() => setCopiedCid((cur) => (cur === cid ? null : cur)), 1200);
    } catch {}
  };
  const handleStartFromShare = async () => {
    setShareErr(null);
    const b = await decodeBundle(shareCode.trim());
    if (!b) {
      setShareErr("分享码无效或已损坏。");
      return;
    }
    onApplyBundle(b); // 覆盖 plan+已修+待选+选班 并进入 sim
  };

  const handleImport = async () => {
    setImportErr(null);
    setPreview(null);
    setEdit(null);
    setEditTransfer(false);
    setEditOriginalPlan("");
    setEditingPlan(false);
    setImportLoading(true);
    try {
      const rec = await importStudentRecord(importSid);
      const matched = !!(rec.planKey && allPlans.includes(rec.planKey));
      const plan = matched ? rec.planKey! : selectedPlan;
      const sug = deriveInputsFromRecord(rec, plan ? coursesOf(plan) : undefined);
      setPreview({ rec, sug });
      setEdit({ totalEarned: sug.totalEarned, electiveThisSem: sug.electiveThisSem });
    } catch (e) {
      setImportErr((e as Error).message);
    } finally {
      setImportLoading(false);
    }
  };

  // 应用预览：一次性回填引导各项（方案/在读学期/已修学分/本学期选修/已修限选/核对必修缺口）。
  // 关键：用 importInputs 直接写【目标方案】的 stored，再 onSelectPlan 切过去 —— 切换后
  //   loadStored 正好读到刚写的值。若先用 setTotalEarned 等再切方案，会被 loadStored 覆盖（学分丢失）。
  // 核对必修按流程图自动缺口：deriveInputsFromRecord 把「方案要求但档案未修」的必修标缺口（取消勾选），
  //   但跳过延迟结算课（形势与政策等不进课表的必修），并用大学英语特色课 1:1 顶替缺失的大英Ⅲ/Ⅳ。
  //   往期快照偶有缺漏可能误判，用户可回核对页手动补勾。
  const handleApplyImport = () => {
    if (!preview) return;
    const { rec, sug } = preview;
    const matched = !!(rec.planKey && allPlans.includes(rec.planKey));
    const plan = matched ? rec.planKey! : selectedPlan;
    if (plan) {
      importInputs(plan, {
        totalEarned: edit?.totalEarned ?? sug.totalEarned,
        electiveThisSem: edit?.electiveThisSem ?? sug.electiveThisSem,
        term: sug.term ?? null,
        takenMajorElectives: sug.takenMajorElectiveCids,
        transferMode: editTransfer,
        originalPlan: editTransfer ? editOriginalPlan : "",
        // 核对必修自动缺口（deriveInputsFromRecord 已含特色课抵扣逻辑）。
        excludedRequired: sug.excludedRequiredCids,
        // 学号导入的真实已修 cid（仅 isPassed）→ 驱动「隐藏已修课程」用真实档案。
        importedTakenCids: rec.detailCourses
          .filter((c) => isPassed(c) && !!c.courseId)
          .map((c) => c.courseId),
      });
    }
    if (matched) onSelectPlan(rec.planKey!);
    setImportOpen(false);
    setEditingPlan(false);
    // 导入完成 → 落到「核对必修」页，让用户复核自动勾选/缺口结果。
    go(4);
  };

  // 方案识别纠错（内联）：只更新预览里的 planKey（→ 决定毕业要求/学分映射），保留已查课表数据。
  const handleFixPlan = (key: string) => {
    setPreview((p) => (p ? { ...p, rec: { ...p.rec, planKey: key || undefined } } : p));
    setEditingPlan(false);
  };

  // 一键清空引导填写的全部信息：重置当前方案的已修记录 + 清空方案选择 + 清空导入预览。
  const handleClearAll = () => {
    if (!window.confirm("清空本次引导填写的所有信息（培养方案、在读学期、已修学分、已修限选、核对必修）？")) return;
    if (selectedPlan) importInputs(selectedPlan, {});
    onSelectPlan("");
    setPreview(null);
    setEdit(null);
    setEditTransfer(false);
    setEditOriginalPlan("");
    setImportSid("");
    setEditingPlan(false);
    setImportErr(null);
  };

  const takenSet = useMemo(() => new Set(takenMajorElectives), [takenMajorElectives]);
  const excludedSet = useMemo(() => new Set(excludedRequired), [excludedRequired]);
  const transferEarlySet = useMemo(() => new Set(transferEarlyCids), [transferEarlyCids]);
  const transferOffsetSet = useMemo(() => new Set(transferOffsetCids), [transferOffsetCids]);
  // 原专业候选 = 所有 plan - 当前转入专业。
  const otherPlans = useMemo(() => allPlans.filter((p) => p !== selectedPlan), [allPlans, selectedPlan]);
  // 已匹配课程数：遍历转入专业 planCourses，命中原专业前两学期 cid 集合的课程数。
  const transferMatchedCount = useMemo(() => {
    if (!transferMode || transferEarlySet.size === 0) return 0;
    let n = 0;
    for (const c of planCourses) if (transferEarlySet.has(c.cid)) n++;
    return n;
  }, [transferMode, transferEarlySet, planCourses]);

  // 第6步周课表落格（与面板共用 lib/schedulePlacement）。规划学期 = 在读 term 的下学期。
  const planTerm = term + 1;
  const planLabel = useMemo(() => termToCalLabel(enrollYear(selectedPlan), planTerm), [selectedPlan, planTerm]);
  const placed = useMemo(
    () => buildPlacement(view.nextSemRequired, cartCourses, formalSections, planLabel, chosen, selectedPlan),
    [view.nextSemRequired, cartCourses, formalSections, planLabel, chosen, selectedPlan],
  );
  const previewSems = useMemo(() => previewSemsOf(placed, planLabel), [placed, planLabel]);

  // 专业限选课（plan_courses 已按 cid 去重）。
  const majorElectiveCourses = useMemo(
    () =>
      planCourses
        .filter((c) => c.nature === "专业限选")
        .sort((a, b) => termIndexOf(a.semester) - termIndexOf(b.semester) || a.name.localeCompare(b.name)),
    [planCourses],
  );
  const takenMajorElectiveCredits = useMemo(
    () =>
      majorElectiveCourses
        .filter((c) => takenSet.has(c.cid) || (transferMode && termIndexOf(c.semester) <= 2 && transferEarlySet.has(c.cid)))
        .reduce((s, c) => s + c.credits, 0),
    [majorElectiveCourses, takenSet, transferMode, transferEarlySet],
  );

  // 核对必修：必修性质 + 开课时间 ≤ 在读第term学期。
  //   ti ≤ term-1 = 非本学期必修（已通过，重修/未修可取消）；ti == term = 本学期在读（未考试·仅理论，默认计入，可取消）。
  //   延迟结算课（形势与政策）按结算学期算 —— 第7学期前落入未来必修（下方未来列表），不出现在「已修核对」里。
  const autoRequiredCourses = useMemo(
    () =>
      planCourses
        .filter((c) => REQUIRED_NATURES.includes(c.nature))
        .filter((c) => {
          const ti = effectiveTermIndex(c.cid, c.semester);
          return ti > 0 && ti <= term;
        })
        .sort(
          (a, b) =>
            effectiveTermIndex(a.cid, a.semester) - effectiveTermIndex(b.cid, b.semester) ||
            a.name.localeCompare(b.name),
        ),
    [planCourses, term],
  );

  const noPlanData = selectedPlan !== "" && planCourses.length === 0;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-gray-900/50 backdrop-blur-[1px] px-4 py-6">
      <div className="relative w-full max-w-[960px] min-h-[640px] max-h-[92vh] bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden flex flex-col">
        <div className="h-1 bg-gradient-to-r from-red-500 via-red-400 to-red-500 shrink-0" />

        {/* 标题 */}
        <div className="px-4 sm:px-7 pt-5 pb-2 flex items-start justify-between gap-3 shrink-0">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] font-bold text-red-600 bg-red-50 px-2 py-0.5 rounded-md border border-red-200">
                第 {step} 步 / 共 {TOTAL} 步
              </span>
              {STUDENT_IMPORT_ENABLED && (
                <button
                  type="button"
                  onClick={() => { setImportOpen(true); setImportErr(null); }}
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-md border border-indigo-200 hover:bg-indigo-100 transition-colors"
                >
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16" />
                  </svg>
                  输入学号一键导入
                </button>
              )}
              <button
                type="button"
                onClick={handleClearAll}
                title="清空所有"
                className="inline-flex items-center gap-1 text-[11px] font-bold text-gray-500 bg-gray-100 px-2 py-0.5 rounded-md border border-gray-200 hover:bg-gray-200 hover:text-rose-600 transition-colors"
              >
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2m2 0v14a1 1 0 01-1 1H6a1 1 0 01-1-1V6h14zM10 11v6M14 11v6" />
                </svg>
                清空所有
              </button>
            </div>
            <h2 className="text-lg sm:text-xl font-black text-gray-900 leading-tight mt-2">{STEPS[step - 1].title}</h2>
            <p className="text-[12px] text-gray-500 mt-1">{STEPS[step - 1].hint}</p>
          </div>
          <button
            onClick={onCancel}
            aria-label="关闭"
            className="w-7 h-7 rounded-lg text-gray-300 hover:text-gray-700 hover:bg-gray-100 inline-flex items-center justify-center shrink-0"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" d="M6 6l12 12M6 18L18 6" />
            </svg>
          </button>
        </div>

        {/* 步骤指示：手机 3 列(2 行) / 桌面 6 列(1 行)，避免溢出裁切 */}
        {/* 值检测：选中=红高亮；非选中但已有有效值=绿✓；无值=灰待填（不再按"走到第几步"判断）。
            特殊态：step 4 在「重修超限警告」（prevReqRaw>totalEarned）下永远显示黄色 warning（含 active 时叠加 ring）—— 提示用户去处理。
            限选(step 3)：方案 minMajorElective=0 时 或 用户已浏览过该步骤 也算打勾（留空设计），用户无需勾任何课。 */}
        <div className="px-4 sm:px-7 mt-2 grid grid-cols-3 sm:grid-cols-5 gap-1.5 shrink-0">
          {STEPS.map((s, i) => {
            const n = i + 1;
            const noMajorElective = (requirement?.minMajorElective ?? 0) === 0;
            const filled = [
              !!selectedPlan,                                                   // 1 方案
              totalEarned > 0 || electiveThisSem > 0,                           // 2 已修学分
              takenMajorElectives.length > 0 || visitedMajorElective || (!!selectedPlan && noMajorElective), // 3 限选（已勾 / 已浏览 / 0 分要求 任一即打勾）
              !!selectedPlan,                                                   // 4 核对必修
              !!selectedPlan,                                                   // 5 课表
            ][i];
            const isWarning = n === 4 && view.prevReqRaw > totalEarned && totalEarned > 0;
            const isActive = step === n;
            // warning 总是叠加；active+warning 时保留 ring 强调。
            const state = isWarning ? (isActive ? "warning-active" : "warning") : isActive ? "active" : filled ? "done" : "todo";
            const cls =
              state === "warning-active"
                ? "bg-amber-50 border-amber-300 text-amber-700 ring-2 ring-amber-100"
                : state === "warning"
                ? "bg-amber-50 border-amber-200 text-amber-700"
                : state === "done"
                ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                : state === "active"
                ? "bg-red-50 border-red-300 text-red-700 ring-2 ring-red-100"
                : "bg-white border-gray-200 text-gray-400";
            const numCls =
              state === "warning-active" || state === "warning"
                ? "bg-amber-500 text-white"
                : state === "done"
                ? "bg-emerald-500 text-white"
                : state === "active"
                ? "bg-red-500 text-white"
                : "bg-gray-200 text-gray-500";
            return (
              <button
                key={s.label}
                onClick={() => go(n)}
                className={`flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-xl border transition-colors ${cls}`}
              >
                <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-black shrink-0 ${numCls}`}>
                  {state === "warning-active" || state === "warning" ? (
                    // 感叹号：1px 圆点 + 竖线，黄底白字。
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 8v5" />
                      <circle cx="12" cy="17" r="0.6" fill="currentColor" />
                    </svg>
                  ) : state === "done" ? (
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    n
                  )}
                </span>
                <span className="text-[11px] font-bold leading-tight truncate">{s.label}</span>
              </button>
            );
          })}
        </div>

        {/* 内容 */}
        <div className="px-4 sm:px-7 mt-4 pb-2 flex-1 min-h-0 overflow-y-auto">
          <div key={step} className={dir > 0 ? "onb-in-right" : "onb-in-left"}>
          {/* Step 1 — 培养方案 */}
          {step === 1 && (
            <div className="min-h-[320px]">
              <label className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-2 block">培养方案（年级·专业）</label>
              <PlanSelector value={selectedPlan} onChange={onSelectPlan} options={allPlans} />
              {requirement ? (
                <div className="mt-3 rounded-xl bg-indigo-50/50 border border-indigo-100 p-3 text-[12px] text-indigo-700">
                  已识别：<span className="font-semibold">{selectedPlan}</span> · 毕业最低 {requirement.minTotal} 学分
                  {requirement.minMajorElective > 0 && <> · 专业限选 ≥ {requirement.minMajorElective}</>}
                </div>
              ) : selectedPlan ? (
                <div className="mt-3 rounded-xl bg-amber-50 border border-amber-200 p-3 text-[12px] text-amber-700">
                  未在培养方案库中找到该年级·专业的学分要求，将只做累计统计。
                </div>
              ) : (
                <p className="mt-3 text-[12px] text-gray-400">输入年级或专业名搜索，例如「2025 计算机」。也可稍后在左栏随时切换。</p>
              )}

              {/* 转专业开关：开启后展开原专业选择器 */}
              <div className="mt-4 pt-4 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setTransferMode(!transferMode)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left transition-colors ${
                    transferMode ? "bg-amber-50 border-amber-200" : "bg-white border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                    transferMode ? "bg-amber-500 border-amber-500 text-white" : "border-gray-300"
                  }`}>
                    {transferMode && (
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </span>
                  <span className="flex-1 text-[13px] text-gray-800">转专业</span>
                </button>
                {transferMode && (
                  <div className="mt-2.5">
                    <label className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5 block">原专业（年级·专业）</label>
                    <PlanSelector value={originalPlan} onChange={setOriginalPlan} options={otherPlans} />
                    {!originalPlan ? (
                      <p className="mt-2 text-[11px] text-gray-400 leading-relaxed">
                        选择你<strong className="text-gray-600">入学时</strong>的原专业。
                      </p>
                    ) : originalPlan === selectedPlan ? (
                      <p className="mt-2 text-[11px] text-amber-600">原专业与转入专业相同，转专业逻辑未生效。</p>
                    ) : transferEarlySet.size === 0 ? (
                      <p className="mt-2 text-[11px] text-gray-400">原专业课程清单加载中或暂无前两学期数据。</p>
                    ) : (
                      <p className="mt-2 text-[11px] text-amber-700">
                        已识别原专业前两学期 <strong>{transferEarlySet.size}</strong> 门课，其中 <strong>{transferMatchedCount}</strong> 门与转入专业同课程号，可互相抵消。
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* 从分享码开始：粘贴码即恢复整套方案并进入模拟（次要入口） */}
              <div className="mt-4 pt-4 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setShareOpen((v) => !v)}
                  className="inline-flex items-center gap-1 text-[12px] text-gray-500 hover:text-gray-800"
                >
                  <svg className={`w-3.5 h-3.5 transition-transform ${shareOpen ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
                  </svg>
                  从分享码开始
                </button>
                {shareOpen && (
                  <div className="mt-2 space-y-2">
                    <textarea
                      value={shareCode}
                      onChange={(e) => { setShareCode(e.target.value); setShareErr(null); }}
                      placeholder="粘贴 v1z: 或 v1: 开头的分享码"
                      className="w-full h-16 px-2 py-1.5 rounded-lg border border-gray-200 bg-white text-[11px] font-mono leading-relaxed resize-none outline-none focus:border-red-300"
                    />
                    {shareErr && <p className="text-[11px] text-rose-600">{shareErr}</p>}
                    <button
                      type="button"
                      onClick={handleStartFromShare}
                      disabled={!shareCode.trim()}
                      className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-[12px] font-bold hover:bg-red-600 disabled:bg-gray-200 disabled:text-gray-400"
                    >
                      恢复并进入模拟
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 2 — 已修学分 */}
          {step === 2 && (
            <div className="min-h-[320px] space-y-4">
              <div>
                <label className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5 block">当前所修学分总数（不含本学期）</label>
                <input
                  type="number" min={0}
                  value={totalEarned || ""}
                  onChange={(e) => setTotalEarned(Number(e.target.value) || 0)}
                  placeholder="例如 86"
                  className="w-40 px-3 py-2 rounded-xl border border-gray-200 bg-gray-50 text-sm font-medium outline-none focus:bg-white focus:border-red-300"
                />
                <p className="mt-1.5 text-[11px] text-gray-400 leading-relaxed">
                    到 <a href={JWC_URL} target="_blank" rel="noopener noreferrer" className="text-red-500 hover:underline">学籍预警</a> 查看<strong className="text-gray-500">“当前所修学分总数”</strong>后填写。
                </p>
              </div>
              <div>
                <label className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5 block">本学期（在读）已选选修学分（可留空）</label>
                <input
                  type="number" min={0}
                  value={electiveThisSem || ""}
                  onChange={(e) => setElectiveThisSem(Number(e.target.value) || 0)}
                  placeholder="0"
                  className="w-40 px-3 py-2 rounded-xl border border-gray-200 bg-gray-50 text-sm font-medium outline-none focus:bg-white focus:border-red-300"
                />
                  <p className="mt-1.5 text-[11px] text-gray-400">请手算<strong className="text-gray-500">本学期在读的选修课学分</strong>填写到此框。</p>
              </div>
            </div>
          )}

          {/* Step 3 — 已修专业限选 */}
          {step === 3 && (
            <div className="min-h-[320px]">
              {requirement && (
                <div className="flex items-center justify-between mb-2 px-3 py-2 rounded-xl bg-indigo-50/50 border border-indigo-100 text-[12px]">
                  <span className="text-indigo-700">专业限选已勾</span>
                  <span className="font-mono font-bold text-indigo-700">
                    {takenMajorElectiveCredits} / {requirement.minMajorElective} 学分
                  </span>
                </div>
              )}
              <p className="mb-2 text-[11px] text-gray-400 leading-relaxed">
                培养方案的限选学分要求并不一定为毕业要求，详情请咨询当前学院教务处。
              </p>
              {majorElectiveCourses.length === 0 ? (
                <div className="text-[12px] text-gray-400 py-10 text-center">
                  {noPlanData ? "该方案暂无课程清单数据，可直接跳过。" : "该方案没有专业限选课程。"}
                </div>
              ) : (
                <div className="space-y-1">
                  {majorElectiveCourses.map((c) => {
                    const isTransferAuto =
                      transferMode && termIndexOf(c.semester) <= 2 && transferEarlySet.has(c.cid);
                    const checked = takenSet.has(c.cid) || isTransferAuto;
                    return (
                      <button
                        key={c.cid}
                        onClick={isTransferAuto ? undefined : () => toggleMajorElective(c.cid)}
                        disabled={isTransferAuto}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left transition-colors ${
                          isTransferAuto
                            ? "bg-amber-50 border-amber-200 cursor-not-allowed"
                            : checked
                            ? "bg-indigo-50 border-indigo-200"
                            : "bg-white border-gray-100 hover:border-gray-200"
                        }`}
                      >
                        <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                          isTransferAuto
                            ? "bg-amber-500 border-amber-500 text-white"
                            : checked
                            ? "bg-indigo-500 border-indigo-500 text-white"
                            : "border-gray-300"
                        }`}>
                          {checked && <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                        </span>
                        <span className="min-w-0 text-[13px] text-gray-800 truncate">{c.name}</span>
                        <span className="flex items-center gap-1 shrink-0">
                          <span className="text-[11px] text-gray-400 font-mono">{c.cid}</span>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleCopyCid(c.cid); }}
                            title="复制课程号"
                            className={`inline-flex items-center justify-center w-4 h-4 rounded transition-colors ${
                              copiedCid === c.cid ? "text-green-500" : "text-gray-300 hover:text-gray-600"
                            }`}
                          >
                            {copiedCid === c.cid ? (
                              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                            ) : (
                              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                            )}
                          </button>
                        </span>
                        <span className="flex-1" />
                        {isTransferAuto && (
                          <span className="text-[9px] font-semibold text-amber-700 bg-amber-100 rounded px-1 py-0.5 shrink-0">转专业·原专业已修</span>
                        )}
                        <span className="text-[10px] text-gray-400 font-mono shrink-0">{c.semester}</span>
                        <span className="text-[11px] font-bold text-gray-600 shrink-0">{c.credits}分</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Step 4 — 核对必修 + 环图 */}
          {step === 4 && (
            <div className="min-h-[320px] grid sm:grid-cols-[180px_1fr] gap-5">
              <div className="flex flex-col items-center">
                <CreditRing view={view} size={130} stroke={13} />
                <CreditRingLegend className="mt-2.5" showFuture={showFutureRequired} />
                <div className="mt-3 w-full space-y-1.5 text-[12px]">
                  {view.blocks.map((b) => (
                    <div key={b.key}>
                      <div className="flex items-center gap-1.5">
                        <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ background: b.color }} />
                        <span className="text-gray-600 flex-1 truncate">{b.label}</span>
                        <span className="font-mono text-gray-800">
                          {b.earned}{b.planned > 0 && <span style={{ color: b.color }}>+{b.planned}</span>} / {b.required ?? "?"}
                        </span>
                      </div>
                      {b.subTarget && b.subTarget.required > 0 && (
                        <>
                          <div className="flex items-center gap-1.5 pl-3 mt-0.5 text-[11px]">
                            <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ background: b.subTarget.color }} />
                            <span className="text-gray-400 flex-1 truncate">其中{b.subTarget.label}</span>
                            <span className="font-mono text-gray-500">{b.subTarget.earned} / {b.subTarget.required}</span>
                          </div>
                          <p className="pl-3 mt-0.5 text-[10px] text-gray-400 leading-relaxed">
                            培养方案的限选学分要求并不一定为毕业要求，详情请咨询当前学院教务处。
                          </p>
                        </>
                      )}
                    </div>
                  ))}
                  <div className="pt-1.5 border-t border-gray-100 flex items-baseline justify-between">
                    <span className="text-gray-500 text-[13px] font-semibold">毕业还差</span>
                    <span className="font-black text-gray-800 text-[22px] leading-none">{view.totalRemaining ?? "?"}<span className="text-[12px] text-gray-400 font-medium"> 分</span></span>
                  </div>
                </div>
              </div>
              <div className="min-w-0">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
                    取消勾选 = 重修 / 未修 / 预计无法通过
                  </div>
                  <FutureRequiredToggle checked={showFutureRequired} onChange={setShowFutureRequired} />
                </div>
                {/* 重修超限警告：按方案推断的「应已修必修」总学分 > 用户填的「已修学分总数」。
                    典型场景：学生重修很多课程（实际学分 60，但按方案算 80）。
                    此时已修必修会被 effectivePrevReq=min(prevReqRaw, totalEarned) 截到 totalEarned，
                    UI 上看似一致，实际隐藏了「重修学分缺口」。强制提醒用户取消重修课程，或回到第 2 步修正已修学分。 */}
                {view.prevReqRaw > totalEarned && totalEarned > 0 && (
                  <div className="text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-2 mb-2 leading-relaxed">
                    <div className="flex items-start gap-1.5">
                      <svg className="w-3.5 h-3.5 shrink-0 mt-px text-rose-500" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                        <path fillRule="evenodd" clipRule="evenodd" d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 0 1 .75.75v3.75a.75.75 0 0 1-1.5 0V9a.75.75 0 0 1 .75-.75zm0 8.25a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5z" />
                      </svg>
                      <div className="flex-1">
                        <div className="font-bold">已修必修学分（<span className="font-mono">{view.prevReqRaw}</span>）超过你填的已修总学分（<span className="font-mono">{totalEarned}</span>）</div>
                        <div className="mt-0.5">差 <span className="font-bold">{view.prevReqRaw - totalEarned}</span> 分。原因通常是<strong>重修 / 未通过</strong>。请下方取消相应必修课的勾选，或回第 2 步修正已修学分。</div>
                      </div>
                    </div>
                  </div>
                )}
                {transferMode && (
                  <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mb-2 leading-relaxed">
                    转专业的学分认证系统十分复杂，此图表仅供参考，具体请咨询当前学院教务处。
                  </p>
                )}
                <div className="space-y-1 max-h-[380px] overflow-y-auto pr-1">
                  {autoRequiredCourses.length === 0 ? (
                    <div className="text-[12px] text-gray-400 py-8 text-center">
                      {noPlanData ? "该方案暂无课程清单数据。" : "前面没有应已修的必修课（或学期填得较早）。"}
                    </div>
                  ) : (
                    autoRequiredCourses.map((c) => {
                      const ti = effectiveTermIndex(c.cid, c.semester);
                      const isReading = ti === term;
                      // 转专业前两学期必修：
                      //   matched (transferEarlySet.has)   → 原专业同 cid 自动已抵，正常已修(蓝) + 「已抵」徽章。
                      //   unmatched (未检测到)             → 默认缺口·不计学分；勾「已抵」(transferOffsetCids) 才计入。
                      //                                      无开课学期限制、不自动排课，要上自行加入待选。
                      const isTransferEarly = transferMode && ti > 0 && ti <= 2;
                      const isMatched = isTransferEarly && transferEarlySet.has(c.cid);
                      const isUnmatched = isTransferEarly && !transferEarlySet.has(c.cid);
                      // unmatched 用「已抵」勾选（默认未勾=缺口）；其余用「排除」勾选（默认计入）。
                      const offsetChecked = transferOffsetSet.has(c.cid);
                      const active = isUnmatched ? offsetChecked : !excludedSet.has(c.cid);
                      const onClick = isUnmatched
                        ? () => toggleTransferOffset(c.cid)
                        : () => toggleExcludedRequired(c.cid);
                      const tip = isUnmatched
                        ? "转专业·原专业没有同名课（未检测到）。若你已从其他课程抵掉这门课的学分，勾选「已抵」计入；否则保留为缺口（不计学分），需补修的自行加入待选。"
                        : undefined;
                      const boxCls = isUnmatched
                        ? active
                          ? "bg-amber-50 border-amber-200"
                          : "bg-white border-amber-200 border-dashed"
                        : active
                        ? isReading
                          ? "bg-sky-50/60 border-sky-100"
                          : "bg-blue-50/60 border-blue-100"
                        : "bg-gray-50 border-gray-100 opacity-60";
                      const tickCls = isUnmatched
                        ? active
                          ? "bg-amber-500 border-amber-500 text-white"
                          : "border-amber-300"
                        : active
                        ? isReading ? "bg-sky-400 border-sky-400 text-white" : "bg-blue-500 border-blue-500 text-white"
                        : "border-gray-300";
                      const nameCls = isUnmatched
                        ? active ? "text-gray-800" : "text-gray-700"
                        : active ? "text-gray-800" : "text-gray-400 line-through";
                      return (
                        <button
                          key={c.cid}
                          onClick={onClick}
                          title={tip}
                          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left transition-colors ${boxCls}`}
                        >
                          <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${tickCls}`}>
                            {active && <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                          </span>
                          <span className={`min-w-0 text-[13px] truncate ${nameCls}`}>{c.name}</span>
                          <span className="flex items-center gap-1 shrink-0">
                            <span className="text-[11px] text-gray-400 font-mono">{c.cid}</span>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); handleCopyCid(c.cid); }}
                              title="复制课程号"
                              className={`inline-flex items-center justify-center w-4 h-4 rounded transition-colors ${
                                copiedCid === c.cid ? "text-green-500" : "text-gray-300 hover:text-gray-600"
                              }`}
                            >
                              {copiedCid === c.cid ? (
                                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                              ) : (
                                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                              )}
                            </button>
                          </span>
                          {/* 大学英语Ⅲ/Ⅳ：可用「大学英语特色课」1:1 抵扣 —— 显式说明 */}
                          {/大学英语/.test(c.name) && /(Ⅲ|Ⅳ|III|IV|三|四)/.test(c.name) && (
                            <span className="text-[10px] text-indigo-500 shrink-0" title="一门大学英语特色课可 1:1 抵扣一门大学英语Ⅲ/Ⅳ">（或大学英语特色课）</span>
                          )}
                          <span className="flex-1" />
                          {isUnmatched && (
                            <span className={`text-[9px] font-semibold rounded px-1 py-0.5 shrink-0 ${
                              active ? "text-amber-700 bg-amber-100" : "text-amber-700 bg-amber-50 border border-amber-200"
                            }`}>
                              {active ? "转专业·已抵" : "转专业·缺口（勾选=已学分认证）"}
                            </span>
                          )}
                          {isMatched && (
                            <span className="text-[9px] font-semibold text-amber-700 bg-amber-100 rounded px-1 py-0.5 shrink-0">转专业·已学分认证</span>
                          )}
                          {isReading && !isTransferEarly && (
                            <span className="text-[9px] font-semibold text-sky-600 bg-sky-100 rounded px-1 py-0.5 shrink-0">本学期·仅理论</span>
                          )}
                          <span className="text-[10px] text-gray-400 font-mono shrink-0">{c.semester}</span>
                          <span className="text-[11px] font-bold text-gray-600 shrink-0">{c.credits}分</span>
                        </button>
                      );
                    })
                  )}
                  {showFutureRequired && view.nextSemRequired.length > 0 && (
                    <>
                      <div className="mt-3 mb-1 flex items-center gap-1.5 text-[11px] font-bold text-sky-600">
                        <span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#E0F2FE] border border-sky-200" />
                        下学期 · 仅规划展示（不计入待选清单）
                      </div>
                      {view.nextSemRequired.map((c) => (
                        <div
                          key={c.cid}
                          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border bg-sky-50/60 border-sky-100 text-left"
                        >
                          <span className="w-4 h-4 rounded border flex items-center justify-center shrink-0 bg-sky-300 border-sky-300 text-white">
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                          </span>
                          <span className="min-w-0 text-[13px] truncate text-gray-800">{c.name}</span>
                          <span className="flex items-center gap-1 shrink-0">
                            <span className="text-[11px] text-gray-400 font-mono">{c.cid}</span>
                            <button
                              type="button"
                              onClick={() => handleCopyCid(c.cid)}
                              title="复制课程号"
                              className={`inline-flex items-center justify-center w-4 h-4 rounded transition-colors ${
                                copiedCid === c.cid ? "text-green-500" : "text-gray-300 hover:text-gray-600"
                              }`}
                            >
                              {copiedCid === c.cid ? (
                                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                              ) : (
                                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                              )}
                            </button>
                          </span>
                          <span className="flex-1" />
                          <span className="text-[9px] font-semibold text-sky-700 bg-sky-100 rounded px-1 py-0.5 shrink-0">下学期·仅规划</span>
                          <span className="text-[10px] text-gray-400 font-mono shrink-0">{c.semester}</span>
                          <span className="text-[11px] font-bold text-gray-600 shrink-0">{c.credits}分</span>
                        </div>
                      ))}
                    </>
                  )}
                  {showFutureRequired && view.futureSemRequired.length > 0 && (
                    <>
                      <div className="mt-3 mb-1 flex items-center gap-1.5 text-[11px] font-bold text-sky-600">
                        <span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#E0F2FE] border border-sky-200" />
                        未来学期 · 仅规划展示（不计入待选清单）
                      </div>
                      {view.futureSemRequired.map((c) => {
                        const active = !excludedSet.has(c.cid);
                        return (
                          <button
                            key={c.cid}
                            onClick={() => toggleExcludedRequired(c.cid)}
                            title="未来学期必修课，仅做毕业规划展示；取消勾选 = 预计重修/不修（不计入浅蓝进度）"
                            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left transition-colors ${active ? "bg-sky-50/60 border-sky-100" : "bg-gray-50 border-gray-100 opacity-60"}`}
                          >
                            <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${active ? "bg-sky-300 border-sky-300 text-white" : "border-gray-300"}`}>
                              {active && <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                            </span>
                            <span className={`min-w-0 text-[13px] truncate ${active ? "text-gray-800" : "text-gray-400 line-through"}`}>{c.name}</span>
                            <span className="flex items-center gap-1 shrink-0">
                              <span className="text-[11px] text-gray-400 font-mono">{c.cid}</span>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); handleCopyCid(c.cid); }}
                                title="复制课程号"
                                className={`inline-flex items-center justify-center w-4 h-4 rounded transition-colors ${
                                  copiedCid === c.cid ? "text-green-500" : "text-gray-300 hover:text-gray-600"
                                }`}
                              >
                                {copiedCid === c.cid ? (
                                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                                ) : (
                                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                                )}
                              </button>
                            </span>
                            <span className="flex-1" />
                            <span className="text-[9px] font-semibold text-sky-700 bg-sky-100 rounded px-1 py-0.5 shrink-0">未来</span>
                            <span className="text-[10px] text-gray-400 font-mono shrink-0">{c.semester}</span>
                            <span className="text-[11px] font-bold text-gray-600 shrink-0">{c.credits}分</span>
                          </button>
                        );
                      })}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Step 5 — 下学期必修排课表 */}
          {step === 5 && (
            <div className="min-h-[320px]">
              <div className="text-[11px] text-gray-400 mb-2">
                规划学期：<span className="font-semibold text-gray-600">{planLabel || "—"}</span>
                <span className="ml-1">（{planLabel ? TERM_LABEL(planTerm) : "第 — 学期"}）</span>
              </div>
              {previewSems.length > 0 && (
                <div className="mb-2 px-2.5 py-1.5 rounded-lg bg-amber-50 border border-amber-200 text-[10px] text-amber-700 leading-relaxed">
                  部分课程时段取自最近开课数据（{previewSems.join("、")}），规划学期开课安排发布后会自动更新，仅供参考。
                </div>
              )}
              <SimScheduleGrid
                placed={placed}
                onChooseSection={onChooseSection}
                onCancelRequired={(cid) => toggleExcludedRequired(cid)}
                onRemoveCart={onRemoveCart}
              />
            </div>
          )}
          </div>
        </div>

        {/* footer */}
        <div className="mt-2 px-4 sm:px-7 py-4 border-t border-gray-100 bg-gray-50/50 flex items-center justify-between gap-2 shrink-0">
          <button
            onClick={() => (step > 1 ? go(step - 1) : onCancel())}
            className="text-[12px] text-gray-500 hover:text-gray-800 font-medium"
          >
            {step > 1 ? "← 上一步" : "取消"}
          </button>
          <div className="flex items-center gap-2">
            {step < TOTAL && (
              <button onClick={onFinish} className="text-[12px] px-3 py-2 rounded-lg text-gray-500 hover:bg-gray-100">
                跳过 · 直接进入
              </button>
            )}
            <button
              onClick={() => (step < TOTAL ? go(step + 1) : onFinish())}
              className="text-[13px] font-bold inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-red-500 text-white shadow-sm shadow-red-200 hover:bg-red-600"
            >
              {step === TOTAL ? "完成 · 开始模拟选课" : "下一步 →"}
            </button>
          </div>
        </div>

        {/* 学号一键导入二级页（覆盖在引导之上，不打乱引导布局） */}
        {importOpen && (
          <div className="absolute inset-0 z-10 bg-white flex flex-col">
            <div className="px-4 sm:px-7 pt-5 pb-3 flex items-start justify-between gap-3 border-b border-gray-100 shrink-0">
              <div>
                <span className="text-[11px] font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-md border border-indigo-200">
                  输入学号一键导入
                </span>
                <h2 className="text-lg font-black text-gray-900 leading-tight mt-2">从历史课表自动填写</h2>
                <p className="text-[12px] text-gray-500 mt-1">一键自动导入</p>
              </div>
              <button
                onClick={() => setImportOpen(false)}
                aria-label="返回"
                title="返回引导"
                className="shrink-0 inline-flex items-center gap-1 px-2.5 h-8 rounded-lg text-gray-500 hover:text-gray-800 hover:bg-gray-100 text-[12px] font-medium transition-colors"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6" />
                </svg>
                返回
              </button>
            </div>

            <div className="px-4 sm:px-7 py-4 flex-1 min-h-0 overflow-y-auto">
              {/* 输入行：仅学号 + 查询（脱敏，不收集姓名） */}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  value={importSid}
                  onChange={(e) => setImportSid(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && importSid.trim()) handleImport(); }}
                  placeholder="输入学号"
                  className="flex-1 min-w-[160px] px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 text-sm outline-none focus:bg-white focus:border-indigo-300"
                />
                <button
                  type="button"
                  onClick={handleImport}
                  disabled={importLoading || !importSid.trim()}
                  className="shrink-0 px-4 py-2 rounded-lg bg-indigo-500 text-white text-[13px] font-bold hover:bg-indigo-600 disabled:bg-gray-200 disabled:text-gray-400"
                >
                  {importLoading ? "查询中…" : "查询"}
                </button>
              </div>
              {importErr && <p className="mt-2 text-[12px] text-rose-600">{importErr}</p>}
              <p className="mt-2 text-[11px] text-gray-400 leading-relaxed">
                数据源无成绩，已修课程一律按「已通过」估算。
                若有识别错误或重修课程请前往第「核对」项手动调整。
              </p>

              {/* 预览区 */}
              {preview && (
                <div className="mt-4 space-y-3">
                  <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-3">
                    <div className="text-[13px] font-bold text-gray-800">
                      学号 {preview.rec.studentId || importSid}
                      <span className="ml-2 text-[11px] font-medium text-gray-500">{preview.rec.className || ""}</span>
                    </div>
                    <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px] items-center">
                      <div className="text-gray-500">培养方案</div>
                      {editingPlan ? (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 min-w-0">
                            <PlanSelector
                              value={preview.rec.planKey || ""}
                              onChange={handleFixPlan}
                              options={allPlans}
                              autoOpen
                              seedQuery={majorHint(preview.rec.planKey, preview.rec.className)}
                              accent="indigo"
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => setEditingPlan(false)}
                            className="shrink-0 text-[11px] text-gray-400 hover:text-gray-700"
                          >
                            取消
                          </button>
                        </div>
                      ) : (
                        <div className="font-semibold text-gray-800">
                          {preview.rec.planKey || <span className="text-amber-600">未匹配 · 请手选</span>}
                          <button
                            type="button"
                            onClick={() => setEditingPlan(true)}
                            className="ml-2 text-[11px] font-medium text-indigo-600 underline decoration-dotted hover:text-indigo-800"
                          >
                            培养方案识别错误？点击修改
                          </button>
                        </div>
                      )}
                      <div className="text-gray-500">在读学期</div>
                      <div className="font-semibold text-gray-800">{preview.sug.term ? `第 ${preview.sug.term} 学期` : "无法推算"}</div>
                      <div className="text-gray-500">已修学分（不含本学期）</div>
                      <div className="flex items-center gap-1.5 font-semibold text-gray-800">
                        <input
                          type="number" min={0}
                          value={edit?.totalEarned ?? preview.sug.totalEarned}
                          onChange={(e) => setEdit((p) => ({ totalEarned: Math.max(0, Number(e.target.value) || 0), electiveThisSem: p?.electiveThisSem ?? preview.sug.electiveThisSem }))}
                          className="w-20 px-2 py-1 rounded-md border border-gray-200 bg-white text-sm outline-none focus:border-indigo-300"
                        />
                        <span className="text-gray-400 font-normal">分 · {preview.sug.takenCount} 门</span>
                      </div>
                      <div className="text-gray-500">本学期已选选修</div>
                      <div className="flex items-center gap-1.5 font-semibold text-gray-800">
                        <input
                          type="number" min={0}
                          value={edit?.electiveThisSem ?? preview.sug.electiveThisSem}
                          onChange={(e) => setEdit((p) => ({ totalEarned: p?.totalEarned ?? preview.sug.totalEarned, electiveThisSem: Math.max(0, Number(e.target.value) || 0) }))}
                          className="w-20 px-2 py-1 rounded-md border border-gray-200 bg-white text-sm outline-none focus:border-indigo-300"
                        />
                        <span className="text-gray-400 font-normal">分</span>
                      </div>
                      <div className="text-gray-500">已修专业限选</div>
                      <div className="font-semibold text-gray-800">{preview.sug.takenMajorElectiveCids.length} 门</div>
                    </div>
                    <p className="mt-2.5 pt-2.5 border-t border-indigo-100 text-[11px] text-gray-500 leading-relaxed">
                      此数据由历史课表自动推算，请前往{" "}
                      <a href={JWC_URL} target="_blank" rel="noopener noreferrer" className="font-semibold text-indigo-600 underline hover:text-indigo-800">学籍预警</a>{" "}
                      核查并手动修正。
                    </p>
                  </div>

                  {/* 转专业开关 + 原专业搜索下拉（前两学期在原专业修读的同学在此勾选） */}
                  <div className="rounded-xl border border-gray-200 p-3">
                    <button
                      type="button"
                      onClick={() => setEditTransfer((v) => !v)}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg border text-left transition-colors ${
                        editTransfer ? "bg-amber-50 border-amber-200" : "bg-white border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                        editTransfer ? "bg-amber-500 border-amber-500 text-white" : "border-gray-300"
                      }`}>
                        {editTransfer && (
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </span>
                      <span className="flex-1 text-[13px] text-gray-800">转专业学生</span>
                    </button>
                    {editTransfer && (
                      <div className="mt-2.5">
                        <label className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5 block">原专业（年级·专业）</label>
                        <PlanSelector
                          value={editOriginalPlan}
                          onChange={setEditOriginalPlan}
                          options={allPlans.filter((p) => p !== preview.rec.planKey)}
                          accent="indigo"
                          seedQuery={majorHint(undefined, preview.rec.className)}
                        />
                        <p className="mt-2 text-[11px] text-gray-400 leading-relaxed">
                          选你<strong className="text-gray-600">入学时</strong>的原专业。
                        </p>
                      </div>
                    )}
                  </div>

                  {/* 本学期课表（含班级），仅展示参考 */}
                  {preview.rec.scheduleItems.length > 0 && (
                    <div className="rounded-xl border border-gray-200 p-3">
                      <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-2">本学期课表（{preview.rec.scheduleItems.length} 节，参考）</div>
                      <div className="space-y-1 max-h-44 overflow-y-auto">
                        {preview.rec.scheduleItems.map((it, i) => (
                          <div key={i} className="flex items-center gap-2 text-[12px]">
                            <span className="text-gray-800 truncate flex-1">{it.courseName}</span>
                            <span className="text-gray-400 shrink-0">{it.schedule || ""}</span>
                            <span className="text-gray-400 shrink-0">{it.teacher || ""}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 固定底部操作区：确认导入按钮始终可见（不随预览内容滚动隐藏） */}
            {preview && (
              <div className="px-4 sm:px-7 py-4 border-t border-gray-100 bg-gray-50/60 shrink-0">
                <button
                  onClick={handleApplyImport}
                  className="w-full py-2.5 rounded-xl bg-indigo-500 text-white text-[14px] font-bold hover:bg-indigo-600 shadow-sm shadow-indigo-200"
                >
                  确认并导入数据
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
