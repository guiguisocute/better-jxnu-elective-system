import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from "react";
import { useCourseData } from "../hooks/useCourseData";
import { useCourseFilter } from "../hooks/useCourseFilter";
import { useFormalData } from "../hooks/useFormalData";
import { useAllRatings } from "../hooks/useRatings";
import { useSimMode } from "../hooks/useSimMode";
import { useCart } from "../hooks/useCart";
import { useChosenSections } from "../hooks/useChosenSections";
import { useCreditPlan } from "../hooks/useCreditPlan";
import { usePlanCourses } from "../hooks/usePlanCourses";
import { useScheduleFilter } from "../hooks/useScheduleFilter";
import { useLiveEnrollments } from "../hooks/useLiveEnrollments";
import { sectionMatchesSchedule, parseSchedule } from "../lib/scheduleParse";
import { buildPlacement } from "../lib/schedulePlacement";
import { termToCalLabel, enrollYear } from "../lib/term";
import { isInPlan, isAnyElective, displayTags } from "../lib/planMatch";
import { areasOf, sectionInArea } from "../lib/classroomArea";
import { decodeBundle, readCodeFromUrl, clearCodeFromUrl, type PlanBundle } from "../lib/planShare";
import { isPassed } from "../lib/studentRecord";
import { LIVE_ENROLLMENT_SEMESTER } from "../lib/liveEnrollments";
import { FilterBar } from "./FilterBar";
import { Contributors } from "./Contributors";
import { ScheduleFilter } from "./ScheduleFilter";
import { CourseTable } from "./CourseTable";
import { CourseDetail } from "./CourseDetail";
import { FormalSectionDetail } from "./FormalSectionDetail";
import { Pagination } from "./Pagination";
import { SimToggle } from "./sim/SimToggle";
import { SimPanel } from "./sim/SimPanel";
import { OnboardingModal } from "./sim/OnboardingModal";
import { ConfirmDialog } from "./sim/ConfirmDialog";
import { ThemeToggle } from "./ThemeToggle";
import type { Course, DataSource, FormalSection, FormalGroup } from "../types";

const DATA_SOURCE_KEY = "jxnu_data_source";
const FORMAL_AUTO_EXPAND_SECTION_LIMIT = 240;
const FORMAL_AUTO_EXPAND_GROUP_LIMIT = 30;

function loadDataSource(): DataSource {
  // 默认进「正选」（学期由下方兜底 effect 落到最新 = 2026-09）；
  // 同会话内已切到预选/补退选的选择仍被 sessionStorage 尊重。
  if (typeof window === "undefined") return "formal";
  const v = sessionStorage.getItem(DATA_SOURCE_KEY);
  if (v === "pre" || v === "formal" || v === "addDrop") return v;
  return "formal";
}

// 按学校学期惯例算"当前学期"key：月份 2-7 → 03（春），其余 → 09（秋）；1 月归上一年的 09。
// 与 build_data.py 的 format_semester() 同口径，保证生成的 key 一致。
function currentSemester(now = new Date()): string {
  const m = now.getMonth() + 1;
  const isSpring = m >= 2 && m <= 7;
  const year = m === 1 ? now.getFullYear() - 1 : now.getFullYear();
  return `${year}-${isSpring ? "03" : "09"}`;
}

// 学期 key 排序：YYYY-MM 形态，字典序即正确顺序（YYYY 升 + 03 < 09）。返回新数组，不改入参。
function sortSemesters(list: string[]): string[] {
  return [...list].sort((a, b) => a.localeCompare(b));
}

const GITHUB_URL = "https://github.com/guiguisocute/better-jxnu-elective-system";

const formalSectionKey = (s: FormalSection) => `${s.id}|${s.className}|${s.teacherId}`;
const normalizeTeacherName = (v: string | undefined) => (v ?? "").replace(/\s+/g, "");
const splitTeacherNames = (v: string | undefined) =>
  normalizeTeacherName(v).split(/[、,，/]/).map((x) => x.trim()).filter(Boolean);
const teacherMatches = (sectionTeacher: string, importedTeacher: string | undefined) => {
  const section = normalizeTeacherName(sectionTeacher);
  if (!section) return false;
  const names = splitTeacherNames(importedTeacher);
  if (names.length === 0) return true;
  return names.some((name) => section.includes(name) || name.includes(section));
};

function GithubIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

/** 侧栏底部的浅灰说明文字（含内联 GitHub 链接）+ 贡献者展示，跟随筛选项滚动到底才会出现。 */
function SidebarDisclaimer() {
  return (
    <>
      <p className="mt-10 mb-2 px-2 text-center text-[12px] leading-relaxed text-gray-400">
        本站课程数据均同步自学校教务系统。若发现数据纰漏或希望提出改进建议，欢迎提交{" "}
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 align-baseline text-gray-500 hover:text-gray-700 transition-colors underline-offset-2 hover:underline"
        >
          <GithubIcon className="w-3 h-3 -mt-px" />
          <span>Issue 或 Pull Request</span>
        </a>
        。
      </p>
      <Contributors className="mt-6 mb-1" />
    </>
  );
}

