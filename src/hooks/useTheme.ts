import { useEffect, useState, useCallback } from "react";

export type ThemePref = "auto" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "jxnu_theme";
// 同标签页多组件同步用的自定义事件：storage 事件只跨标签页触发，本标签页内需自己广播。
const THEME_CHANGE_EVENT = "jxnu_theme_change";

function readPref(): ThemePref {
  if (typeof window === "undefined") return "auto";
  // 隐私模式 / 禁用本地存储时访问 localStorage 会抛 SecurityError，兜底避免整个应用崩溃。
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" || v === "auto" ? v : "auto";
  } catch {
    return "auto";
  }
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolve(pref: ThemePref): ResolvedTheme {
  if (pref === "auto") return systemPrefersDark() ? "dark" : "light";
  return pref;
}

/** 写 <html class="dark"> 与 data-theme，供 CSS 与 echarts/inline 样式读取。
 *  同时同步 inline background-color —— 与 index.html 防 FOUC 脚本同口径(#0D1117 / #F8F9FA)；
 *  否则切换主题后那段 inline 样式残留旧值，橡皮筋滚动 / 短页面时会露出不一致的底色。 */
function applyDom(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.dataset.theme = resolved;
  root.style.backgroundColor = resolved === "dark" ? "#0D1117" : "#F8F9FA";
}

/** 广播主题变更，让同标签页内其它 useTheme 实例同步。 */
function broadcast(pref: ThemePref) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ThemePref>(THEME_CHANGE_EVENT, { detail: pref }));
}

/**
 * 主题三态：auto / light / dark。
 * - 持久化到 localStorage["jxnu_theme"]，默认 auto
 * - auto 模式实时跟随系统 prefers-color-scheme
 * - 跨标签页同步（storage 事件）+ 同标签页多组件同步（自定义事件）
 *
 * 首屏防闪烁靠 index.html 的内联脚本预先设置 .dark class —— 这里只负责后续切换。
 */
export function useTheme() {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(readPref()));

  useEffect(() => {
    const next = resolve(pref);
    setResolved(next);
    applyDom(next);
    try {
      localStorage.setItem(STORAGE_KEY, pref);
    } catch {
      /* 隐私模式下写入失败：忽略，主题在本次会话内仍生效 */
    }
  }, [pref]);

  // 系统主题变化（仅 auto 模式下生效）
  useEffect(() => {
    if (pref !== "auto") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const next: ResolvedTheme = mq.matches ? "dark" : "light";
      setResolved(next);
      applyDom(next);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  // 同标签页多组件同步：监听自定义事件（用函数式更新，避免闭包里的 pref 过期）
  useEffect(() => {
    const onThemeChange = (e: Event) => {
      const next = (e as CustomEvent<ThemePref>).detail;
      setPrefState((cur) => (next !== cur ? next : cur));
    };
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
  }, []);

  // 跨标签页同步：监听 storage 事件
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return;
      if (e.newValue === "light" || e.newValue === "dark" || e.newValue === "auto") {
        setPrefState(e.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setPref = useCallback((p: ThemePref) => {
    setPrefState(p);
    broadcast(p);
  }, []);

  return { pref, resolved, setPref };
}
