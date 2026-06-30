import { useState, useCallback } from "react";

// 模拟选课周课表「选班」：记录每门课用户选定的逻辑班级 key（有 bjh 时按班级号，否则班级名+教号）。
// 仅覆盖默认（表格顺序第一个命中）；localStorage 持久化，key 按 cid。
const KEY = "jxnu.sim.chosenSections";

function load(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

export function useChosenSections() {
  const [chosen, setChosen] = useState<Record<string, string>>(load);

  const choose = useCallback((cid: string, optionKey: string) => {
    setChosen((prev) => {
      const next = { ...prev, [cid]: optionKey };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  // 整体替换（方案分享码恢复用）。传 {} 即清空。
  const replaceAll = useCallback((map: Record<string, string>) => {
    setChosen(() => {
      try { localStorage.setItem(KEY, JSON.stringify(map)); } catch {}
      return map;
    });
  }, []);

  return { chosen, choose, replaceAll };
}
