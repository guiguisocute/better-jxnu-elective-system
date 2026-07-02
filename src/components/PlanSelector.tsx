import { useState, useRef, useMemo, useEffect } from "react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  /** 挂载即展开浮层（内联编辑场景）。 */
  autoOpen?: boolean;
  /** 挂载时预填的搜索词（内联编辑时填专业名，把同专业各变体一次列出）。 */
  seedQuery?: string;
  /** 主题色：默认站点红；学号导入处传 indigo 与该功能配色统一。 */
  accent?: "red" | "indigo";
}

// 完整类名（Tailwind JIT 需扫到完整字符串，不能动态拼接）。
const ACCENT = {
  red: { focus: "focus:border-red-300 focus:ring-red-50", item: "bg-red-50 text-red-600" },
  indigo: { focus: "focus:border-indigo-300 focus:ring-indigo-50", item: "bg-indigo-50 text-indigo-600" },
} as const;

// 一次最多渲染的候选数：兜底超长列表的性能与「剩余项」提示（按年级拆分后单年级专业一般不会触顶）。
const MAX_VISIBLE = 200;

// 培养方案 key 形如「2025级-计算机科学与技术」，拆成年级 + 专业。
function parseKey(key: string): { year: string; major: string } | null {
  const m = key.match(/^(\d{4})级-(.+)$/);
  if (!m) return null;
  return { year: m[1], major: m[2] };
}

// 字符匹配度打分：完全相等 > 前缀 > 子串靠前 > 子串；长度越接近 query 越高。负无穷 = 不匹配。
function matchScore(option: string, q: string): number {
  const o = option.toLowerCase();
  const idx = o.indexOf(q);
  if (idx < 0) return -Infinity;
  let base: number;
  if (o === q) base = 1000;
  else if (o.startsWith(q)) base = 600;
  else base = 300 - idx;
  return base - (o.length - q.length) * 0.5;
}

/**
 * 培养方案选择器（年级下拉 + 专业可输入下拉，并列两段式）：
 * - 左侧年级 select（默认最新年级），年级渐增也不会撑开版面
 * - 右侧专业搜索框：聚焦展开该年级全部专业，可输入子串过滤
 * - 切换年级时若同名专业仍存在则沿用，否则清空待重选
 * - 对外仍以「年级-专业」字符串 value/onChange，调用方无需改动
 */
