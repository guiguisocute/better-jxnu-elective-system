import { useState, useMemo, useCallback, useEffect, useDeferredValue } from "react";
import type { Course, Filters } from "../types";
import { displayTags, isInPlan, isAnyElective } from "../lib/planMatch";

const STORAGE_KEY = "jxnu_filters";

const EMPTY_FILTERS: Filters = {
  search: "",
  credits: [],
  creditsExclude: [],
  dept: [],
  deptExclude: [],
  type: [],
  typeExclude: [],
  tag: [],
  tagExclude: [],
  area: [],
  areaExclude: [],
  plan: "",
  planFilter: "none",
  hideTaken: false,
  remaining: "all",
};

function loadSaved(): { filters: Filters; page: number; sortAsc: boolean } {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      const filters: Filters = { ...EMPTY_FILTERS, ...saved.filters };
      // 归一化已废弃的 planFilter "exclude" 历史值 → "none"。
      if ((filters.planFilter as string) === "exclude") filters.planFilter = "none";
      // 旧版「余量充足」三态已收敛为一个「仅看有余量」开关。
      if ((filters.remaining as string) === "ample") filters.remaining = "available";
      return {
        filters,
        page: saved.page ?? 1,
        sortAsc: saved.sortAsc ?? true,
      };
    }
  } catch {}
  return { filters: EMPTY_FILTERS, page: 1, sortAsc: true };
}

