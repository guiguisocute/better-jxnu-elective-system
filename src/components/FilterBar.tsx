import type { Filters } from "../types";
import { PlanSelector } from "./PlanSelector";

interface Props {
  filters: Filters;
  updateFilter: <K extends keyof Filters>(key: K, value: Filters[K]) => void;
  cycleCredit: (credit: number) => void;
  cycleDept: (dept: string) => void;
  cycleType: (type: string) => void;
  cycleTag: (tag: string) => void;
  cyclePlanFilter: () => void;
  clearAll: () => void;
  hasActiveFilters: boolean;
  allDepts: string[];
  allCredits: number[];
  allPlans: string[];
  courseTypes: string[];
  subTags: string[];
}

export function FilterBar({
  filters, updateFilter, cycleCredit, cycleDept, cycleType, cycleTag, cyclePlanFilter,
  clearAll, hasActiveFilters,
  allDepts, allCredits, allPlans, courseTypes, subTags,
}: Props) {
  return (
    <div className="space-y-6">
      <FilterSection label="培养方案">
        <PlanSelector
          value={filters.plan}
          onChange={(v) => {
            updateFilter("plan", v);
            // 清空 plan 时同步复位 planFilter
            if (!v) updateFilter("planFilter", "none");
          }}
          options={allPlans}
        />
        {filters.plan && (
          <PlanFilterTriState state={filters.planFilter} onClick={cyclePlanFilter} />
        )}
      </FilterSection>

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

function PlanFilterTriState({ state, onClick }: { state: "none" | "include" | "exclude"; onClick: () => void }) {
  // 三态按钮：默认 → 仅本方案 → 排除本方案 → 默认
  const conf = {
    none: {
      cls: "bg-white text-indigo-600 border-indigo-200 hover:bg-indigo-50 hover:border-indigo-300",
      label: "仅查看本方案课程",
      hint: "未启用",
    },
    include: {
      cls: "bg-indigo-500 text-white border-indigo-500 shadow-sm shadow-indigo-200",
      label: "仅查看本方案课程",
      hint: "已启用",
    },
    exclude: {
      cls: "bg-gray-200 text-gray-500 border-gray-300 line-through decoration-gray-400",
      label: "仅查看本方案课程",
      hint: "排除本方案",
    },
  }[state];

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={state === "include"}
      title={`点击循环：未启用 → 仅本方案 → 排除本方案`}
      className={`mt-2 w-full inline-flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs font-medium border transition-all select-none cursor-pointer min-h-[36px] ${conf.cls}`}
    >
      <span>{conf.label}</span>
      <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wider ${
        state === "include" ? "text-white/80" : state === "exclude" ? "text-gray-500 no-underline" : "text-indigo-400"
      }`} style={state === "exclude" ? { textDecoration: "none" } : undefined}>
        {conf.hint}
      </span>
    </button>
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
