// AI帮我选 —— SimPanel 第 4 个 tab。状态机：idle →（同步构建候选集）→ requesting（可取消）→ done | error。
// 原则：AI 只出主意 —— 卡片上的课名/学分/教师/评分/余量/时间全部用本地数据渲染，
// AI 的 reason 只作灰色小字（纯文本 + 滤掉 URL）；应用前把本次「增量」打成撤销点存 sessionStorage
//（只回退 AI 加进去的部分，不回滚应用后的手动操作）。

import { useEffect, useMemo, useRef, useState } from "react";
import type { Course, FormalSection, PlanCourse } from "../../types";
import type { CreditPlanView } from "../../lib/creditPlan";
import { enrollYear, isTestSemester, termToCalLabel } from "../../lib/term";
import type { PlanBundle } from "../../lib/planShare";
import { buildAiCandidateBundle, candidateSectionsOf, formatSlots, resolveCandidateSemester } from "../../lib/ai/candidates";
import { validateAiPicks, projectSelection, buildBundlePatch, type AiValidateContext } from "../../lib/ai/validate";
import { requestAiRecommend } from "../../lib/ai/client";
import { PREFERENCE_MAX_CHARS } from "../../lib/ai/types";
import type { AiRecommendResponse, PickIssue, SectionOptionKey, ValidatedPick } from "../../lib/ai/types";

interface Props {
  view: CreditPlanView;
  selectedPlan: string;
  /** 当前在读第几学期（推荐目标 = term + 1）。 */
  term: number;
  /** 课程表（public/courses.json）。注意它并非全集——只在往期学期开过课的方案选修不在其中，
   *  仅作展示/归类兜底；unknown_cid 判定只看候选白名单，展示缺口由 infoByCid 兜底。 */
  courses: Course[];
  /** 当前方案的 plan_courses（由 HomePage 传入，绝不在此二次加载 5.5MB）。 */
  planCourses: PlanCourse[];
  /** plan_courses.json 是否已加载完成——未就绪时禁止生成（候选会缺整个「本方案选修」组）。 */
  planCoursesReady: boolean;
  formalSections: FormalSection[];
  takenCids: Set<string>;
  /** 待选清单 cid 数组（cartStore 原始顺序）。 */
  cart: string[];
  /** useChosenSections 的选班覆盖。 */
  chosen: Record<string, string>;
  /** 教师评分（useAllRatings.getTeacherAvg）。 */
  ratingOf: (cid: string, teacherId: string) => { avg: number; count: number } | null;
  /** 实时余量；无实时数据时返回 null。 */
  remainingOf: (s: FormalSection) => { left: number; cap: number } | null;
  /** 当前 StoredInputs —— 撤销点/应用 bundle 打包用（与 SimPanel 分享码同一份）。 */
  inputs: Record<string, unknown>;
  onApplyBundle: (bundle: PlanBundle) => void;
  /** SimPanel 的轻提示 toast。 */
  onNotify: (msg: string) => void;
}

const UNDO_KEY = "jxnu.ai.undo";

/** 撤销点：只记录本次 AI 应用的「增量」，撤销时基于当前最新 cart/chosen 逐项回退，
 *  不整包快照回滚——应用后用户手动加的课/换的班/inputs 一律保留。 */
interface AiUndoPoint {
  /** 应用时的 planKey：撤销时已切方案 → 撤销点失效。 */
  plan: string;
  /** 本次真正新加进待选清单的 cid（撤销 = 从当前 cart 移除它们）。 */
  addedCids: string[];
  /** 本次覆盖的 chosen 旧值：原本没有该 key → null（撤销时删除）。 */
  prevChosen: Record<string, string | null>;
}

/** 解析 sessionStorage 里的撤销点；形状不合（含旧版整包快照格式）返回 null。 */
function parseUndoPoint(raw: string): AiUndoPoint | null {
  try {
    const p: unknown = JSON.parse(raw);
    if (
      p != null && typeof p === "object" &&
      typeof (p as AiUndoPoint).plan === "string" &&
      Array.isArray((p as AiUndoPoint).addedCids) &&
      (p as AiUndoPoint).addedCids.every((c) => typeof c === "string") &&
      (p as AiUndoPoint).prevChosen != null && typeof (p as AiUndoPoint).prevChosen === "object" &&
      Object.values((p as AiUndoPoint).prevChosen).every((v) => v === null || typeof v === "string")
    ) {
      return p as AiUndoPoint;
    }
  } catch {}
  return null;
}

