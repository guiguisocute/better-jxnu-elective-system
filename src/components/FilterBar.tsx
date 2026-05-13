import type { Filters } from "../types";

interface Props {
  filters: Filters;
  updateFilter: <K extends keyof Filters>(key: K, value: Filters[K]) => void;
  cycleCredit: (credit: number) => void;
  cycleDept: (dept: string) => void;
  cycleType: (type: string) => void;
  cycleTag: (tag: string) => void;
  clearAll: () => void;
  hasActiveFilters: boolean;
  allDepts: string[];
  allCredits: number[];
  courseTypes: string[];
  subTags: string[];
}

export function FilterBar({
  filters, updateFilter, cycleCredit, cycleDept, cycleType, cycleTag,
  clearAll, hasActiveFilters,
  allDepts, allCredits, courseTypes, subTags,
}: Props) {
  return (
    <div className="space-y-6">
      <FilterSection label="课程类型">
        <div className="flex flex-wrap gap-1.5">
          {courseTypes.map((t) => (
            <FilterBtn
              key={t}
              state={filters.type.includes(t) ? "include" : filters.typeExclude.includes(t) ? "exclude" : "none"}
              onClick={() => cycleType(t)}
            >{t}</FilterBtn>
          ))}
        </div>
      </FilterSection>

      <FilterSection label="学分">
        <div className="flex flex-wrap gap-1.5">
          {allCredits.map((c) => (
            <FilterBtn
              key={c}
              state={filters.credits.includes(c) ? "include" : filters.creditsExclude.includes(c) ? "exclude" : "none"}
              onClick={() => cycleCredit(c)}
            >{c}</FilterBtn>
          ))}
        </div>
      </FilterSection>

      <FilterSection label="开课学院">
        <div className="flex flex-wrap gap-1.5">
          {allDepts.map((d) => (
            <FilterBtn
              key={d}
              state={filters.dept.includes(d) ? "include" : filters.deptExclude.includes(d) ? "exclude" : "none"}
              onClick={() => cycleDept(d)}
            >{d}</FilterBtn>
          ))}
        </div>
      </FilterSection>

      {subTags.length > 0 && (
        <FilterSection label="标签">
          <div className="flex flex-wrap gap-1.5">
            {subTags.map((t) => (
              <FilterBtn
                key={t}
                state={filters.tag.includes(t) ? "include" : filters.tagExclude.includes(t) ? "exclude" : "none"}
                onClick={() => cycleTag(t)}
              >{t}</FilterBtn>
            ))}
          </div>
        </FilterSection>
      )}

      <FilterSection label="教师姓名">
        <input
          type="text"
          value={filters.teacher}
          onChange={(e) => updateFilter("teacher", e.target.value)}
          placeholder="输入姓名搜索"
          className="w-full px-3 py-2 rounded-lg bg-gray-50 border border-gray-200 text-sm text-gray-700 placeholder-gray-400 outline-none focus:bg-white focus:border-red-300 focus:ring-2 focus:ring-red-50 transition-all"
        />
      </FilterSection>

      {hasActiveFilters && (
        <button
          onClick={clearAll}
          className="w-full py-2 rounded-lg text-xs text-red-500 hover:text-red-600 hover:bg-red-50 transition-colors border border-red-200"
        >
          清除全部筛选
        </button>
      )}
    </div>
  );
}

function FilterSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] text-gray-500 font-medium mb-2.5 uppercase tracking-wider">{label}</div>
      {children}
    </div>
  );
}

function FilterBtn({ state, onClick, children }: {
  state: "none" | "include" | "exclude";
  onClick: () => void;
  children: React.ReactNode;
}) {
  let cls: string;
  if (state === "include") {
    cls = "bg-red-500 text-white shadow-sm shadow-red-200";
  } else if (state === "exclude") {
    cls = "bg-gray-200 text-gray-400 border border-gray-300 line-through decoration-gray-400";
  } else {
    cls = "bg-white text-gray-600 border border-gray-200 hover:border-gray-300 hover:text-gray-800 active:bg-gray-50";
  }

  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-medium transition-all min-h-[32px] select-none cursor-pointer ${cls}`}
    >
      {children}
    </button>
  );
}