export function HomePage() {
  const { courses, loading, error, allDepts, allCredits, allPlans, courseTypes, subTags } = useCourseData();
  const { getCourseAvg, getTeacherAvg } = useAllRatings();
  const formal = useFormalData();

  // 数据源切换：预选 / 正选 / 补退选。初值从 sessionStorage 恢复。
  const [dataSource, setDataSource] = useState<DataSource>(() => loadDataSource());
  useEffect(() => {
    sessionStorage.setItem(DATA_SOURCE_KEY, dataSource);
  }, [dataSource]);

  // 课表时段筛选 —— 预选/正选/补退选 分别保存（不共享）。
  const schedule = useScheduleFilter(dataSource);

  // 模拟选课：模式状态机 + 待选清单 + 学分核算（全部作用于预选/Course 视图）。
  const sim = useSimMode();
  const cart = useCart();
  const cartCourses = useMemo(
    () => cart.ids.map((id) => courses.find((c) => c.id === id)).filter(Boolean) as Course[],
    [cart.ids, courses],
  );
  // 桥接 plan —— 解决 filter（用 takenCids）和 credit（用 filters.plan）的循环依赖：
  // currentPlan 由下方 useEffect 与 filter.filters.plan 同步，credit/planCourses 用它。
  const [currentPlan, setCurrentPlan] = useState<string>(() => {
    try {
      const raw = sessionStorage.getItem("jxnu_filters");
      if (raw) return (JSON.parse(raw).filters?.plan as string) ?? "";
    } catch {}
    return "";
  });
  // 方案课程清单懒加载（~5MB）：仅在模拟选课开启时加载。
  const planCourses = usePlanCourses(sim.mode !== "browse", currentPlan);
  const credit = useCreditPlan(currentPlan, cartCourses, planCourses.courses, planCourses.coursesOf);
  // 预选视图：只展示真正出现在 preselect_catalog 的课（inPre !== false）。
  // inPre === false 的 282 门是 build_data.py 用 formal 真实老师补全的 master 条目（含 25 门零分课），
  // 它们不在当学期 catalog 里，学生预选阶段实际选不到，不应出现在预选列表。
  // coursesById/cartCourses 仍用 courses 全集（正选 任意选修 tag 派生需要它们）。
  const preCourses = useMemo(() => courses.filter((c) => c.inPre !== false), [courses]);
  const filter = useCourseFilter(preCourses, getCourseAvg, sim.mode === "sim" ? credit.takenCids : undefined);
  // 桥接：filter.filters.plan 变更 → 同步到 currentPlan（多一次 render，仅 plan 切换时发生）。
  useEffect(() => {
    if (filter.filters.plan !== currentPlan) setCurrentPlan(filter.filters.plan);
  }, [filter.filters.plan, currentPlan]);
  const chosenSections = useChosenSections();
  const [quickRatingActive, setQuickRatingActive] = useState(false);

  // 一键排除必修课时段：模拟选课开启时，把下学期必修课（按当前选班）占用的周时段算出来，
  // 供课表筛选「一键排除」按钮把这些格子标为 exclude，方便错峰挑选修课。
  const simPlanLabel = useMemo(
    () => termToCalLabel(enrollYear(currentPlan), (credit.term ?? 0) + 1),
    [currentPlan, credit.term],
  );
  const requiredCells = useMemo(() => {
    if (sim.mode !== "sim") return [];
    const placed = buildPlacement(
      credit.view.nextSemRequired, [], formal.sections, simPlanLabel,
      chosenSections.chosen, currentPlan, credit.stored.importedSchedule,
    );
    const cells = new Set<string>();
    for (const p of placed) {
      if (p.kind !== "required" || p.status !== "placed") continue;
      for (const m of p.slots) cells.add(`${m.day},${m.slot}`);
    }
    return [...cells];
  }, [sim.mode, credit.view.nextSemRequired, formal.sections, simPlanLabel, chosenSections.chosen, currentPlan, credit.stored.importedSchedule]);
  const requiredExcluded = requiredCells.length > 0 && requiredCells.every((k) => schedule.filter[k] === "exclude");
  const toggleExcludeRequired = useCallback(
    () => schedule.setCells(requiredCells, requiredExcluded ? null : "exclude"),
    [schedule, requiredCells, requiredExcluded],
  );

  const clearAllFilters = () => {
    setQuickRatingActive(false);
    filter.clearAll();
    schedule.clear();
  };
  const hasAnyActiveFilters = filter.hasActiveFilters || schedule.active || quickRatingActive;

  // 「真正收窄列表」的筛选 —— 后面会结合结果规模决定折叠组是否默认展开。
  // 裸选培养方案（仅高亮、未勾「仅看本方案」）不算收窄，避免太宽泛。
  const hasNarrowingFilter = useMemo(() => {
    const f = filter.filters;
    return (
      f.search.trim() !== "" ||
      f.credits.length > 0 || f.creditsExclude.length > 0 ||
      f.dept.length > 0 || f.deptExclude.length > 0 ||
      f.type.length > 0 || f.typeExclude.length > 0 ||
      f.tag.length > 0 || f.tagExclude.length > 0 ||
      f.area.length > 0 || f.areaExclude.length > 0 ||
      (f.plan !== "" && f.planFilter === "include") ||
      f.hideTaken ||
      schedule.active ||
      quickRatingActive
    );
  }, [filter.filters, schedule.active, quickRatingActive]);

  // 功能说明层：无任何筛选时中间区不堆课，先解释各区域功能（详见 FeatureHints）。
  // 「直接展示全部课程」只是临时揭开本次清洁态的列表；一旦再施加筛选就重置，
  // 下次清空筛选又会重新显示（按产品决策：每次清空筛选都显示）。不落 storage。
  const [hintsDismissed, setHintsDismissed] = useState(false);
  useEffect(() => {
    if (hasAnyActiveFilters) setHintsDismissed(false);
  }, [hasAnyActiveFilters]);
  const showHints = !hasAnyActiveFilters && !hintsDismissed;

  // 模拟选课入口：未选培养方案 → 先走引导（选方案+填学分）；已选方案 → 直接进 sim，不弹引导。
  const enterSim = useCallback(() => {
    if (filter.filters.plan) sim.goSim();
    else sim.openOnboarding();
  }, [filter.filters.plan, sim]);
  // 顶部开关：sim 态 → 关闭；browse 态 → 按上面规则进入；onboarding 态点开关不动作（由弹窗按钮处理）。
  const handleSimToggle = useCallback(() => {
    if (sim.mode === "onboarding") return;
    if (sim.mode === "sim") sim.close();
    else enterSim();
  }, [sim, enterSim]);

  // 一次性「左侧有筛选」提醒（SimPanel 风格气泡）：首次点「浏览全部」或首次走完模拟选课引导后弹一次。
  const FILTER_HINT_KEY = "jxnu.filterHintSeen";
  const [showFilterHint, setShowFilterHint] = useState(false);
  const filterHintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dismissFilterHint = useCallback(() => {
    clearTimeout(filterHintTimer.current);
    setShowFilterHint(false);
  }, []);
  const maybeShowFilterHint = useCallback(() => {
    try {
      if (localStorage.getItem(FILTER_HINT_KEY) === "1") return;
      localStorage.setItem(FILTER_HINT_KEY, "1");
    } catch {}
    setShowFilterHint(true);
    clearTimeout(filterHintTimer.current);
    filterHintTimer.current = setTimeout(() => setShowFilterHint(false), 5000);
  }, []);
  // 走完模拟选课引导：照常落 sim 态，并尝试弹一次筛选提醒。
  const handleOnboardingFinish = useCallback(() => {
    sim.finishOnboarding();
    maybeShowFilterHint();
  }, [sim, maybeShowFilterHint]);

  // 筛选提醒的锚点：移动锚 header 漏斗按钮；桌面锚左侧筛选区（展开按钮 or 内联侧栏，同一 callback ref）。
  const mobileFunnelRef = useRef<HTMLButtonElement>(null);
  const leftFilterElRef = useRef<HTMLElement | null>(null);
  const setLeftFilterEl = useCallback((el: HTMLElement | null) => { if (el) leftFilterElRef.current = el; }, []);
  const [filterHintPos, setFilterHintPos] = useState<{ top: number; left: number; dir: "left" | "up" } | null>(null);
  useEffect(() => {
    if (!showFilterHint) { setFilterHintPos(null); return; }
    const place = () => {
      if (window.innerWidth < 768) {
        const r = mobileFunnelRef.current?.getBoundingClientRect();
        if (r && r.width > 0) { setFilterHintPos({ top: r.bottom + 10, left: r.left + r.width / 2, dir: "up" }); return; }
        setFilterHintPos(null);
        return;
      }
      const r = leftFilterElRef.current?.getBoundingClientRect();
      if (r && r.width > 0) { setFilterHintPos({ top: r.top + 16, left: r.right + 12, dir: "left" }); return; }
      // 左栏抽屉态（1280–1700）下内联栏/展开按钮都未挂载 → 兜底放到内容区左上角，仍指向左。
      setFilterHintPos({ top: 150, left: 90, dir: "left" });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [showFilterHint]);

  // 方案分享码恢复：覆盖 plan + StoredInputs + cart + chosenSections，并直接进入 sim 态。
  const handleApplyBundle = useCallback(
    (b: PlanBundle) => {
      credit.importInputs(b.plan, b.inputs);
      filter.updateFilter("plan", b.plan);
      cart.setAll(b.cart);
      chosenSections.replaceAll(b.chosen);
      sim.finishOnboarding();
    },
    [credit, filter, cart, chosenSections, sim],
  );

  // ?s=<code> 自动恢复：仅首次挂载时检查；解码失败/取消都清掉 query 避免反复弹。
  const sharedCheckedRef = useRef(false);
  useEffect(() => {
    if (sharedCheckedRef.current) return;
    sharedCheckedRef.current = true;
    const code = readCodeFromUrl();
    if (!code) return;
    void (async () => {
      const b = await decodeBundle(code);
      clearCodeFromUrl();
      if (!b) return;
      setBundlePrompt(b);
    })();
  }, [handleApplyBundle]);

  // 加/移待选清单 + 顶部 toast。
  // 模拟选课模式下，新增公选课 / 任意选修若超出每学期 2 门软上限、或加入后总学分超过毕业要求，弹自定义确认框（异步）。
  const [cartToast, setCartToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 软上限确认框的待结算状态：title/message + 用户决策回写的 Promise resolver。
  const [cartConfirm, setCartConfirm] = useState<{
    title: string;
    message: string;
    resolve: (ok: boolean) => void;
  } | null>(null);
  // 通用「问一次」助手：把弹窗状态串成 Promise，便于上限检查链式 await。
  const askCartConfirm = useCallback((title: string, message: string): Promise<boolean> => {
    return new Promise<boolean>((resolve) => setCartConfirm({ title, message, resolve }));
  }, []);
  // 详情页未开模拟选课时点「加入待选清单」→ 弹「是否开启模拟选课」。
  const [enableSimPrompt, setEnableSimPrompt] = useState(false);
  // 分享码自动恢复确认（替代 window.confirm）。
  const [bundlePrompt, setBundlePrompt] = useState<PlanBundle | null>(null);
  // 上限提示核心：返回 Promise<false> = 用户拒绝继续，Promise<true> = 放行。仅对"加车"动作生效。
  // 三道软上限按顺序问：公选课 2 / 任意选修 2 / 加入后总学分 > 毕业要求。任一拒绝即终止。
  const confirmCartLimit = useCallback(
    async (id: string): Promise<boolean> => {
      if (sim.mode !== "sim") return true;
      const c = courses.find((cc) => cc.id === id);
      if (!c) return true;
      const isGeneral = c.tags.some((t) => t === "公选课" || t.startsWith("公选课-"));
      if (isGeneral) {
        const count = cartCourses.filter((x) =>
          x.tags.some((t) => t === "公选课" || t.startsWith("公选课-")),
        ).length;
        if (count >= 2) {
          const ok = await askCartConfirm(
            "超出公选课建议上限",
            `下学期待选清单已有 ${count} 门公选课（学校要求每学期不超过 2 门）。仍要加入《${c.name}》吗？`,
          );
          if (!ok) return false;
        }
      } else if (isAnyElective(c, filter.filters.plan)) {
        const count = cartCourses.filter((x) => isAnyElective(x, filter.filters.plan)).length;
        if (count >= 2) {
          const ok = await askCartConfirm(
            "超出任意选修建议上限",
            `下学期待选清单已有 ${count} 门任意选修课（学校要求每学期不超过 2 门）。仍要加入《${c.name}》吗？`,
          );
          if (!ok) return false;
        }
      }
      // 毕业总学分超额：已修 + 下学期投影（含当前 cart） + 新课 > minTotal 才弹。
      // earned 已含 mooc/赛事 校外抵扣（buildCreditPlan 里加进 electiveEarnedTotal）。
      const minTotal = credit.view.minTotal;
      if (minTotal != null) {
        const totalAfter = credit.view.earned + credit.view.projection.value + c.credits;
        if (totalAfter > minTotal) {
          const over = totalAfter - minTotal;
          const ok = await askCartConfirm(
            "已超出毕业总学分要求",
            `加入《${c.name}》(${c.credits} 学分) 后，已修 + 下学期理论学分共 ${totalAfter.toFixed(1)} 分，超毕业要求 ${minTotal} 分 ${over.toFixed(1)} 分。仍要加入吗？`,
          );
          if (!ok) return false;
        }
      }
      return true;
    },
    [courses, cartCourses, sim.mode, filter.filters.plan, credit.view, askCartConfirm],
  );
  const showCartToast = useCallback((msg: string) => {
    setCartToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setCartToast(null), 1400);
  }, []);
  const handleToggleCart = useCallback(
    async (id: string) => {
      const had = cart.has(id);
      if (!had && !(await confirmCartLimit(id))) return;
      cart.toggle(id);
      showCartToast(had ? "已移出待选清单" : "已加入待选清单");
    },
    [cart, confirmCartLimit, showCartToast],
  );

  // section 版加车：在 cart.toggle 之外，加车成功时同步把 chosenSections[cid] 设到当前班级。
  // 这样购物车「该课用的哪个班」被显式记录，section 详情页才能区分 exact/other 三态。
  // 同课 section key 形如 "班级名|教号"，与 useChosenSections / schedulePlacement 同口径。
  const sectionKeyOf = (s: FormalSection) => `${s.className}|${s.teacherId}`;
  const handleToggleCartSection = useCallback(
    async (s: FormalSection) => {
      const had = cart.has(s.id);
      if (!had && !(await confirmCartLimit(s.id))) return;
      cart.toggle(s.id);
      if (!had) chosenSections.choose(s.id, sectionKeyOf(s));
      // 移车不动 chosen，保留用户的班级偏好（下次再加自动覆盖）。
      showCartToast(had ? "已移出待选清单" : "已加入待选清单");
    },
    [cart, confirmCartLimit, showCartToast, chosenSections],
  );

  // 三态判定：none / exact / other（详见 FormalSectionDetail.cartStatus 注释）。
  // 未设 chosen[cid] 时默认 other —— 迫使用户在 section 详情里显式选班，避免歧义。
  const cartStatusOf = useCallback(
    (s: FormalSection): "none" | "exact" | "other" => {
      if (!cart.has(s.id)) return "none";
      const key = sectionKeyOf(s);
      const chosen = chosenSections.chosen[s.id];
      return chosen === key ? "exact" : "other";
    },
    [cart, chosenSections.chosen],
  );

  // 学期下拉：三种数据源 (pre / formal / addDrop) 各存各的，互不污染。
  //   - 预选 视图只看 catalog 当前学期（preSemesters），不带「（测试）」后缀。
  //   - 正选 / 补退选 共用 formal.allSemesters；测试学期的后缀由 SemesterSelector 统一处理。
  // 切换 dataSource 不会丢失另一侧的已选学期；sessionStorage 持久化整张 Record。
  const SEM_KEY = "jxnu_selected_semester";
  const [semesterByDS, setSemesterByDS] = useState<Record<DataSource, string>>(() => {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(SEM_KEY) ?? "{}");
      return { pre: "", formal: "", addDrop: "", ...parsed };
    } catch {
      return { pre: "", formal: "", addDrop: "" };
    }
  });
  useEffect(() => {
    try { sessionStorage.setItem(SEM_KEY, JSON.stringify(semesterByDS)); } catch {}
  }, [semesterByDS]);
  const setSelectedSemester = useCallback(
    (v: string) => setSemesterByDS((p) => ({ ...p, [dataSource]: v })),
    [dataSource],
  );

  // 预选侧 allSemesters：从 courses.json 派生（catalog 当前学期，通常只 1 个），过滤掉非 YYYY-MM 形态。
  const preSemesters = useMemo(
    () => [...new Set(courses.map((c) => c.semester).filter((s) => /^\d{4}-(03|09)$/.test(s)))].sort((a, b) => b.localeCompare(a)),
    [courses],
  );
  const allSemesters = dataSource === "pre" ? preSemesters : formal.allSemesters;
  const selectedSemester = semesterByDS[dataSource];
  const quickRatingSemester = useMemo(() => {
    const lastTerm = credit.term - 1;
    if (!currentPlan || lastTerm < 1) return "";
    const sem = termToCalLabel(enrollYear(currentPlan), lastTerm);
    return sem && formal.allSemesters.includes(sem) ? sem : "";
  }, [credit.term, currentPlan, formal.allSemesters]);

  // 当前激活 dataSource 的 slot 若为空 / 不在选项中，按当前学期 → 最新可选项兜底。
  // 仅惰性初始化当前激活那一个槽位（不预填三个，避免对 formal 未就绪时的竞争）。
  useEffect(() => {
    if (allSemesters.length === 0) return;
    if (selectedSemester && allSemesters.includes(selectedSemester)) return;
    const target = currentSemester();
    const sorted = sortSemesters(allSemesters);
    const next = allSemesters.includes(target) ? target : sorted[sorted.length - 1];
    setSelectedSemester(next);
  }, [allSemesters, selectedSemester, dataSource, setSelectedSemester]);

  // 应用与预选同一套筛选器（filter.filters）：search / credits / dept / type / tag。
  // FormalSection 没有 plans 字段，故 plan 维度跳过；其余字段名一致可直接复用。
  // section.id（课程号）→ Course，供正选/补退选套用培养方案筛选（section 本身无 plans）。
  const coursesById = useMemo(() => {
    const m = new Map<string, Course>();
    for (const c of courses) m.set(c.id, c);
    return m;
  }, [courses]);

  const quickRatingCourses = useMemo(() => {
    const lastTerm = credit.term - 1;
    if (!quickRatingSemester || lastTerm < 1) return [];
    return (credit.stored.importedDetailCourses ?? []).filter((c) =>
      !c.supplemented &&
      isPassed(c) &&
      !!c.courseId &&
      c.planTermIndex === lastTerm,
    );
  }, [credit.stored.importedDetailCourses, credit.term, quickRatingSemester]);
  const quickRatingSectionKeys = useMemo(() => {
    if (quickRatingCourses.length === 0) return new Set<string>();
    const importedByCid = new Map<string, typeof quickRatingCourses>();
    for (const c of quickRatingCourses) {
      const list = importedByCid.get(c.courseId) ?? [];
      list.push(c);
      importedByCid.set(c.courseId, list);
    }
    const keys = new Set<string>();
    for (const s of formal.sections) {
      if (s.semester !== quickRatingSemester) continue;
      const imported = importedByCid.get(s.id);
      if (!imported) continue;
      if (imported.some((c) =>
        teacherMatches(s.teacher, c.teacher) ||
        (!!c.teachingClass && c.teachingClass === s.className)
      )) {
        keys.add(formalSectionKey(s));
      }
    }
    return keys;
  }, [formal.sections, quickRatingCourses, quickRatingSemester]);
  const hasStudentImport = (credit.stored.importedDetailCourses?.length ?? 0) > 0;
  const quickRatingImportedCourseCount = new Set(quickRatingCourses.map((c) => c.courseId)).size;
  const quickRatingReady = quickRatingSectionKeys.size > 0;
  const quickRatingDisabledReason = !currentPlan
    ? "先选择或通过学号导入培养方案"
    : !hasStudentImport
    ? "先在模拟选课里输入学号导入"
    : !quickRatingSemester
    ? "暂无可匹配的上学期正式开课数据"
    : quickRatingImportedCourseCount === 0
    ? "导入记录里没有上学期课程"
    : !quickRatingReady
    ? "上学期课程暂未匹配到任课老师"
    : "";
  useEffect(() => {
    if (quickRatingActive && !quickRatingReady) setQuickRatingActive(false);
  }, [quickRatingActive, quickRatingReady]);
  useEffect(() => {
    if (quickRatingActive && (dataSource !== "formal" || selectedSemester !== quickRatingSemester)) {
      setQuickRatingActive(false);
    }
  }, [dataSource, quickRatingActive, quickRatingSemester, selectedSemester]);

  // 实时人数：放在内容筛选之前，让「余量筛选」拿得到 getEnrollment（余量 = 容量 − 实时已选）。
  const isFormalMode = dataSource !== "pre";
  const liveEnrollment = useLiveEnrollments(
    formal.sections,
    selectedSemester,
    isFormalMode && selectedSemester === LIVE_ENROLLMENT_SEMESTER,
  );

  // 「内容筛选」后的班级集合：搜索/学院/方案/学分/类型/教学区/隐藏已修，但【不含】课表时段筛选。
  // 课表格子里的数字基于它统计 —— 数字随内容筛选变化，却不被你点选的时段格子反向影响（issue #2 · 方案①）。
  const contentFilteredSections = useMemo(() => {
    if (!selectedSemester) return [];
    const f = filter.filters;
    const search = f.search.toLowerCase();
    // 选中培养方案时，type/tag 过滤改用「该课在本方案下的有效 tag」，与预选口径一致。
    const tagsOf = (s: FormalSection): string[] => {
      if (!f.plan) return s.tags;
      const c = coursesById.get(s.id);
      return c ? displayTags(c, f.plan) : s.tags;
    };
    const matchesType = (s: FormalSection, t: string): boolean => {
      if (t === "任意选修") {
        const c = coursesById.get(s.id);
        return c ? isAnyElective(c, f.plan) : false;
      }
      return tagsOf(s).includes(t);
    };
    return formal.sections.filter((s) => {
      if (quickRatingActive && !quickRatingSectionKeys.has(formalSectionKey(s))) return false;
      if (s.semester !== selectedSemester) return false;
      if (search && !s._search.includes(search)) return false;
      if (f.credits.length > 0 && !f.credits.includes(s.credits)) return false;
      if (f.creditsExclude.length > 0 && f.creditsExclude.includes(s.credits)) return false;
      if (f.dept.length > 0 && !f.dept.includes(s.dept)) return false;
      if (f.deptExclude.length > 0 && f.deptExclude.includes(s.dept)) return false;
      if (f.type.length > 0 && !f.type.some((t) => matchesType(s, t))) return false;
      if (f.typeExclude.length > 0 && f.typeExclude.some((t) => matchesType(s, t))) return false;
      if (f.tag.length > 0 && !f.tag.some((t) => tagsOf(s).includes(t))) return false;
      if (f.tagExclude.length > 0 && f.tagExclude.some((t) => tagsOf(s).includes(t))) return false;
      // 上课区域：教室代号 + dept 归类，命中任一区域即匹配；OTHER_AREA 谓词为「未归到任何已知区域」。
      if (f.area.length > 0 || f.areaExclude.length > 0) {
        const areas = areasOf(s.classroom, s.dept);
        if (f.area.length > 0 && !f.area.some((a) => sectionInArea(areas, a))) return false;
        if (f.areaExclude.length > 0 && f.areaExclude.some((a) => sectionInArea(areas, a))) return false;
      }
      // 培养方案硬过滤（仅 plan 非空 + 胶囊开关开时生效）：只看本方案课程。
      if (f.plan && f.planFilter === "include") {
        const c = coursesById.get(s.id);
        if (!(c && isInPlan(c, f.plan))) return false;
      }
      // 隐藏已修课程（仅 sim 模式下生效，与 useCourseFilter 同口径）。
      if (f.hideTaken && sim.mode === "sim" && credit.takenCids.has(s.id)) return false;
      return true;
    });
  }, [formal.sections, selectedSemester, filter.filters, coursesById, sim.mode, credit.takenCids, quickRatingActive, quickRatingSectionKeys]);

  // 列表实际可见的班级 = 内容筛选 + 课表时段筛选（点格子三态；无激活格子时全放行）+ 余量筛选。
  const visibleFormalSections = useMemo(() => {
    let result = schedule.active
      ? contentFilteredSections.filter((s) => sectionMatchesSchedule(s, schedule.filter))
      : contentFilteredSections;
    if (filter.filters.remaining === "available") {
      result = result.filter((s) => {
        const enrolled = liveEnrollment.getEnrollment(s);
        // 人数或容量未知 → 无法判定，保留以免误杀；已确认满员的班级隐藏。
        if (enrolled == null || s.capacity == null) return true;
        return s.capacity - enrolled > 0;
      });
    }
    return result;
  }, [contentFilteredSections, schedule.active, schedule.filter, filter.filters.remaining, liveEnrollment.getEnrollment]);

  // 课表每格班级数：基于「内容筛选后」的班级统计（issue #2 · 方案① —— 随内容筛选变，不随已选时段格子变）。
  const scheduleCellCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of contentFilteredSections) {
      for (const m of parseSchedule(s.schedule)) {
        const key = `${m.day},${m.slot}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    return counts;
  }, [contentFilteredSections]);

  // 正选/补退选排序：已选/容量按「余量 = 容量 - 已选」排；评分与学分沿用原口径。
  // 实时快照更新会替换 getEnrollment，触发这里重新分组和排序。
  // 评分用 section 教师的具体分（getTeacherAvg），与列表显示口径一致 —— 不能用课程平均（getCourseAvg），
  // 否则同课不同老师的几行排序会完全一样、且与单元格显示的星数对不上。
  // 同课程号折叠：按 s.id 分组 → 组内排序 → 组间排序。
  //   组内：评分排序时按该 section 教师分，否则按学分（同课相同）→ className 稳定。
  //   组间：评分排序用组内最高分作键，否则用该课学分；方向跟随 sortAsc / ratingSortAsc。
  // 同课程号折叠开关：默认开启；关闭则回退到「一行一个班级」的扁平模式。
  const FOLD_KEY = "jxnu_fold_groups";
  const [foldGroups, setFoldGroups] = useState<boolean>(() => {
    try { return sessionStorage.getItem(FOLD_KEY) !== "0"; } catch { return true; }
  });
  const toggleFoldGroups = useCallback(() => {
    setFoldGroups((v) => {
      try { sessionStorage.setItem(FOLD_KEY, v ? "0" : "1"); } catch {}
      return !v;
    });
  }, []);

  const formalGroupsAll = useMemo<FormalGroup[]>(() => {
    const cmpSections = (a: FormalSection, b: FormalSection) => {
      if (filter.enrollmentSortAsc !== null) {
        const aEnrolled = liveEnrollment.getEnrollment(a);
        const bEnrolled = liveEnrollment.getEnrollment(b);
        const aRemaining = aEnrolled == null || a.capacity == null ? null : a.capacity - aEnrolled;
        const bRemaining = bEnrolled == null || b.capacity == null ? null : b.capacity - bEnrolled;
        if (aRemaining === null) return bRemaining === null ? 0 : 1;
        if (bRemaining === null) return -1;
        if (aRemaining !== bRemaining) return filter.enrollmentSortAsc ? aRemaining - bRemaining : bRemaining - aRemaining;
      }
      if (filter.ratingSortAsc !== null) {
        const aAvg = getTeacherAvg(a.id, a.teacherId)?.avg ?? -1;
        const bAvg = getTeacherAvg(b.id, b.teacherId)?.avg ?? -1;
        if (aAvg !== bAvg) return filter.ratingSortAsc ? aAvg - bAvg : bAvg - aAvg;
      }
      const cmp = a.credits - b.credits;
      return filter.sortAsc ? cmp : -cmp;
    };
    // 折叠关闭：回退扁平模式 —— 每个班级各成一组（全部渲染为独立行），排序与原先一致。
    if (!foldGroups) {
      return [...visibleFormalSections]
        .sort(cmpSections)
        .map((s) => ({ id: s.id, course: coursesById.get(s.id), sections: [s] }));
    }
    const byId = new Map<string, FormalSection[]>();
    for (const s of visibleFormalSections) {
      const arr = byId.get(s.id);
      if (arr) arr.push(s);
      else byId.set(s.id, [s]);
    }
    const sortSections = (arr: FormalSection[]) =>
      [...arr].sort((a, b) => {
        if (filter.enrollmentSortAsc !== null) return cmpSections(a, b) || a.className.localeCompare(b.className);
        if (filter.ratingSortAsc !== null) {
          const aAvg = getTeacherAvg(a.id, a.teacherId)?.avg ?? -1;
          const bAvg = getTeacherAvg(b.id, b.teacherId)?.avg ?? -1;
          if (aAvg !== bAvg) return filter.ratingSortAsc ? aAvg - bAvg : bAvg - aAvg;
        }
        return a.className.localeCompare(b.className);
      });
    const groups: FormalGroup[] = [];
    for (const [id, arr] of byId) {
      groups.push({ id, course: coursesById.get(id), sections: sortSections(arr) });
    }
    const groupKey = (g: FormalGroup): number => {
      if (filter.enrollmentSortAsc !== null) {
        const known = g.sections
          .map((s) => {
            const enrolled = liveEnrollment.getEnrollment(s);
            return enrolled == null || s.capacity == null ? null : s.capacity - enrolled;
          })
          .filter((value): value is number => value !== null);
        if (known.length === 0) return Number.NaN;
        return filter.enrollmentSortAsc ? Math.min(...known) : Math.max(...known);
      }
      if (filter.ratingSortAsc !== null) {
        return Math.max(...g.sections.map((s) => getTeacherAvg(s.id, s.teacherId)?.avg ?? -1));
      }
      return g.sections[0]?.credits ?? 0;
    };
    return groups.sort((a, b) => {
      const aKey = groupKey(a);
      const bKey = groupKey(b);
      if (Number.isNaN(aKey)) return Number.isNaN(bKey) ? 0 : 1;
      if (Number.isNaN(bKey)) return -1;
      const cmp = aKey - bKey;
      const asc = filter.enrollmentSortAsc !== null
        ? filter.enrollmentSortAsc
        : filter.ratingSortAsc !== null ? filter.ratingSortAsc : filter.sortAsc;
      return asc ? cmp : -cmp;
    });
  }, [visibleFormalSections, filter.sortAsc, filter.ratingSortAsc, filter.enrollmentSortAsc, getTeacherAvg, liveEnrollment.getEnrollment, coursesById, foldGroups]);

  // 正选/补退选独立分页，单位为「课程（组）」—— 一门课的所有班级不会被切到两页。
  // 每页 50 组；切换 dataSource / 学期 / 筛选时回到首页。
  const FORMAL_PAGE_SIZE = 50;
  const [formalPage, setFormalPage] = useState(1);
  useEffect(() => {
    setFormalPage(1);
  }, [dataSource, selectedSemester, filter.filters, schedule.filter]);
  const formalTotalPages = Math.max(1, Math.ceil(formalGroupsAll.length / FORMAL_PAGE_SIZE));
  const safeFormalPage = Math.min(formalPage, formalTotalPages);
  const paginatedFormalGroups = useMemo(
    () => formalGroupsAll.slice((safeFormalPage - 1) * FORMAL_PAGE_SIZE, safeFormalPage * FORMAL_PAGE_SIZE),
    [formalGroupsAll, safeFormalPage],
  );
  // 自动展开只适合「结果已经很窄」的场景；大结果集保持折叠，避免一次筛选挂载大量班级行导致主线程卡顿。
  const shouldAutoExpandFormal = hasNarrowingFilter
    && visibleFormalSections.length <= FORMAL_AUTO_EXPAND_SECTION_LIMIT
    && formalGroupsAll.length <= FORMAL_AUTO_EXPAND_GROUP_LIMIT;

  const [selected, setSelected] = useState<Course | null>(null);
  const [mobileCourse, setMobileCourse] = useState<Course | null>(null);
  // Formal fallback：当 section.id 在 catalog 中找不到匹配 Course 时承载详情。
  const [selectedSection, setSelectedSection] = useState<FormalSection | null>(null);
  const [mobileSection, setMobileSection] = useState<FormalSection | null>(null);
  // 仅用于正选/补退选行高亮：精确锁定具体班级（同一课程号可能有多个 section）
  const [selectedSectionKey, setSelectedSectionKey] = useState<string | null>(null);
  const closingRef = useRef(false);
  const [showMobileFilter, setShowMobileFilter] = useState(false);
  // 桌面左侧栏开合：>1280 默认展开；<=1280 自动收起。用户可在任意宽度手动折叠/展开。
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(
    typeof window !== "undefined" ? window.innerWidth > 1280 : true,
  );
  const [viewportW, setViewportW] = useState<number>(
    typeof window !== "undefined" ? window.innerWidth : 1920,
  );
  const headerRef = useRef<HTMLElement>(null);
  const [headerBottom, setHeaderBottom] = useState(0);

  // 视口 < 1700 时让左栏转抽屉，避免与右详情栏（始终预留 500px）共同把中央表格挤瘦
  const leftAsDrawer = sidebarOpen && viewportW < 1700;

  // 用户一旦「展开左栏」（折叠→展开的跳变）/ 打开移动筛选，筛选提醒就完成使命 → 收起。
  // 注意：宽屏左栏默认就是展开的，不能用 sidebarOpen 的稳态判断（否则提醒一出现就被秒关）——只认跳变。
  const prevSidebarOpenRef = useRef(sidebarOpen);
  useEffect(() => {
    const justOpened = !prevSidebarOpenRef.current && sidebarOpen;
    prevSidebarOpenRef.current = sidebarOpen;
    if (showFilterHint && (justOpened || showMobileFilter)) dismissFilterHint();
  }, [sidebarOpen, showMobileFilter, showFilterHint, dismissFilterHint]);

  useLayoutEffect(() => {
    const measure = () => {
      const next = headerRef.current?.getBoundingClientRect().bottom;
      if (next !== undefined) {
        setHeaderBottom((prev) => (Math.abs(prev - next) > 0.25 ? next : prev));
      }
    };
    measure();
    const frames = [
      window.requestAnimationFrame(measure),
      window.requestAnimationFrame(() => window.requestAnimationFrame(measure)),
    ];
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (headerRef.current) observer?.observe(headerRef.current);
    window.addEventListener("resize", measure);
    window.addEventListener("load", measure);
    if ("fonts" in document) {
      void document.fonts.ready.then(measure);
    }
    return () => {
      frames.forEach((frame) => window.cancelAnimationFrame(frame));
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("load", measure);
    };
  }, []);

  // 窗口缩到 1280 及以下时自动收起左栏；放大不自动展开（尊重用户的手动选择）
  useEffect(() => {
    const onResize = () => {
      setViewportW(window.innerWidth);
      if (window.innerWidth <= 1280) setSidebarOpen(false);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Body scroll lock when mobile filter / mobile course overlay / PC left drawer / 模拟选课引导弹窗 is open
  const onboardingOpen = sim.mode === "onboarding";
  useEffect(() => {
    if (showMobileFilter || mobileCourse || mobileSection || leftAsDrawer || onboardingOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = prev; };
    }
  }, [showMobileFilter, mobileCourse, mobileSection, leftAsDrawer, onboardingOpen]);

  // Back button closes mobile course/section overlay
  useEffect(() => {
    if (!mobileCourse && !mobileSection) return;
    const onPopState = () => { setMobileCourse(null); setMobileSection(null); };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [mobileCourse, mobileSection]);

  const handleSelect = (course: Course) => {
    // 与下面 aside `hidden xl:block` 的视口断点保持一致：>= 1280 才在右侧栏渲染详情，
    // 否则用全屏 overlay，避免在 1080~1280 这种"宽度不上不下"区间被双侧栏挤瘪
    if (window.innerWidth >= 1280) {
      setSelected(course);
      setSelectedSection(null);
    } else {
      if (closingRef.current) return;
      setMobileCourse(course);
      window.history.pushState({ courseId: course.id }, "", `/course/${course.id}`);
    }
  };

  // Formal/补退选 行点击：永远走 FormalSectionDetail（section-centric 单教师视图）。
  // 渲染处再用 courses.find lookup 把同课程号的 Course 当 prop 喂进去补齐 desc/plans/prereq。
  // useCallback 稳定引用 —— 作为 CourseTable rowProps 一员传给 memo 化的行组件，避免击穿 memo。
  const handleSelectSection = useCallback((s: FormalSection) => {
    setSelectedSectionKey(`${s.id}|${s.className}|${s.teacherId}`);
    if (window.innerWidth >= 1280) {
      setSelectedSection(s);
      setSelected(null);
    } else {
      if (closingRef.current) return;
      setMobileSection(s);
      window.history.pushState({ sectionId: s.id }, "", `/course/${s.id}`);
    }
  }, []);

  const closeMobileCourse = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    window.history.back();
    setTimeout(() => { closingRef.current = false; }, 400);
  };

  const handleQuickRatePreviousSemester = useCallback(() => {
    if (!quickRatingReady || !quickRatingSemester) return;
    if (quickRatingActive) {
      setQuickRatingActive(false);
      return;
    }
    filter.clearAll({ preservePlan: true });
    schedule.clear();
    setQuickRatingActive(true);
    setHintsDismissed(true);
    setDataSource("formal");
    setSemesterByDS((prev) => ({ ...prev, formal: quickRatingSemester }));
    filter.setRatingSortAsc(false);
    setFormalPage(1);
    setSelected(null);
    setSelectedSection(null);
    setSelectedSectionKey(null);
    setMobileCourse(null);
    setMobileSection(null);
    setShowMobileFilter(false);
    window.setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);
  }, [filter, quickRatingActive, quickRatingReady, quickRatingSemester, schedule]);

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-page">
        <div className="w-10 h-10 border-3 border-red-200 border-t-red-500 rounded-full animate-spin" />
        <p className="mt-4 text-gray-400 text-sm tracking-wide">正在加载课程数据...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-page px-4">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 max-w-md text-center">
          <h2 className="text-base font-semibold text-gray-800 mb-2">加载失败</h2>
          <p className="text-sm text-gray-400 mb-4">{error}</p>
          <p className="text-xs text-gray-300">
            请确保使用本地服务器运行：<br />
            <code className="bg-gray-50 px-2 py-1 rounded text-red-500">npm run dev</code>
          </p>
        </div>
      </div>
    );
  }

  const desktopContentOffset = 40;
  // 表格工具栏吸附到 header 真实底边，并和 header 交叠 2px，避免 sticky 亚像素取整露出背景缝。
  const stickySeamOverlap = 2;
  const headerStickyTop = Math.ceil(headerBottom > 0 ? headerBottom : 120);
  const stickyTop = headerStickyTop + desktopContentOffset;
  const tableStickyTop = Math.max(0, headerStickyTop - stickySeamOverlap);

  return (
    <div className="min-h-screen bg-page">
      {/* Header - two layers */}
      <header ref={headerRef} className="sticky top-0 z-40">
        {/* Layer 1: Red status bar —— relative z-10 让其底部投影盖在下方搜索行之上（见 index.css .bg-header） */}
        <div className="bg-header relative z-10">
          <div className="max-w-[2000px] mx-auto px-6 flex items-center justify-between py-2.5">
            <div className="flex items-center gap-2.5">
              <img src="/img/JXNUlogo.png" alt="JXNU" className="w-7 h-7 rounded-lg object-contain" />
              <h1 className="text-sm font-bold tracking-tight text-brand-fg">JXNU选课PLUS</h1>
              <span className="text-xs hidden sm:inline" style={{ color: "rgba(255,255,255,0.8)" }}>江西师范大学</span>
            </div>
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={handleQuickRatePreviousSemester}
                disabled={!quickRatingReady}
                title={quickRatingReady ? (quickRatingActive ? "取消只看上学期课程" : `评价 ${quickRatingSemester} 上学期课程`) : quickRatingDisabledReason}
                className={`md:hidden shrink-0 h-8 rounded-lg px-2.5 text-xs font-semibold inline-flex items-center gap-1.5 transition-colors ${
                  !quickRatingReady
                    ? "bg-white/10 text-white/45 cursor-not-allowed"
                    : quickRatingActive
                    ? "bg-white text-red-600"
                    : "bg-white/20 text-white hover:bg-white/30"
                }`}
              >
                <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3.5l2.6 5.3 5.9.9-4.3 4.2 1 5.9L12 17l-5.2 2.8 1-5.9-4.3-4.2 5.9-.9L12 3.5z" />
                </svg>
                <span>评价</span>
              </button>
              {/* 主题切换：桌面 / 手机统一放顶部红条右侧 */}
              <ThemeToggle />
              {/* 模拟选课开关：仅手机端 (<md) 显示（桌面端在搜索行）。 */}
              <button
                onClick={handleSimToggle}
                title={sim.mode === "sim" ? "关闭模拟选课" : "模拟选课"}
                className={`md:hidden relative shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                  sim.mode === "sim" ? "bg-white text-red-600" : "bg-white/20 text-white hover:bg-white/30"
                }`}
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" />
                  <path d="M1 1h4l2.7 13.4a2 2 0 002 1.6h9.7a2 2 0 002-1.6L23 6H6" />
                </svg>
                {cart.count > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-amber-400 text-red-900 text-[10px] font-bold flex items-center justify-center">
                    {cart.count}
                  </span>
                )}
              </button>
              {/* 漏斗按钮：仅手机端 (<md) 显示，打开右抽屉。PC 上由左侧专门的展开按钮控制。 */}
              <button
                ref={mobileFunnelRef}
                onClick={() => setShowMobileFilter(true)}
                title="筛选"
                className="md:hidden shrink-0 w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center hover:bg-white/30"
              >
                <svg className="w-4 h-4" style={{ color: "#FFFFFF" }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Layer 2: search bar */}
        <div className="bg-page md:bg-card">
          <div className="max-w-[2000px] mx-auto px-4 md:px-6 py-2 md:py-3 flex items-center gap-4">
            {/* Desktop search - centered */}
            <div className="hidden md:flex flex-1 justify-center">
              <div className="relative w-full max-w-3xl">
                <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  value={filter.filters.search}
                  onChange={(e) => filter.updateFilter("search", e.target.value)}
                  placeholder="搜索课程名称、学院、教师..."
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-gray-50 border border-gray-200 text-gray-800 placeholder-gray-300 text-sm outline-none focus:bg-white focus:border-red-300 focus:ring-2 focus:ring-red-50 transition-all"
                />
              </div>
            </div>

            {/* Result count：预选显示门数；正选/补退选显示班级数；未发布则给出文案 */}
            <div className="shrink-0 text-sm text-gray-400 whitespace-nowrap">
              {isFormalMode ? (
                formal.loading ? (
                  <span className="text-gray-400">加载中...</span>
                ) : !formal.available ? (
                  <span className="text-gray-400">{dataSource === "addDrop" ? "补退选" : "正选"}未发布</span>
                ) : (
                  <>
                    <span className="font-semibold text-gray-700">{visibleFormalSections.length}</span>
                    <span> 个班级</span>
                  </>
                )
              ) : (
                <>
                  <span className="font-semibold text-gray-700">{filter.filtered.length}</span>
                  <span> / {courses.length} 门</span>
                </>
              )}
            </div>

            {/* 模拟选课开关（桌面端） */}
            <div className="hidden md:flex shrink-0">
              <SimToggle mode={sim.mode} cartCount={cart.count} onClick={handleSimToggle} />
            </div>

            {/* Mobile search */}
            <div className="md:hidden flex-1 min-w-0">
              <div className="relative">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  value={filter.filters.search}
                  onChange={(e) => filter.updateFilter("search", e.target.value)}
                  placeholder="搜索课程、教师..."
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-gray-50 border border-gray-200 text-gray-800 placeholder-gray-300 text-sm outline-none focus:bg-white focus:border-red-300 transition-all"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="h-1 bg-gray-200" />
      </header>

      {/* Mobile filter drawer — always mounted, animated with translate */}
      <div
        className={`xl:hidden fixed inset-0 z-50 transition-opacity duration-300 ${showMobileFilter ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={() => setShowMobileFilter(false)}
      >
        <div className="absolute inset-0 bg-black/20 backdrop-blur-[2px]" />
        <div
          className={`absolute right-0 top-0 bottom-0 w-80 max-w-[85vw] bg-white overflow-y-auto shadow-2xl transition-transform duration-300 ease-out ${showMobileFilter ? "translate-x-0" : "translate-x-full"}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-800">筛选条件</h2>
            <button onClick={() => setShowMobileFilter(false)} className="p-1 text-gray-400 hover:text-gray-600">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="p-5 pb-8">
            {isFormalMode && (
              <div className="mb-5 pb-5 border-b border-gray-100">
                <ScheduleFilter
                  filter={schedule.filter}
                  cycleCell={schedule.cycleCell}
                  removeCell={schedule.removeCell}
                  clear={schedule.clear}
                  active={schedule.active}
                  cellCounts={scheduleCellCounts}
                  requiredCells={requiredCells}
                  showExcludeRequired={sim.mode === "sim"}
                  requiredExcluded={requiredExcluded}
                  onToggleExcludeRequired={toggleExcludeRequired}
                />
              </div>
            )}
            <FilterBar
              filters={filter.filters}
              updateFilter={filter.updateFilter}
              cycleCredit={filter.cycleCredit}
              cycleDept={filter.cycleDept}
              cycleType={filter.cycleType}
              cycleTag={filter.cycleTag}
              cycleArea={filter.cycleArea}
              cyclePlanFilter={filter.cyclePlanFilter}
              clearAll={clearAllFilters}
              hasActiveFilters={hasAnyActiveFilters}
              allDepts={allDepts}
              allCredits={allCredits}
              allPlans={allPlans}              courseTypes={courseTypes}
              subTags={subTags}
              simMode={sim.mode === "sim"}
              dataSource={dataSource}
              showRemainingFilter={liveEnrollment.status.enabled}
              foldGroups={foldGroups}
              onToggleFoldGroups={toggleFoldGroups}
            />
            <SidebarDisclaimer />
          </div>
        </div>
      </div>

      {/* PC 窄屏左侧抽屉：右详情打开 + 视口 < 1600 时启用，避免双内联栏挤瘦中央表格 */}
      <div
        className={`hidden md:block fixed inset-0 z-50 transition-opacity duration-300 ${leftAsDrawer ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={() => setSidebarOpen(false)}
      >
        <div className="absolute inset-0 bg-black/20 backdrop-blur-[2px]" />
        <div
          className={`absolute left-0 top-0 bottom-0 w-[360px] bg-white overflow-y-auto shadow-2xl transition-transform duration-300 ease-out ${leftAsDrawer ? "translate-x-0" : "-translate-x-full"}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-6 py-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium tracking-wider text-gray-400 uppercase">筛选</span>
              <button
                onClick={() => setSidebarOpen(false)}
                title="收起侧栏"
                className="p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                </svg>
              </button>
            </div>
            {isFormalMode && (
              <div className="mb-5 pb-5 border-b border-gray-100">
                <ScheduleFilter
                  filter={schedule.filter}
                  cycleCell={schedule.cycleCell}
                  removeCell={schedule.removeCell}
                  clear={schedule.clear}
                  active={schedule.active}
                  cellCounts={scheduleCellCounts}
                  requiredCells={requiredCells}
                  showExcludeRequired={sim.mode === "sim"}
                  requiredExcluded={requiredExcluded}
                  onToggleExcludeRequired={toggleExcludeRequired}
                />
              </div>
            )}
            <FilterBar
              filters={filter.filters}
              updateFilter={filter.updateFilter}
              cycleCredit={filter.cycleCredit}
              cycleDept={filter.cycleDept}
              cycleType={filter.cycleType}
              cycleTag={filter.cycleTag}
              cycleArea={filter.cycleArea}
              cyclePlanFilter={filter.cyclePlanFilter}
              clearAll={clearAllFilters}
              hasActiveFilters={hasAnyActiveFilters}
              allDepts={allDepts}
              allCredits={allCredits}
              allPlans={allPlans}              courseTypes={courseTypes}
              subTags={subTags}
              simMode={sim.mode === "sim"}
              dataSource={dataSource}
              showRemainingFilter={liveEnrollment.status.enabled}
              foldGroups={foldGroups}
              onToggleFoldGroups={toggleFoldGroups}
            />
            <SidebarDisclaimer />
          </div>
        </div>
      </div>

      {/* Mobile course detail overlay — slides up from bottom */}
      <div
        className={`xl:hidden fixed inset-0 z-50 transition-transform duration-300 ease-out ${(mobileCourse || mobileSection) ? "translate-y-0" : "translate-y-full"}`}
      >
        <div className="h-full bg-page overflow-y-auto">
          {mobileCourse ? (
            <CourseDetail
              course={mobileCourse}
              onClose={closeMobileCourse}
              simMode={sim.mode === "sim"}
              inCart={cart.has(mobileCourse.id)}
              onToggleCart={() => handleToggleCart(mobileCourse.id)}
              onRequestEnableSim={() => setEnableSimPrompt(true)}
            />
          ) : mobileSection ? (
            <FormalSectionDetail
              section={mobileSection}
              course={courses.find((c) => c.id === mobileSection.id)}
              onClose={closeMobileCourse}
              scheduleFilter={schedule.filter}
              simMode={sim.mode === "sim"}
              cartStatus={cartStatusOf(mobileSection)}
              onToggleCart={() => handleToggleCartSection(mobileSection)}
              onSwitchChosenSection={() => chosenSections.choose(mobileSection.id, `${mobileSection.className}|${mobileSection.teacherId}`)}
              onRequestEnableSim={() => setEnableSimPrompt(true)}
              enrolled={liveEnrollment.getEnrollment(mobileSection)}
              enrollmentStale={liveEnrollment.status.stale}
            />
          ) : null}
        </div>
      </div>

      {/* Main layout */}
      <div
        className="max-w-[2000px] mx-auto flex px-3 xl:px-6 pt-2 md:pt-10 gap-5"
        style={sim.mode === "sim" ? { paddingBottom: 32 } : undefined}
      >
        {/* PC 左侧"展开筛选"按钮：仅 ≥md 视口且左栏收起时显示 */}
        {!sidebarOpen && (
          <div ref={setLeftFilterEl} className="hidden md:flex w-9 shrink-0 justify-center">
            <button
              onClick={() => setSidebarOpen(true)}
              title="展开筛选"
              style={{ position: "sticky", top: stickyTop }}
              className="w-9 h-9 rounded-lg bg-white border border-gray-200 text-gray-500 hover:text-gray-800 hover:border-gray-300 transition-colors flex items-center justify-center shadow-sm self-start"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        )}
        {/* Desktop left sidebar — 由 sidebarOpen 控制；窗口 ≤1280 时自动收起；
            打开右详情且视口 < 1600 时改走抽屉模式（见下方 leftAsDrawer 渲染块） */}
        {sidebarOpen && !leftAsDrawer && (
          <aside
            ref={setLeftFilterEl}
            className="w-[360px] shrink-0 overflow-y-auto rounded-t-xl bg-white border border-gray-100 shadow-sm"
            style={{ position: "sticky", top: stickyTop, height: `calc(100vh - ${stickyTop}px)` }}
          >
            <div className="px-6 py-5">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-medium tracking-wider text-gray-400 uppercase">筛选</span>
                <button
                  onClick={() => setSidebarOpen(false)}
                  title="收起侧栏"
                  className="p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                  </svg>
                </button>
              </div>
              {isFormalMode && (
                <div className="mb-5 pb-5 border-b border-gray-100">
                  <ScheduleFilter
                    filter={schedule.filter}
                    cycleCell={schedule.cycleCell}
                    removeCell={schedule.removeCell}
                    clear={schedule.clear}
                    active={schedule.active}
                    cellCounts={scheduleCellCounts}
                    requiredCells={requiredCells}
                    showExcludeRequired={sim.mode === "sim"}
                    requiredExcluded={requiredExcluded}
                    onToggleExcludeRequired={toggleExcludeRequired}
                  />
                </div>
              )}
              <FilterBar
                filters={filter.filters}
                updateFilter={filter.updateFilter}
                cycleCredit={filter.cycleCredit}
                cycleDept={filter.cycleDept}
                cycleType={filter.cycleType}
                cycleTag={filter.cycleTag}
                cycleArea={filter.cycleArea}
                cyclePlanFilter={filter.cyclePlanFilter}
                clearAll={clearAllFilters}
                hasActiveFilters={hasAnyActiveFilters}
                allDepts={allDepts}
                allCredits={allCredits}
                allPlans={allPlans}                courseTypes={courseTypes}
                subTags={subTags}
                simMode={sim.mode === "sim"}
                dataSource={dataSource}
                showRemainingFilter={liveEnrollment.status.enabled}
                foldGroups={foldGroups}
                onToggleFoldGroups={toggleFoldGroups}
              />
              <SidebarDisclaimer />
            </div>
          </aside>
        )}

        {/* Center - course list */}
        <main className="flex-1 min-w-0">
          <CourseTable
            courses={filter.paginated}
            selectedId={selected?.id}
            onSelect={handleSelect}
            sortAsc={filter.sortAsc}
            setSortAsc={filter.setSortAsc}
            ratingSortAsc={filter.ratingSortAsc}
            setRatingSortAsc={filter.setRatingSortAsc}
            enrollmentSortAsc={filter.enrollmentSortAsc}
            setEnrollmentSortAsc={filter.setEnrollmentSortAsc}
            stickyTop={tableStickyTop}
            getCourseAvg={getCourseAvg}
            getTeacherAvg={getTeacherAvg}
            getEnrollment={liveEnrollment.getEnrollment}
            isEnrollmentChanged={liveEnrollment.isEnrollmentChanged}
            liveEnrollmentStatus={liveEnrollment.status}
            selectedPlan={filter.filters.plan}
            dataSource={dataSource}
            onChangeDataSource={(v) => {
              setDataSource(v);
              // 任意点击数据源 tab（含已选中的红色「正选」）都退出快速评价，回到正常列表。
              setQuickRatingActive(false);
            }}
            formalGroups={paginatedFormalGroups}
            defaultExpandFormal={shouldAutoExpandFormal}
            formalAvailable={formal.available}
            formalLoading={formal.loading}
            allSemesters={allSemesters}
            selectedSemester={selectedSemester}
            onChangeSemester={setSelectedSemester}
            onSelectSection={handleSelectSection}
            selectedSectionKey={selectedSectionKey}
            simMode={sim.mode === "sim"}
            cartHas={cart.has}
            onToggleCart={handleToggleCart}
            scheduleFilter={schedule.filter}
            coursesById={coursesById}
            showHints={showHints}
            onShowAll={() => { setHintsDismissed(true); maybeShowFilterHint(); }}
            onEnterSim={enterSim}
            sidebarOpen={sidebarOpen}
            onExpandSidebar={() => setSidebarOpen(true)}
            quickRatingSemester={quickRatingSemester}
            quickRatingReady={quickRatingReady}
            quickRatingActive={quickRatingActive}
            quickRatingCount={quickRatingSectionKeys.size}
            quickRatingDisabledReason={quickRatingDisabledReason}
            quickRatingSections={visibleFormalSections}
            onQuickRatePreviousSemester={handleQuickRatePreviousSemester}
          />
          {/* 分页：预选用 filter.page；正选/补退选有独立分页（数据集大不能一次性渲染）。
              功能说明层显示时（无筛选）隐藏分页。 */}
          {showHints || quickRatingActive ? null : isFormalMode ? (
            formal.available && visibleFormalSections.length > 0 && (
              <Pagination
                page={safeFormalPage}
                totalPages={formalTotalPages}
                onPageChange={(p) => {
                  setFormalPage(p);
                  setTimeout(() => {
                    window.scrollTo({ top: 0, behavior: "auto" });
                  }, 0);
                }}
              />
            )
          ) : (
            <Pagination
              page={filter.page}
              totalPages={filter.totalPages}
              onPageChange={(p) => {
                filter.setPage(p);
                setTimeout(() => {
                  window.scrollTo({ top: 0, behavior: "auto" });
                }, 0);
              }}
            />
          )}
        </main>

        {/* Desktop right sidebar - always visible */}
        <aside
          className="hidden xl:block w-[500px] shrink-0 overflow-y-auto rounded-t-xl bg-white border border-gray-100 shadow-[-8px_0_24px_rgba(0,0,0,0.04)]"
          style={{ position: "sticky", top: stickyTop, height: `calc(100vh - ${stickyTop}px)` }}
        >
          {selected ? (
            <CourseDetail
              course={selected}
              onClose={() => { setSelected(null); setSelectedSectionKey(null); }}
              simMode={sim.mode === "sim"}
              inCart={cart.has(selected.id)}
              onToggleCart={() => handleToggleCart(selected.id)}
              onRequestEnableSim={() => setEnableSimPrompt(true)}
            />
          ) : selectedSection ? (
            <FormalSectionDetail
              section={selectedSection}
              course={courses.find((c) => c.id === selectedSection.id)}
              onClose={() => { setSelectedSection(null); setSelectedSectionKey(null); }}
              scheduleFilter={schedule.filter}
              simMode={sim.mode === "sim"}
              cartStatus={cartStatusOf(selectedSection)}
              onToggleCart={() => handleToggleCartSection(selectedSection)}
              onSwitchChosenSection={() => chosenSections.choose(selectedSection.id, `${selectedSection.className}|${selectedSection.teacherId}`)}
              onRequestEnableSim={() => setEnableSimPrompt(true)}
              enrolled={liveEnrollment.getEnrollment(selectedSection)}
              enrollmentStale={liveEnrollment.status.stale}
            />
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-gray-400 px-8">
              <svg className="w-12 h-12 mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
              </svg>
              <p className="text-sm font-medium text-gray-500">点击课程查看详情</p>
              <p className="text-xs text-gray-400 mt-1">从左侧列表中选择一门课程</p>
            </div>
          )}
        </aside>
      </div>

      {/* 模拟选课：右下角悬浮圆环 + 展开面板 */}
      {sim.mode === "sim" && (
        <SimPanel
          view={credit.view}
          cartCourses={cartCourses}
          selectedPlan={filter.filters.plan}
          term={credit.term}
          formalSections={formal.sections}
          importedSchedule={credit.stored.importedSchedule}
          chosen={chosenSections.chosen}
          onChooseSection={chosenSections.choose}
          onRemove={handleToggleCart}
          onClear={cart.clear}
          onEditEarned={() => sim.openOnboarding()}
          onExpandSchedule={() => sim.openOnboarding(5, "sim")}
          onCancelRequired={credit.toggleExcludedRequired}
          onSelectCourse={handleSelect}
          onSelectSection={handleSelectSection}
          selectedCourseId={selectedSection?.id ?? selected?.id ?? mobileSection?.id ?? mobileCourse?.id ?? null}
          inputs={credit.stored as unknown as Record<string, unknown>}
          onApplyBundle={handleApplyBundle}
          showFutureRequired={credit.stored.showFutureRequired}
          setShowFutureRequired={credit.setShowFutureRequired}
          moocOffset={credit.stored.moocOffset}
          setMoocOffset={credit.setMoocOffset}
          competitionOffset={credit.stored.competitionOffset}
          setCompetitionOffset={credit.setCompetitionOffset}
        />
      )}

      {/* 模拟选课：引导弹窗 */}
      {sim.mode === "onboarding" && (
        <OnboardingModal
          selectedPlan={filter.filters.plan}
          allPlans={allPlans}
          onSelectPlan={(p) => filter.updateFilter("plan", p)}
          requirement={credit.requirement}
          view={credit.view}
          planCourses={planCourses.courses}
          cartCourses={cartCourses}
          formalSections={formal.sections}
          importedSchedule={credit.stored.importedSchedule}
          chosen={chosenSections.chosen}
          onChooseSection={chosenSections.choose}
          onRemoveCart={handleToggleCart}
          term={credit.term}
          totalEarned={credit.stored.totalEarned}
          electiveThisSem={credit.stored.electiveThisSem}
          takenMajorElectives={credit.stored.takenMajorElectives}
          excludedRequired={credit.stored.excludedRequired}
          importedDetailCourses={credit.stored.importedDetailCourses ?? []}
          setTotalEarned={credit.setTotalEarned}
          setElectiveThisSem={credit.setElectiveThisSem}
          toggleMajorElective={credit.toggleMajorElective}
          toggleExcludedRequired={credit.toggleExcludedRequired}
          toggleTransferOffset={credit.toggleTransferOffset}
          transferOffsetCids={credit.stored.transferOffsetCids}
          importInputs={credit.importInputs}
          coursesOf={planCourses.coursesOf}
          transferMode={credit.stored.transferMode}
          originalPlan={credit.stored.originalPlan}
          setTransferMode={credit.setTransferMode}
          setOriginalPlan={credit.setOriginalPlan}
          transferEarlyCids={credit.transferEarlyCids}
          showFutureRequired={credit.stored.showFutureRequired}
          setShowFutureRequired={credit.setShowFutureRequired}
          visitedMajorElective={credit.stored.visitedMajorElective}
          setVisitedMajorElective={credit.setVisitedMajorElective}
          onApplyBundle={handleApplyBundle}
          initialStep={sim.onboardingStep}
          onCancel={sim.cancelOnboarding}
          onFinish={handleOnboardingFinish}
        />
      )}

      {/* 一次性「左侧有筛选」提醒气泡（SimPanel 风格）：点「浏览全部」或走完模拟选课引导后弹一次。
          点击气泡 / 展开左栏 / 打开移动筛选 / 5s 后消失。 */}
      {showFilterHint && filterHintPos && (
        <div
          className={`fixed z-[60] transition-opacity duration-300 ${filterHintPos.dir === "up" ? "-translate-x-1/2" : ""}`}
          style={{ top: filterHintPos.top, left: filterHintPos.left }}
          onClick={dismissFilterHint}
        >
          {filterHintPos.dir === "up" && (
            <svg className="w-3 h-1.5 tip-dark-fill fill-current mx-auto block rotate-180 -mb-[1px]" viewBox="0 0 12 6">
              <path d="M0,0 C3,0 4.5,4.5 6,4.5 C7.5,4.5 9,0 12,0 Z" />
            </svg>
          )}
          <div className="px-3 py-1.5 rounded-full tip-dark text-white text-[11px] font-semibold shadow-lg whitespace-nowrap animate-bounce cursor-pointer">
            {filterHintPos.dir === "up" ? "课程筛选都在这里 ↑" : "← 课程筛选都在左侧"}
          </div>
        </div>
      )}

      {/* 加/移待选清单 toast */}
      {cartToast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[70] px-3 py-2 rounded-lg tip-dark text-white text-[12px] shadow-xl inline-flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          {cartToast}
        </div>
      )}

      {/* 加车软上限确认（公选课 / 任意选修 ≥ 2 门时弹出，替代 window.confirm）。
          ConfirmDialog 内部已含遮罩点击 + ESC 取消逻辑，关闭即视为「拒绝继续」。 */}
      <ConfirmDialog
        open={!!cartConfirm}
        title={cartConfirm?.title ?? ""}
        message={cartConfirm?.message}
        confirmText="仍要加入"
        cancelText="取消"
        onConfirm={() => {
          cartConfirm?.resolve(true);
          setCartConfirm(null);
        }}
        onCancel={() => {
          cartConfirm?.resolve(false);
          setCartConfirm(null);
        }}
      />

      {/* 详情页未开模拟选课时点「加入待选清单」→ 询问是否开启模拟选课。 */}
      <ConfirmDialog
        open={enableSimPrompt}
        title="模拟选课模式未开启"
        message="开启模拟选课后即可把课程加入待选清单，并模拟下学期课表与毕业学分核算。现在开启吗？"
        confirmText="开启模拟选课"
        cancelText="暂不"
        onConfirm={() => { setEnableSimPrompt(false); enterSim(); }}
        onCancel={() => setEnableSimPrompt(false)}
      />

      {/* 分享码自动恢复确认（替代 window.confirm）。 */}
      <ConfirmDialog
        open={!!bundlePrompt}
        title="检测到分享方案"
        message={bundlePrompt ? `导入方案「${bundlePrompt.plan}」（待选 ${bundlePrompt.cart.length} 门）？这会覆盖当前模拟选课数据。` : ""}
        confirmText="导入"
        cancelText="取消"
        onConfirm={() => { if (bundlePrompt) handleApplyBundle(bundlePrompt); setBundlePrompt(null); }}
        onCancel={() => setBundlePrompt(null)}
      />
    </div>
  );
}
