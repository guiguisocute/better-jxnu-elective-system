import { useState, useRef, useEffect, type ReactElement } from "react";
import { useTheme, type ThemePref } from "../hooks/useTheme";

const OPTIONS: { value: ThemePref; label: string; icon: ReactElement }[] = [
  {
    value: "auto",
    label: "跟随系统",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path strokeLinecap="round" d="M8 20h8M12 16v4" />
      </svg>
    ),
  },
  {
    value: "light",
    label: "亮色",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
        <circle cx="12" cy="12" r="4" />
        <path strokeLinecap="round" d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
    ),
  },
  {
    value: "dark",
    label: "暗色",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    ),
  },
];

/**
 * 顶部主题切换：图标按钮 + 下拉三选项菜单。
 * 当前态用 pref（而非 resolved）决定显示哪个图标 —— auto 模式下显示电脑图标，
 * 让用户清楚自己锁定的是"跟随系统"而不是某个具体态。
 */
export function ThemeToggle() {
  const { pref, setPref } = useTheme();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const current = OPTIONS.find((o) => o.value === pref) ?? OPTIONS[0];

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={`主题：${current.label}`}
        aria-label="切换主题"
        aria-haspopup="menu"
        aria-expanded={open}
        className="shrink-0 w-7 h-7 rounded-lg bg-white/20 text-white flex items-center justify-center hover:bg-white/30 transition-colors"
      >
        {current.icon}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-2 w-36 rounded-lg bg-card border border-gray-100 shadow-lg overflow-hidden z-[60]"
        >
          {OPTIONS.map((opt) => {
            const active = opt.value === pref;
            return (
              <button
                key={opt.value}
                role="menuitemradio"
                aria-checked={active}
                onClick={() => { setPref(opt.value); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-[13px] text-left transition-colors ${
                  active
                    ? "bg-red-50 text-red-600"
                    : "text-gray-700 hover:bg-gray-50"
                }`}
              >
                <span className="shrink-0">{opt.icon}</span>
                <span className="flex-1">{opt.label}</span>
                {active && (
                  <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
