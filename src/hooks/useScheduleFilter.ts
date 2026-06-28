import { useState, useCallback, useEffect, useMemo } from "react";
import type { ScheduleFilterMap, CellState } from "../lib/scheduleParse";

// 课表时段筛选状态：每个格子三态循环（none → include → exclude → none）。
// 仅作用于正选/补退选（FormalSection）。sessionStorage 持久化。
// 按 scope 分别存（预选 / 正选 / 补退选 三种数据源各自独立，互不共享）。
const STORAGE_PREFIX = "jxnu_schedule_filter";
const storageKeyOf = (scope: string) => `${STORAGE_PREFIX}_${scope}`;

function load(key: string): ScheduleFilterMap {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw) return JSON.parse(raw) as ScheduleFilterMap;
  } catch {}
  return {};
}

export function useScheduleFilter(scope: string) {
  const key = storageKeyOf(scope);
  const [filter, setFilter] = useState<ScheduleFilterMap>(() => load(key));

  // scope 切换（用户在预选/正选/补退选 tab 间切换）→ 重新加载该 scope 的状态。
  useEffect(() => {
    setFilter(load(key));
  }, [key]);

  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(filter));
    } catch {}
  }, [key, filter]);

  const cycleCell = useCallback((day: number, slot: string) => {
    const cellKey = `${day},${slot}`;
    setFilter((prev) => {
      const cur = prev[cellKey];
      const next = { ...prev };
      if (!cur) next[cellKey] = "include";
      else if (cur === "include") next[cellKey] = "exclude";
      else delete next[cellKey];
      return next;
    });
  }, []);

  const removeCell = useCallback((day: number, slot: string) => {
    const cellKey = `${day},${slot}`;
    setFilter((prev) => {
      if (!prev[cellKey]) return prev;
      const next = { ...prev };
      delete next[cellKey];
      return next;
    });
  }, []);

  const clear = useCallback(() => setFilter({}), []);

  // 批量设置多个格子（一键排除必修课时段用）：state=null 删除这些格子，否则统一设为该状态。
  const setCells = useCallback((keys: string[], state: CellState | null) => {
    if (keys.length === 0) return;
    setFilter((prev) => {
      const next = { ...prev };
      for (const k of keys) {
        if (state === null) delete next[k];
        else next[k] = state;
      }
      return next;
    });
  }, []);

  const active = useMemo(() => Object.keys(filter).length > 0, [filter]);

  return { filter, cycleCell, removeCell, clear, active, setCells };
}