export function useCourseFilter(
  courses: Course[],
  takenCids?: Set<string>,
) {
  const saved = useMemo(() => loadSaved(), []);
  // search 与其余筛选字段分开存：只有 search（打字高频）走 useDeferredValue，
  // 点击型筛选（学分/学院/类型/方案…）立即同步生效。
  // 之前整个 filters 对象都走 deferred —— 实时人数指示器等高频紧急 setState 会不断打断
  // 并重启 transition 渲染，deferred 值长期追不上，表现为「点了筛选列表不动、要 F5」。
  const [search, setSearch] = useState(saved.filters.search);
  const [restFilters, setRestFilters] = useState<Filters>(() => ({ ...saved.filters, search: "" }));
  const deferredSearch = useDeferredValue(search);

  // UI 绑定用的即时值（输入框/按钮高亮）。
  const filters = useMemo(() => ({ ...restFilters, search }), [restFilters, search]);
  // 重活（对 6000+ 课程/9000+ section 的过滤+排序）用它：非 search 字段即时、search 用 deferred。
  // 依赖只挂 restFilters + deferredSearch —— 打字期间引用稳定，不触发全量过滤。
  const deferredFilters = useMemo(
    () => ({ ...restFilters, search: deferredSearch }),
    [restFilters, deferredSearch],
  );

  const [sortAsc, setSortAsc] = useState(saved.sortAsc);
  const [enrollmentSortAsc, setEnrollmentSortAsc] = useState<boolean | null>(null);
  const [page, setPage] = useState(saved.page);
  const [pageSize] = useState(50);

  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ filters, page, sortAsc }));
  }, [filters, page, sortAsc]);

  const updateFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    if (key === "search") setSearch(value as string);
    else setRestFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  };

  // 三态循环：默认 → 选中 → 排除 → 默认
  const cycleCredit = useCallback((credit: number) => {
    setRestFilters((prev) => {
      const included = prev.credits.includes(credit);
      const excluded = prev.creditsExclude.includes(credit);
      if (!included && !excluded) {
        // 默认 → 选中
        return { ...prev, credits: [...prev.credits, credit] };
      } else if (included) {
        // 选中 → 排除
        return { ...prev, credits: prev.credits.filter((c) => c !== credit), creditsExclude: [...prev.creditsExclude, credit] };
      } else {
        // 排除 → 默认
        return { ...prev, creditsExclude: prev.creditsExclude.filter((c) => c !== credit) };
      }
    });
    setPage(1);
  }, []);

  const cycleDept = useCallback((dept: string) => {
    setRestFilters((prev) => {
      const included = prev.dept.includes(dept);
      const excluded = prev.deptExclude.includes(dept);
      if (!included && !excluded) {
        return { ...prev, dept: [...prev.dept, dept] };
      } else if (included) {
        return { ...prev, dept: prev.dept.filter((d) => d !== dept), deptExclude: [...prev.deptExclude, dept] };
      } else {
        return { ...prev, deptExclude: prev.deptExclude.filter((d) => d !== dept) };
      }
    });
    setPage(1);
  }, []);

  const cycleType = useCallback((type: string) => {
    setRestFilters((prev) => {
      const included = prev.type.includes(type);
      const excluded = prev.typeExclude.includes(type);
      if (!included && !excluded) {
        return { ...prev, type: [...prev.type, type] };
      } else if (included) {
        return { ...prev, type: prev.type.filter((t) => t !== type), typeExclude: [...prev.typeExclude, type] };
      } else {
        return { ...prev, typeExclude: prev.typeExclude.filter((t) => t !== type) };
      }
    });
    setPage(1);
  }, []);

  // 胶囊开关：none ↔ include（已去掉 exclude 态）。
  const cyclePlanFilter = useCallback(() => {
    setRestFilters((prev) => ({
      ...prev,
      planFilter: prev.planFilter === "include" ? "none" : "include",
    }));
    setPage(1);
  }, []);

  const cycleTag = useCallback((tag: string) => {
    setRestFilters((prev) => {
      const included = prev.tag.includes(tag);
      const excluded = prev.tagExclude.includes(tag);
      if (!included && !excluded) {
        return { ...prev, tag: [...prev.tag, tag] };
      } else if (included) {
        return { ...prev, tag: prev.tag.filter((t) => t !== tag), tagExclude: [...prev.tagExclude, tag] };
      } else {
        return { ...prev, tagExclude: prev.tagExclude.filter((t) => t !== tag) };
      }
    });
    setPage(1);
  }, []);

  const cycleArea = useCallback((area: string) => {
    setRestFilters((prev) => {
      const included = prev.area.includes(area);
      const excluded = prev.areaExclude.includes(area);
      if (!included && !excluded) {
        return { ...prev, area: [...prev.area, area] };
      } else if (included) {
        return { ...prev, area: prev.area.filter((a) => a !== area), areaExclude: [...prev.areaExclude, area] };
      } else {
        return { ...prev, areaExclude: prev.areaExclude.filter((a) => a !== area) };
      }
    });
    setPage(1);
  }, []);

  const clearAll = useCallback((opts?: { preservePlan?: boolean }) => {
    setSearch("");
    setRestFilters((prev) => (opts?.preservePlan ? { ...EMPTY_FILTERS, plan: prev.plan } : EMPTY_FILTERS));
    setPage(1);
    if (!opts?.preservePlan) sessionStorage.removeItem(STORAGE_KEY);
  }, []);

  const filtered = useMemo(() => {
    const f = deferredFilters;
    let result = courses;
    const search = f.search.toLowerCase();

    if (search) {
      result = result.filter((c) => c._search.includes(search));
    }
    if (f.credits.length > 0) {
      result = result.filter((c) => f.credits.includes(c.credits));
    }
    if (f.creditsExclude.length > 0) {
      result = result.filter((c) => !f.creditsExclude.includes(c.credits));
    }
    if (f.dept.length > 0) {
      result = result.filter((c) => f.dept.includes(c.dept));
    }
    if (f.deptExclude.length > 0) {
      result = result.filter((c) => !f.deptExclude.includes(c.dept));
    }
    // 选中培养方案时，tag/type 过滤必须基于「该课程在本方案下的有效 tag」，
    // 否则筛"专业限选"会撞到别的专业的限选课。
    const tagsOf = f.plan
      ? (c: Course) => displayTags(c, f.plan)
      : (c: Course) => c.tags;

    // 「任意选修」是虚拟类型：复用 planMatch.isAnyElective —— 与表格 tag 注入逻辑保持一致。
    const matchesType = (c: Course, t: string): boolean => {
      if (t === "任意选修") return isAnyElective(c, f.plan);
      return tagsOf(c).includes(t);
    };

    if (f.type.length > 0) {
      result = result.filter((c) => f.type.some((t) => matchesType(c, t)));
    }
    if (f.typeExclude.length > 0) {
      result = result.filter((c) => !f.typeExclude.some((t) => matchesType(c, t)));
    }
    if (f.tag.length > 0) {
      result = result.filter((c) => {
        const tags = tagsOf(c);
        return f.tag.some((t) => tags.includes(t));
      });
    }
    if (f.tagExclude.length > 0) {
      result = result.filter((c) => {
        const tags = tagsOf(c);
        return !f.tagExclude.some((t) => tags.includes(t));
      });
    }
    // 培养方案默认仅软过滤（通过 tagsOf 影响 tag/type 过滤 + CourseTable 高亮）。
    // planFilter === "include"（胶囊开关开）→ 硬过滤为只看本方案的课程。
    if (f.plan && f.planFilter === "include") {
      result = result.filter((c) => isInPlan(c, f.plan));
    }
    // 隐藏已修课程（仅 sim 模式 + 选了培养方案时才会被 HomePage 传入非空 takenCids）。
    if (f.hideTaken && takenCids && takenCids.size > 0) {
      result = result.filter((c) => !takenCids.has(c.id));
    }

    result = [...result].sort((a, b) => {
      const cmp = a.credits - b.credits;
      return sortAsc ? cmp : -cmp;
    });

    return result;
  }, [courses, deferredFilters, sortAsc, takenCids]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginated = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  const hasActiveFilters =
    filters.search !== "" ||
    filters.credits.length > 0 ||
    filters.creditsExclude.length > 0 ||
    filters.dept.length > 0 ||
    filters.deptExclude.length > 0 ||
    filters.type.length > 0 ||
    filters.typeExclude.length > 0 ||
    filters.tag.length > 0 ||
    filters.tagExclude.length > 0 ||
    filters.area.length > 0 ||
    filters.areaExclude.length > 0 ||
    filters.plan !== "" ||
    filters.hideTaken ||
    filters.remaining !== "all";

  return {
    filters,
    // 形参列表里给 HomePage 的正选/补退选过滤也用 deferred 值，和预选同口径不阻塞输入。
    deferredFilters,
    updateFilter,
    cycleCredit,
    cycleDept,
    cycleType,
    cycleTag,
    cycleArea,
    cyclePlanFilter,
    clearAll,
    filtered,
    paginated,
    page: safePage,
    setPage,
    totalPages,
    pageSize,
    sortAsc,
    setSortAsc,
    enrollmentSortAsc,
    setEnrollmentSortAsc,
    hasActiveFilters,
  };
}
