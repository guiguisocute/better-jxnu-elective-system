// 左栏各筛选分组的展开/收起状态。
//
// 为什么要提到模块级而不是留在 FilterSection 的 useState 里：
// 左栏有三份 FilterBar（移动抽屉 / 宽屏内联 / 窄屏 PC 抽屉），布局条件一变
// React 就把其中一份卸载、另一份挂载。局部 state 随之全部丢失，用户看到的现象是
// 「点一下模拟选课开关，左栏所有分组的展开状态全被重置了」。
// 放模块级 + sessionStorage 后，三份实例共享同一份状态，重挂也不丢。
//
// 用 sessionStorage 而不是 localStorage：和这一侧其它筛选状态口径一致
// （见 useCourseFilter / useScheduleFilter），关掉标签页就回到默认。

type Listener = () => void;

const STORAGE_KEY = "jxnu_filter_section_collapse";

function load(): Record<string, boolean> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return {};
}

let state: Record<string, boolean> = load();
const listeners = new Set<Listener>();

function persist() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

export function subscribeSectionCollapse(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 返回该分组的显式状态；没记录过则 undefined，由调用方回落到默认值。 */
export function getSectionExpanded(label: string): boolean | undefined {
  return state[label];
}

export function setSectionExpanded(label: string, expanded: boolean) {
  if (state[label] === expanded) return;
  // 换新对象引用：useSyncExternalStore 的 getSnapshot 靠引用判等。
  state = { ...state, [label]: expanded };
  persist();
  for (const fn of listeners) fn();
}
