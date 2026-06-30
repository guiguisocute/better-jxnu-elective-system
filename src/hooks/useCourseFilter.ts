import { useState, useMemo, useCallback, useEffect } from "react";
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
  getCourseAvg?: (courseId: string) => number | null,
  takenCids?: Set<string>,
) {
  const saved = useMemo(() => loadSaved(), []);
  const [filters, setFilters] = useState<Filters>(saved.filters);

  const [sortAsc, setSortAsc] = useState(saved.sortAsc);
  const [ratingSortAsc, setRatingSortAsc] = useState<boolean | null>(null);
  const [page, setPage] = useState(saved.page);
  const [pageSize] = useState(50);

  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ filters, page, sortAsc }));
  }, [filters, page, sortAsc]);

  const updateFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  };

  // 三态循环：默认 → 选中 → 排除 → 默认
  const cycleCredit = useCallback((credit: number) => {
    setFilters((prev) => {
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
    setFilters((prev) => {
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
    setFilters((prev) => {
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
    setFilters((prev) => ({
      ...prev,
      planFilter: prev.planFilter === "include" ? "none" : "include",
    }));
    setPage(1);
  }, []);

  const cycleTag = useCallback((tag: string) => {
    setFilters((prev) => {
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
    setFilters((prev) => {
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
    setFilters((prev) => (opts?.preservePlan ? { ...EMPTY_FILTERS, plan: prev.plan } : EMPTY_FILTERS));
    setPage(1);
    if (!opts?.preservePlan) sessionStorage.removeItem(STORAGE_KEY);
  }, []);

  const filtered = useMemo(() => {
    let result = courses;
    const search = filters.search.toLowerCase();

    if (search) {
      result = result.filter((c) => c._search.includes(search));
    }
    if (filters.credits.length > 0) {
      result = result.filter((c) => filters.credits.includes(c.credits));
    }
    if (filters.creditsExclude.length > 0) {
      result = result.filter((c) => !filters.creditsExclude.includes(c.credits));
    }
    if (filters.dept.length > 0) {
      result = result.filter((c) => filters.dept.includes(c.dept));
    }
    if (filters.deptExclude.length > 0) {
      result = result.filter((c) => !filters.deptExclude.includes(c.dept));
    }
    // 选中培养方案时，tag/type 过滤必须基于「该课程在本方案下的有效 tag」，
    // 否则筛"专业限选"会撞到别的专业的限选课。
    const tagsOf = filters.plan
      ? (c: Course) => displayTags(c, filters.plan)
      : (c: Course) => c.tags;

    // 「任意选修」是虚拟类型：复用 planMatch.isAnyElective —— 与表格 tag 注入逻辑保持一致。
    const matchesType = (c: Course, t: string): boolean => {
      if (t === "任意选修") return isAnyElective(c, filters.plan);
      return tagsOf(c).includes(t);
    };

    if (filters.type.length > 0) {
      result = result.filter((c) => filters.type.some((t) => matchesType(c, t)));
    }
    if (filters.typeExclude.length > 0) {
      result = result.filter((c) => !filters.typeExclude.some((t) => matchesType(c, t)));
    }
    if (filters.tag.length > 0) {
      result = result.filter((c) => {
        const tags = tagsOf(c);
        return filters.tag.some((t) => tags.includes(t));
      });
    }
    if (filters.tagExclude.length > 0) {
      result = result.filter((c) => {
        const tags = tagsOf(c);
        return !filters.tagExclude.some((t) => tags.includes(t));
      });
    }
    // 培养方案默认仅软过滤（通过 tagsOf 影响 tag/type 过滤 + CourseTable 高亮）。
    // planFilter === "include"（胶囊开关开）→ 硬过滤为只看本方案的课程。
    if (filters.plan && filters.planFilter === "include") {
      result = result.filter((c) => isInPlan(c, filters.plan));
    }
    // 隐藏已修课程（仅 sim 模式 + 选了培养方案时才会被 HomePage 传入非空 takenCids）。
    if (filters.hideTaken && takenCids && takenCids.size > 0) {
      result = result.filter((c) => !takenCids.has(c.id));
    }

    result = [...result].sort((a, b) => {
      if (ratingSortAsc !== null && getCourseAvg) {
        const aAvg = getCourseAvg(a.id) ?? -1;
        const bAvg = getCourseAvg(b.id) ?? -1;
        if (aAvg !== bAvg) return ratingSortAsc ? aAvg - bAvg : bAvg - aAvg;
      }
      const cmp = a.credits - b.credits;
      return sortAsc ? cmp : -cmp;
    });

    return result;
  }, [courses, filters, sortAsc, ratingSortAsc, getCourseAvg, takenCids]);

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
    ratingSortAsc,
    setRatingSortAsc,
    hasActiveFilters,
  };
}
