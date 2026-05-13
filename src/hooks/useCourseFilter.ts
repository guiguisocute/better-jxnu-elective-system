import { useState, useMemo, useCallback, useEffect } from "react";
import type { Course, Filters } from "../types";

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
  teacher: "",
};

function loadSaved(): { filters: Filters; page: number; sortAsc: boolean } {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      return {
        filters: { ...EMPTY_FILTERS, ...saved.filters },
        page: saved.page ?? 1,
        sortAsc: saved.sortAsc ?? true,
      };
    }
  } catch {}
  return { filters: EMPTY_FILTERS, page: 1, sortAsc: true };
}

export function useCourseFilter(courses: Course[]) {
  const saved = useMemo(() => loadSaved(), []);
  const [filters, setFilters] = useState<Filters>(saved.filters);

  const [sortBy, setSortBy] = useState<"credits">("credits");
  const [sortAsc, setSortAsc] = useState(saved.sortAsc);
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

  const clearAll = useCallback(() => {
    setFilters(EMPTY_FILTERS);
    setPage(1);
    sessionStorage.removeItem(STORAGE_KEY);
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
    if (filters.type.length > 0) {
      result = result.filter((c) => filters.type.some((t) => c.tags.includes(t)));
    }
    if (filters.typeExclude.length > 0) {
      result = result.filter((c) => !filters.typeExclude.some((t) => c.tags.includes(t)));
    }
    if (filters.tag.length > 0) {
      result = result.filter((c) => filters.tag.some((t) => c.tags.includes(t)));
    }
    if (filters.tagExclude.length > 0) {
      result = result.filter((c) => !filters.tagExclude.some((t) => c.tags.includes(t)));
    }
    if (filters.teacher) {
      const t = filters.teacher.toLowerCase();
      result = result.filter((c) =>
        c.teachers.some((tc) => tc.name.toLowerCase().includes(t))
      );
    }

    result = [...result].sort((a, b) => {
      const cmp = a.credits - b.credits;
      return sortAsc ? cmp : -cmp;
    });

    return result;
  }, [courses, filters, sortBy, sortAsc]);

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
    filters.teacher !== "";

  return {
    filters,
    updateFilter,
    cycleCredit,
    cycleDept,
    cycleType,
    cycleTag,
    clearAll,
    filtered,
    paginated,
    page: safePage,
    setPage,
    totalPages,
    pageSize,
    sortBy,
    setSortBy,
    sortAsc,
    setSortAsc,
    hasActiveFilters,
  };
}