type Phase = "idle" | "requesting" | "done" | "error";

/** PickIssue → 徽标文案。hard = 置灰不可选（红灰），其余黄色警示 / 中性提示。 */
const ISSUE_BADGES: Record<PickIssue, { label: string; hard: boolean }> = {
  unknown_cid: { label: "查无此课（AI 幻觉）", hard: true },
  unknown_section: { label: "班级对不上", hard: true },
  taken: { label: "已修过", hard: true },
  duplicate: { label: "重复推荐", hard: true },
  already_in_cart: { label: "已在清单", hard: false },
  conflict: { label: "时间冲突", hard: false },
  ge_limit: { label: "公选课将超 2 门", hard: false },
  any_elective_limit: { label: "任意选修将超 2 门", hard: false },
};

/** reason 纯文本化：滤掉 http/https 串，防 AI 输出里夹带链接。 */
function sanitizeReason(raw: string): string {
  return (raw || "").replace(/https?:\/\/\S+/gi, "").trim().slice(0, 120);
}

interface AiResult {
  resp: AiRecommendResponse;
  whitelist: Map<string, Set<SectionOptionKey>>;
  keyByClassName: Map<string, SectionOptionKey>;
  /** 发出去的 cid -> 课名/学分（Course 查不到时的展示/学分兜底）。 */
  infoByCid: Map<string, { name: string; credits: number }>;
  /** 候选集构建时被截断的班级数（UI 披露）。 */
  truncated: number;
}

