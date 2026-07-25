import { useState, useCallback, useEffect, useMemo } from "react";
import type { ScheduleFilterMap, CellState } from "../lib/scheduleParse";

// 课表时段筛选状态：每个格子三态循环（none → include → exclude → none）。
// 仅作用于正选/补退选（FormalSection）。sessionStorage 持久化。
// 按 scope 分别存（预选 / 正选与补退选共用入口，互不共享）。
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

  // scope 切换（用户在预选与正选/补退选 tab 间切换）→ 重新加载该 scope 的状态。
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

  // 整行/整列点击：与单格一样的三态循环，只是作用在一组格子上。
  // 判定用「整组是否已统一」而不是看某一格：整组 仅看 → 整组 排除 → 整组清除 → 再点回 仅看。
  // 混合状态（有的设了有的没设）一律先统一成「仅看」，这样一次点击的结果总是可预期的，
  // 不会出现「点了一下，部分格子变了、部分没变」。
  const cycleCells = useCallback((keys: string[]) => {
    if (keys.length === 0) return;
    setFilter((prev) => {
      const allInclude = keys.every((k) => prev[k] === "include");
      const allExclude = keys.every((k) => prev[k] === "exclude");
      const target: CellState | null = allInclude ? "exclude" : allExclude ? null : "include";
      const next = { ...prev };
      for (const k of keys) {
        if (target === null) delete next[k];
        else next[k] = target;
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => setFilter({}), []);

  // 批量设置多个格子（一键排除已选时段用）：state=null 删除这些格子，否则统一设为该状态。
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

  return { filter, cycleCell, cycleCells, removeCell, clear, active, setCells };
}
