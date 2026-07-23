import { useEffect, useMemo, useState } from "react";
import type { FormalSection } from "../types";

// 正选 / 补退选共用同一份课表和同一个前端入口。
export function useFormalData() {
  const [sections, setSections] = useState<FormalSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/formal_sections.json")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: FormalSection[]) => {
        if (cancelled) return;
        setSections(data);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const available = !loading && !error && sections.length > 0;
  // 降序：最近的学期排在最上（下拉框首项）。YYYY-MM 字典序 == 时间序。
  const allSemesters = useMemo(
    () => [...new Set(sections.map((s) => s.semester).filter(Boolean))].sort((a, b) => b.localeCompare(a)),
    [sections],
  );
  return { sections, loading, error, available, allSemesters };
}