export function AiTab({
  view, selectedPlan, term, courses, planCourses, planCoursesReady, formalSections,
  takenCids, cart, chosen, ratingOf, remainingOf, inputs, onApplyBundle, onNotify,
}: Props) {
  const [preference, setPreference] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [result, setResult] = useState<AiResult | null>(null);
  const [checked, setChecked] = useState<Set<number>>(() => new Set());
  const [candidateCount, setCandidateCount] = useState(0);
  const [hasUndo, setHasUndo] = useState<boolean>(() => {
    try { return sessionStorage.getItem(UNDO_KEY) != null; } catch { return false; }
  });
  const abortRef = useRef<AbortController | null>(null);
  // tab 切走 / 面板关闭时中止在途请求（配额在服务端已计，但不再回写状态）。
  useEffect(() => () => abortRef.current?.abort(), []);

  // requesting 期间 cart/chosen 可能变化（用户在表格里继续加课/换班）——每次渲染同步 .current，
  // 响应到达后用 ref 里的最新值算默认勾选，不吃 async 闭包里的陈旧快照。
  const cartRef = useRef(cart);
  const chosenRef = useRef(chosen);
  cartRef.current = cart;
  chosenRef.current = chosen;

  const planTerm = term + 1;
  const planLabel = useMemo(() => termToCalLabel(enrollYear(selectedPlan), planTerm), [selectedPlan, planTerm]);
  // 取班学期唯一权威：规划学期已发布用规划学期，否则当前进行中的开课安排（与 candidates/validate 同解析规则）。
  const { sem: targetSem, isFallback: semFallback } = useMemo(
    () => resolveCandidateSemester(formalSections, planLabel),
    [formalSections, planLabel],
  );

  // 校验上下文随本地状态实时刷新：应用后 cart 变化 → 已应用项自动转「已在清单」，projection 不双计。
  const ctx = useMemo<AiValidateContext | null>(() => {
    if (!result) return null;
    return {
      plan: selectedPlan, planLabel, view, courses, formalSections, takenCids, cart, chosen,
      whitelist: result.whitelist, keyByClassName: result.keyByClassName, infoByCid: result.infoByCid,
    };
  }, [result, selectedPlan, planLabel, view, courses, formalSections, takenCids, cart, chosen]);

  const picks = useMemo<ValidatedPick[]>(
    () => (result && ctx ? validateAiPicks(result.resp, ctx) : []),
    [result, ctx],
  );

  // 每张卡片的本地展示数据（教师/时间/评分/余量全部来自本地 section，不信 AI 回显）。
  const displayInfos = useMemo(() => picks.map((p) => {
    if (!p.optionKey) return null;
    const { options, sem } = candidateSectionsOf(formalSections, p.pick.cid, targetSem);
    const opt = options.find((o) => o.key === p.optionKey);
    if (!opt) return null;
    return {
      teacher: opt.teacher,
      className: opt.className,
      time: formatSlots(opt.slots),
      rating: ratingOf(p.pick.cid, opt.teacherId),
      remaining: remainingOf(opt.section),
      sem,
    };
  }), [picks, formalSections, targetSem, ratingOf, remainingOf]);

  const projection = useMemo(
    () => (ctx && picks.length > 0 ? projectSelection(picks, checked, ctx) : null),
    [ctx, picks, checked],
  );
  // 「应用」实际会吸收的门数：勾选 ∧ 可选 ∧ 解出精确 optionKey ∧ 非「已在清单」
  //（与 handleApply 的过滤同口径——黄色警示项默认不勾，用户明知冲突/超限仍手动勾选属知情选择，予以尊重）。
  const applyCount = useMemo(
    () => picks.filter((p, i) => checked.has(i) && p.selectable && p.optionKey && !p.issues.includes("already_in_cart")).length,
    [picks, checked],
  );
  // 免责区的测试数据注记：规划学期或任一卡片实际取数学期属于测试集合时显示。
  const usesTestData = useMemo(
    () => isTestSemester(planLabel) || displayInfos.some((d) => d?.sem != null && isTestSemester(d.sem)),
    [planLabel, displayInfos],
  );

  const toggleChecked = (i: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const handleGenerate = async () => {
    if (phase === "requesting") return;
    if (!selectedPlan) {
      onNotify("请先选择培养方案");
      return;
    }
    // 防御：plan_courses.json（5.5MB）还在下载时不发请求——候选会缺整个「本方案选修」组，
    // context 也会误写「下学期必修（无）」，白白扣一次配额。按钮同时置灰，这里是双保险。
    if (!planCoursesReady) {
      onNotify("方案数据加载中，请稍候再试");
      return;
    }
    // 候选集构建是同步纯计算（毫秒级），不单独渲染 building 态。
    const bundle = buildAiCandidateBundle({
      plan: selectedPlan, view, term, courses, planCourses, formalSections,
      takenCids, cart, chosen, ratingOf, remainingOf, preference: preference.trim(),
    });
    if (bundle.stats.courses === 0) {
      setPhase("error");
      setErrorMsg(`没有可推荐的候选课程（${view.nextSemKey || "下学期"}课表可能尚未发布，或候选都已在清单/已修）`);
      return;
    }
    setCandidateCount(bundle.stats.courses);
    setPhase("requesting");
    const controller = new AbortController();
    abortRef.current = controller;
    const res = await requestAiRecommend(
      {
        plan: selectedPlan,
        context: bundle.context,
        candidates: bundle.candidates,
        preference: preference.trim(),
      },
      controller.signal,
    );
    if (controller.signal.aborted) return; // 用户已取消 → 丢弃结果，状态由取消按钮处理
    if (!res.ok) {
      setPhase("error");
      setErrorMsg(res.message);
      return;
    }
    // 默认勾选：干净项（可选且无任何 issue）；警示项/已在清单默认不勾，由用户确认。
    // cart/chosen 用 ref 的最新值——requesting 期间用户可能已改动，闭包快照会算错默认勾选。
    const validated = validateAiPicks(res.data, {
      plan: selectedPlan, planLabel, view, courses, formalSections, takenCids,
      cart: cartRef.current, chosen: chosenRef.current,
      whitelist: bundle.whitelist, keyByClassName: bundle.keyByClassName, infoByCid: bundle.infoByCid,
    });
    const defaults = new Set<number>();
    validated.forEach((p, i) => { if (p.selectable && p.issues.length === 0) defaults.add(i); });
    setChecked(defaults);
    setResult({
      resp: res.data,
      whitelist: bundle.whitelist,
      keyByClassName: bundle.keyByClassName,
      infoByCid: bundle.infoByCid,
      truncated: bundle.stats.truncatedSections,
    });
    setPhase("done");
  };

  const handleCancelRequest = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase(result ? "done" : "idle");
  };

  const handleApply = () => {
    if (!ctx || applyCount === 0) return;
    // 双保险第二重：应用一律按「最新校验」为准——期间 cart/chosen 若有变化，重算后变成
    // 硬性问题（!selectable：幻觉/已修/重复等）或「已在清单」的勾选项强制剔除；黄色警示项
    //（conflict/ge_limit/any_elective_limit）保留——默认不勾，用户手动勾选即知情选择。
    const freshChecked = new Set(
      [...checked].filter((i) => {
        const p = picks[i];
        return p != null && p.selectable && p.optionKey != null && !p.issues.includes("already_in_cart");
      }),
    );
    const patch = buildBundlePatch(cart, chosen, picks, freshChecked);
    // 撤销点只存增量：本次真正新加的 cid + 被覆盖的 chosen 旧值。写失败只是少了撤销按钮，不阻断。
    const inCart = new Set(cart);
    const addedCids = patch.cart.filter((cid) => !inCart.has(cid));
    const prevChosen: Record<string, string | null> = {};
    for (const [cid, key] of Object.entries(patch.chosen)) {
      if (chosen[cid] !== key) prevChosen[cid] = chosen[cid] ?? null;
    }
    try {
      const undo: AiUndoPoint = { plan: selectedPlan, addedCids, prevChosen };
      sessionStorage.setItem(UNDO_KEY, JSON.stringify(undo));
      setHasUndo(true);
    } catch {}
    onApplyBundle({ v: 1, plan: selectedPlan, inputs, cart: patch.cart, chosen: patch.chosen });
    setChecked(new Set());
    onNotify(`已应用 ${freshChecked.size} 门课程到待选清单`);
  };

  const handleUndo = () => {
    const clearUndo = () => {
      try { sessionStorage.removeItem(UNDO_KEY); } catch {}
      setHasUndo(false);
    };
    let raw: string | null = null;
    try { raw = sessionStorage.getItem(UNDO_KEY); } catch {}
    if (!raw) { setHasUndo(false); return; }
    const undo = parseUndoPoint(raw);
    if (!undo) {
      onNotify("撤销数据已损坏");
      clearUndo();
      return;
    }
    if (undo.plan !== selectedPlan) {
      onNotify("已切换方案，撤销点失效");
      clearUndo();
      return;
    }
    // 增量回退：基于「当前最新」cart/chosen 只摘掉 AI 加的部分——应用后手动加的课、换的班
    // 和 inputs 全部保留（继续走 onApplyBundle 落地通道，但内容是增量回退后的结果）。
    const removed = new Set(undo.addedCids);
    const nextCart = cart.filter((cid) => !removed.has(cid));
    const nextChosen = { ...chosen };
    for (const [cid, prev] of Object.entries(undo.prevChosen)) {
      if (prev === null) delete nextChosen[cid];
      else nextChosen[cid] = prev;
    }
    onApplyBundle({ v: 1, plan: selectedPlan, inputs, cart: nextCart, chosen: nextChosen });
    onNotify("已撤销 AI 添加的课程");
    clearUndo();
  };

  return (
    <div className="space-y-3">
      {/* 输入区 */}
      <div className="rounded-xl border border-gray-200 p-3 space-y-2">
        <div className="text-[12px] font-bold text-gray-700">选课偏好（可留空）</div>
        <textarea
          value={preference}
          onChange={(e) => setPreference(e.target.value)}
          maxLength={PREFERENCE_MAX_CHARS}
          placeholder="例：不要早八，想选羽毛球，优先评分高的老师"
          disabled={phase === "requesting"}
          className="w-full h-16 px-2 py-1.5 rounded-lg border border-gray-200 bg-white text-[12px] leading-relaxed resize-none outline-none focus:border-red-300 focus:ring-1 focus:ring-red-100 disabled:bg-gray-50 disabled:text-gray-400"
        />
        <p className="text-[10.5px] text-gray-400 leading-relaxed">
          推荐范围 = 本方案选修 + 公选课 + 当前开课的任意选修（最多 20 门）；偏好关键词会优先筛选。
          专业任选和任意选修按同一优先级比较。
        </p>
        <p className="text-[10.5px] text-gray-400 leading-relaxed">
          点击后将把你的培养方案与学分进度摘要、候选课程列表发送给管理员配置的 AI 服务商。
        </p>
        {phase === "requesting" ? (
          <div className="flex items-center gap-2">
            <div className="flex-1 inline-flex items-center gap-2 text-[12px] text-gray-500">
              <span className="w-3.5 h-3.5 border-2 border-red-200 border-t-red-500 rounded-full animate-spin shrink-0" />
              AI 正在分析 {candidateCount} 门候选课…约需 10-30 秒
            </div>
            <button
              onClick={handleCancelRequest}
              className="px-3 py-1.5 rounded-lg border border-gray-200 text-[12px] text-gray-500 hover:bg-gray-50 shrink-0"
            >
              取消
            </button>
          </div>
        ) : (
          <button
            onClick={handleGenerate}
            disabled={!selectedPlan || !planCoursesReady}
            className="w-full h-9 rounded-lg bg-red-500 text-white text-[12px] font-bold hover:bg-red-600 disabled:bg-gray-200 disabled:text-gray-400 transition-colors"
          >
            {!selectedPlan
              ? "请先选择培养方案"
              : !planCoursesReady
                ? "方案数据加载中…"
                : result
                  ? "重新生成推荐"
                  : "生成 AI 推荐"}
          </button>
        )}
      </div>

      {/* 出错：文案 + 重试 */}
      {phase === "error" && (
        <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3 space-y-2">
          <div className="text-[12px] text-rose-600 leading-relaxed">{errorMsg}</div>
          <button
            onClick={handleGenerate}
            className="px-3 py-1.5 rounded-lg border border-rose-300 text-rose-600 text-[12px] font-bold hover:bg-rose-50"
          >
            重试
          </button>
        </div>
      )}

      {/* 结果：策略一句话 + 卡片列表 + projection 条 */}
      {phase === "done" && result && (
        <div className="space-y-2">
          {result.resp.strategy && (
            <div className="rounded-lg bg-red-50/70 border border-red-100 px-3 py-2 text-[12px] text-gray-700 leading-relaxed">
              <span className="font-bold text-red-500 mr-1">策略</span>
              {sanitizeReason(result.resp.strategy)}
            </div>
          )}
          {semFallback && targetSem && (
            <div className="text-[10.5px] text-gray-400">
              规划学期开课安排尚未发布，推荐班级取自当前进行中的 {targetSem} 开课安排，实际以正选公布为准。
            </div>
          )}
          {result.truncated > 0 && (
            <div className="text-[10.5px] text-gray-400">候选集已按评分截断 {result.truncated} 个班级，推荐基于截断后的名单。</div>
          )}
          {picks.length === 0 && (
            <div className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-center text-[12px] text-gray-400">
              AI 没有给出任何推荐，试试换个偏好再生成
            </div>
          )}
          {picks.map((p, i) => {
            const info = displayInfos[i];
            const isChecked = checked.has(i);
            const hasWarn = p.issues.some((iss) => !ISSUE_BADGES[iss].hard && iss !== "already_in_cart");
            const cardCls = !p.selectable
              ? "border-gray-100 bg-gray-50 opacity-60"
              : hasWarn
                ? "border-amber-200 bg-amber-50/40"
                : isChecked
                  ? "border-red-200 bg-red-50/30"
                  : "border-gray-200 bg-white";
            return (
              <label key={i} className={`rounded-lg border p-2.5 flex items-start gap-2.5 transition-colors ${cardCls} ${p.selectable ? "cursor-pointer" : "cursor-not-allowed"}`}>
                <input
                  type="checkbox"
                  checked={isChecked}
                  disabled={!p.selectable}
                  onChange={() => toggleChecked(i)}
                  className="w-3.5 h-3.5 mt-0.5 accent-red-500 shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className={`text-[12px] font-semibold truncate ${p.selectable ? "text-gray-800" : "text-gray-400"}`}>
                      {p.name ?? p.pick.cid}
                    </span>
                    {p.credits != null && (
                      <span className="text-[10px] font-bold text-red-500 bg-red-50 rounded px-1 py-0.5 shrink-0">
                        {p.credits} 学分
                      </span>
                    )}
                    {p.issues.map((iss) => (
                      <span
                        key={iss}
                        className={`text-[10px] font-bold rounded px-1 py-0.5 shrink-0 ${
                          ISSUE_BADGES[iss].hard
                            ? "text-gray-500 bg-gray-200"
                            : iss === "already_in_cart"
                              ? "text-blue-600 bg-blue-50 border border-blue-100"
                              : "text-amber-700 bg-amber-100"
                        }`}
                      >
                        {ISSUE_BADGES[iss].label}
                      </span>
                    ))}
                  </div>
                  {info && (
                    <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-gray-500 flex-wrap">
                      <span className="truncate">{info.teacher}</span>
                      <span className="text-gray-300">·</span>
                      <span className="truncate">{info.className}</span>
                      {info.time && (
                        <>
                          <span className="text-gray-300">·</span>
                          <span className="font-mono">{info.time}</span>
                        </>
                      )}
                      {info.rating && (
                        <span className="text-amber-500 font-semibold shrink-0">
                          ★ {info.rating.avg.toFixed(1)}({info.rating.count})
                        </span>
                      )}
                      {info.remaining && (
                        <span className={`shrink-0 font-semibold ${info.remaining.left > 0 ? "text-emerald-600" : "text-rose-500"}`}>
                          余 {info.remaining.left}/{info.remaining.cap}
                        </span>
                      )}
                    </div>
                  )}
                  {p.conflictWith.length > 0 && (
                    <div className="mt-0.5 text-[10.5px] text-amber-600">
                      与 {p.conflictWith.map((n) => `《${n}》`).join("")} 时间冲突
                    </div>
                  )}
                  {p.pick.reason && (
                    <div className="mt-0.5 text-[10.5px] text-gray-400 leading-relaxed">{sanitizeReason(p.pick.reason)}</div>
                  )}
                </div>
              </label>
            );
          })}

          {/* 实时 projection 条 + 应用按钮 */}
          {picks.length > 0 && projection && (
            <div className="rounded-xl border border-gray-200 bg-white p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] text-gray-500">
                  下学期{" "}
                  <span className={`font-black text-[15px] ${projection.over ? "text-rose-600" : "text-gray-800"}`}>
                    {projection.nextSemCredits}
                  </span>
                  <span className="text-gray-400">/{projection.cap}</span>
                  {projection.over && <span className="ml-1 text-[10px] font-bold text-rose-600">超限</span>}
                </span>
                <button
                  onClick={handleApply}
                  disabled={applyCount === 0}
                  className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-[12px] font-bold hover:bg-red-600 disabled:bg-gray-200 disabled:text-gray-400 transition-colors shrink-0"
                >
                  应用到待选清单（{applyCount}）
                </button>
              </div>
              {projection.conflicts.length > 0 && (
                <div className="text-[10.5px] text-amber-600 leading-relaxed">
                  {projection.conflicts.map(([a, b], k) => (
                    <div key={k}>⚠ 《{a}》与《{b}》时间冲突</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 撤销：常驻到 undo 点被消费/覆盖为止（sessionStorage 保存增量，切 tab 不丢） */}
      {hasUndo && (
        <button
          onClick={handleUndo}
          className="w-full h-9 rounded-xl border border-gray-200 text-[12px] font-medium text-gray-500 hover:border-gray-300 hover:bg-gray-50 inline-flex items-center justify-center gap-1.5 transition-colors"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a5 5 0 015 5v1M3 10l5-5m-5 5l5 5" />
          </svg>
          撤销本次 AI 添加的课程
        </button>
      )}

      {/* 常驻免责声明 */}
      <p className="text-[10.5px] text-gray-400 leading-relaxed text-center">
        AI 建议仅供参考，选课以教务系统实际结果为准
        {usesTestData && <span className="text-amber-500">（当前为测试数据）</span>}
      </p>
    </div>
  );
}
