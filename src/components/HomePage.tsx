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
import { sectionMatchesSchedule, parseSchedule } from "../lib/scheduleParse";
import { isInPlan, isAnyElective, displayTags } from "../lib/planMatch";
import { areasOf, sectionInArea } from "../lib/classroomArea";
import { decodeBundle, readCodeFromUrl, clearCodeFromUrl, type PlanBundle } from "../lib/planShare";
import { FilterBar } from "./FilterBar";
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
import type { Course, DataSource, FormalSection } from "../types";

const DATA_SOURCE_KEY = "jxnu_data_source";

function loadDataSource(): DataSource {
  // 默认进「正选」（学期由下方兜底 effect 落到最新 = 2026-09 测试）；
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

function GithubIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

/** 侧栏底部的浅灰说明文字（含内联 GitHub 链接），跟随筛选项滚动到底才会出现。 */
function SidebarDisclaimer() {
  return (
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
  // 方案课程清单懒加载（仅模拟选课开启时 fetch ~5MB）。
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

  const clearAllFilters = () => {
    filter.clearAll();
    schedule.clear();
  };
  const hasAnyActiveFilters = filter.hasActiveFilters || schedule.active;

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
      if (window.confirm(`检测到分享方案「${b.plan}」（待选 ${b.cart.length} 门），导入吗？`)) {
        handleApplyBundle(b);
      }
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
  //   - 正选 / 补退选 共用 formal.allSemesters，2026-09 加「（测试）」后缀。
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
    () => [...new Set(courses.map((c) => c.semester).filter((s) => /^\d{4}-(03|09)$/.test(s)))].sort(),
    [courses],
  );
  const allSemesters = dataSource === "pre" ? preSemesters : formal.allSemesters;
  const selectedSemester = semesterByDS[dataSource];

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

  const visibleFormalSections = useMemo(() => {
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
      // 培养方案硬过滤（仅 plan 非空时生效）：include 只看本方案、exclude 只看非本方案。
      if (f.plan && f.planFilter !== "none") {
        const c = coursesById.get(s.id);
        const inPlan = c ? isInPlan(c, f.plan) : false;
        if (f.planFilter === "include" && !inPlan) return false;
        if (f.planFilter === "exclude" && inPlan) return false;
      }
      // 隐藏已修课程（仅 sim 模式下生效，与 useCourseFilter 同口径）。
      if (f.hideTaken && sim.mode === "sim" && credit.takenCids.has(s.id)) return false;
      // 课表时段筛选（点格子三态）。无激活格子时直接放行。
      if (!sectionMatchesSchedule(s, schedule.filter)) return false;
      return true;
    });
  }, [formal.sections, selectedSemester, filter.filters, schedule.filter, coursesById, sim.mode, credit.takenCids]);

  // 课表每格班级数（当前学期，未经时段筛选）：用于网格内提示。
  const scheduleCellCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    if (!selectedSemester) return counts;
    for (const s of formal.sections) {
      if (s.semester !== selectedSemester) continue;
      for (const m of parseSchedule(s.schedule)) {
        const key = `${m.day},${m.slot}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    return counts;
  }, [formal.sections, selectedSemester]);

  // 正选/补退选的排序：复用预选的 sortAsc / ratingSortAsc 状态，行为一致。
  // 评分排序优先级高于学分；ratingSortAsc === null 时退回学分排序。
  // 评分用 section 教师的具体分（getTeacherAvg），与列表显示口径一致 —— 不能用课程平均（getCourseAvg），
  // 否则同课不同老师的几行排序会完全一样、且与单元格显示的星数对不上。
  const sortedFormalSections = useMemo(() => {
    return [...visibleFormalSections].sort((a, b) => {
      if (filter.ratingSortAsc !== null) {
        const aAvg = getTeacherAvg(a.id, a.teacherId)?.avg ?? -1;
        const bAvg = getTeacherAvg(b.id, b.teacherId)?.avg ?? -1;
        if (aAvg !== bAvg) return filter.ratingSortAsc ? aAvg - bAvg : bAvg - aAvg;
      }
      const cmp = a.credits - b.credits;
      return filter.sortAsc ? cmp : -cmp;
    });
  }, [visibleFormalSections, filter.sortAsc, filter.ratingSortAsc, getTeacherAvg]);

  const isFormalMode = dataSource !== "pre";

  // 正选/补退选独立分页 —— 5000+ 行一次渲染会把浏览器拖崩。
  // 每页 50 行，与预选保持一致；切换 dataSource / 学期时回到首页。
  const FORMAL_PAGE_SIZE = 50;
  const [formalPage, setFormalPage] = useState(1);
  useEffect(() => {
    setFormalPage(1);
  }, [dataSource, selectedSemester, filter.filters, schedule.filter]);
  const formalTotalPages = Math.max(1, Math.ceil(sortedFormalSections.length / FORMAL_PAGE_SIZE));
  const safeFormalPage = Math.min(formalPage, formalTotalPages);
  const paginatedFormalSections = useMemo(
    () => sortedFormalSections.slice((safeFormalPage - 1) * FORMAL_PAGE_SIZE, safeFormalPage * FORMAL_PAGE_SIZE),
    [sortedFormalSections, safeFormalPage],
  );

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

  // Body scroll lock when mobile filter / mobile course overlay / PC left drawer is open
  useEffect(() => {
    if (showMobileFilter || mobileCourse || mobileSection || leftAsDrawer) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = prev; };
    }
  }, [showMobileFilter, mobileCourse, mobileSection, leftAsDrawer]);

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
  const handleSelectSection = (s: FormalSection) => {
    setSelectedSectionKey(`${s.id}|${s.className}|${s.teacherId}`);
    if (window.innerWidth >= 1280) {
      setSelectedSection(s);
      setSelected(null);
    } else {
      if (closingRef.current) return;
      setMobileSection(s);
      window.history.pushState({ sectionId: s.id }, "", `/course/${s.id}`);
    }
  };

  const closeMobileCourse = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    window.history.back();
    setTimeout(() => { closingRef.current = false; }, 400);
  };

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
              {/* 主题切换：桌面 / 手机统一放顶部红条右侧 */}
              <ThemeToggle />
              {/* 模拟选课开关：仅手机端 (<md) 显示（桌面端在搜索行）。 */}
              <button
                onClick={sim.toggle}
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
              <SimToggle mode={sim.mode} cartCount={cart.count} onClick={sim.toggle} />
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
          <div className="hidden md:flex w-9 shrink-0 justify-center">
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
            stickyTop={tableStickyTop}
            getCourseAvg={getCourseAvg}
            getTeacherAvg={getTeacherAvg}
            selectedPlan={filter.filters.plan}
            dataSource={dataSource}
            onChangeDataSource={setDataSource}
            formalSections={paginatedFormalSections}
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
          />
          {/* 分页：预选用 filter.page；正选/补退选有独立分页（数据集大不能一次性渲染） */}
          {isFormalMode ? (
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
          chosen={chosenSections.chosen}
          onChooseSection={chosenSections.choose}
          onRemove={handleToggleCart}
          onClear={cart.clear}
          onEditEarned={sim.openOnboarding}
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
          chosen={chosenSections.chosen}
          onChooseSection={chosenSections.choose}
          onRemoveCart={handleToggleCart}
          term={credit.term}
          totalEarned={credit.stored.totalEarned}
          electiveThisSem={credit.stored.electiveThisSem}
          takenMajorElectives={credit.stored.takenMajorElectives}
          excludedRequired={credit.stored.excludedRequired}
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
          onCancel={sim.cancelOnboarding}
          onFinish={sim.finishOnboarding}
        />
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
    </div>
  );
}