export function PlanSelector({ value, onChange, options, autoOpen = false, seedQuery, accent = "red" }: Props) {
  const a = ACCENT[accent];

  const { years, byYear } = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const opt of options) {
      const p = parseKey(opt);
      if (!p) continue;
      if (!map.has(p.year)) map.set(p.year, []);
      map.get(p.year)!.push(p.major);
    }
    for (const [, arr] of map) arr.sort((x, y) => x.localeCompare(y));
    const ys = [...map.keys()].sort((x, y) => y.localeCompare(x)); // 年级倒序（最新在前）
    return { years: ys, byYear: map };
  }, [options]);

  const [year, setYear] = useState<string>(() => {
    const p = parseKey(value);
    if (p) return p.year;
    let latest = "";
    for (const opt of options) {
      const pp = parseKey(opt);
      if (pp && pp.year > latest) latest = pp.year;
    }
    return latest;
  });
  const [query, setQuery] = useState(autoOpen && seedQuery ? seedQuery : (parseKey(value)?.major ?? ""));
  const [open, setOpen] = useState(autoOpen);
  const [yearOpen, setYearOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // 挂载带 seedQuery 时，首次（自动）聚焦不要清空搜索词。
  const seededRef = useRef(autoOpen && !!seedQuery);

  // 挂载即展开（内联编辑）：聚焦输入框，方便直接搜索/改。
  useEffect(() => {
    if (autoOpen) inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // options 异步到达后，若尚无年级选中且未带 value，默认选最新年级。
  useEffect(() => {
    if (!year && years.length > 0 && !parseKey(value)) setYear(years[0]);
  }, [years, year, value]);

  // 浮层关闭时，输入框与年级回落到当前 value（未选则空）。
  useEffect(() => {
    if (open) return;
    const p = parseKey(value);
    setQuery(p ? p.major : "");
    if (p) setYear(p.year);
  }, [value, open]);

  // ?? [] 的兜底空数组要 memo 化：否则未命中年份时每次 render 都换引用，击穿下游 useMemo。
  const majorsForYear = useMemo(() => byYear.get(year) ?? [], [byYear, year]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return majorsForYear.slice(0, MAX_VISIBLE);
    return majorsForYear
      .map((o) => [o, matchScore(o, q)] as const)
      .filter(([, s]) => s > -Infinity)
      .sort((x, y) => y[1] - x[1])
      .slice(0, MAX_VISIBLE)
      .map(([o]) => o);
  }, [query, majorsForYear]);

  const totalMatched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return majorsForYear.length;
    return majorsForYear.filter((o) => o.toLowerCase().includes(q)).length;
  }, [query, majorsForYear]);

  // 当前已选专业（仅当 value 的年级与选中年级一致时高亮）。
  const sel = parseKey(value);
  const selectedMajor = sel && sel.year === year ? sel.major : "";

  // 点外面关闭浮层（年级 / 专业两个下拉共用）
  useEffect(() => {
    if (!open && !yearOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setYearOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, yearOpen]);

  function commit(major: string) {
    if (!year) return;
    onChange(`${year}级-${major}`);
    setQuery(major);
    setOpen(false);
    inputRef.current?.blur();
  }

  function clearMajor() {
    onChange("");
    setQuery("");
    setOpen(false);
  }

  function pickYear(y: string) {
    setYear(y);
    setYearOpen(false);
    setActiveIdx(0);
    const p = parseKey(value);
    if (p && (byYear.get(y) ?? []).includes(p.major)) {
      // 同名专业在新年级也存在 → 直接切换
      onChange(`${y}级-${p.major}`);
      setQuery(p.major);
    } else {
      // 新年级没有该专业 → 清空已选，展开专业下拉等待重选
      if (value) onChange("");
      setQuery("");
      setOpen(true);
      inputRef.current?.focus();
    }
  }

  function handleFocus() {
    setOpen(true);
    setYearOpen(false);
    setActiveIdx(0);
    if (seededRef.current) {
      seededRef.current = false; // 保留首个 seedQuery
      return;
    }
    setQuery(""); // 聚焦即清空搜索词，列出该年级全部专业，方便浏览/切换
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (open && filtered[activeIdx]) {
        e.preventDefault();
        commit(filtered[activeIdx]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex items-stretch gap-2">
        {/* 年级下拉（自定义，与专业下拉同主题） */}
        <div className="relative shrink-0 w-28">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setYearOpen((v) => !v);
            }}
            disabled={years.length === 0}
            aria-haspopup="listbox"
            aria-expanded={yearOpen}
            aria-label="年级"
            className={`w-full pl-3 pr-7 py-2 rounded-lg bg-gray-50 border border-gray-200 text-sm text-left outline-none cursor-pointer focus:bg-white focus:ring-2 transition-all disabled:opacity-60 disabled:cursor-not-allowed ${a.focus} ${year ? "text-gray-700" : "text-gray-400"}`}
          >
            {year ? `${year}级` : "年级"}
          </button>
          <svg
            className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 transition-transform ${yearOpen ? "rotate-180" : ""}`}
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>

          {yearOpen && years.length > 0 && (
            <div role="listbox" className="absolute left-0 right-0 top-full mt-1 max-h-72 overflow-y-auto rounded-lg bg-white border border-gray-200 shadow-lg z-50">
              {years.map((y) => (
                <button
                  key={y}
                  type="button"
                  role="option"
                  aria-selected={y === year}
                  onClick={() => pickYear(y)}
                  className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                    y === year ? `${a.item} font-semibold` : "text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  {y}级
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 专业可输入下拉 */}
        <div className="relative flex-1 min-w-0">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
              setActiveIdx(0);
            }}
            onFocus={handleFocus}
            onKeyDown={onKeyDown}
            placeholder={year ? "搜索 / 选择专业" : "请先选择年级"}
            disabled={!year}
            className={`w-full pl-3 pr-8 py-2 rounded-lg bg-gray-50 border border-gray-200 text-sm text-gray-700 placeholder-gray-400 outline-none focus:bg-white focus:ring-2 transition-all disabled:opacity-60 disabled:cursor-not-allowed ${a.focus}`}
          />
          {selectedMajor ? (
            <button
              type="button"
              onClick={clearMajor}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
              aria-label="清空专业选择"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          ) : (
            <svg
              className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400"
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          )}

          {open && year && (
            <div className="absolute left-0 right-0 top-full mt-1 max-h-72 overflow-y-auto rounded-lg bg-white border border-gray-200 shadow-lg z-50">
              {filtered.length === 0 ? (
                <div className="px-3 py-3 text-xs text-gray-400">该年级无匹配专业</div>
              ) : (
                <>
                  {filtered.map((opt, i) => (
                    <button
                      key={opt}
                      type="button"
                      onMouseEnter={() => setActiveIdx(i)}
                      onClick={() => commit(opt)}
                      className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                        i === activeIdx ? a.item : "text-gray-700 hover:bg-gray-50"
                      } ${opt === selectedMajor ? "font-semibold" : ""}`}
                    >
                      {opt}
                    </button>
                  ))}
                  {totalMatched > MAX_VISIBLE && (
                    <div className="sticky bottom-0 px-3 py-2 text-[11px] text-gray-500 bg-gray-50 border-t border-gray-100">
                      已显示前 {MAX_VISIBLE} 项，还有 {totalMatched - MAX_VISIBLE} 项未显示 · 输入更多文字以缩小范围…
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
