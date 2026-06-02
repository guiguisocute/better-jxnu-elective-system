import { useState } from "react";
import type { DataSource, Filters } from "../types";
import { PlanSelector } from "./PlanSelector";
import { AREA_GROUPS } from "../lib/classroomArea";

const ANY_ELECTIVE = "任意选修";
const ANY_ELECTIVE_HINT_ENABLED = "除本方案外可作为任选的课程（不含公选课）";
const ANY_ELECTIVE_HINT_DISABLED = "需先选择培养方案才能启用";

interface Props {
  filters: Filters;
  updateFilter: <K extends keyof Filters>(key: K, value: Filters[K]) => void;
  cycleCredit: (credit: number) => void;
  cycleDept: (dept: string) => void;
  cycleType: (type: string) => void;
  cycleTag: (tag: string) => void;
  cycleArea: (area: string) => void;
  cyclePlanFilter: () => void;
  clearAll: () => void;
  hasActiveFilters: boolean;
  allDepts: string[];
  allCredits: number[];
  allPlans: string[];
  courseTypes: string[];
  subTags: string[];
  /** 模拟选课已开启 —— 「隐藏已修课程」开关只有在此态下才亮起。 */
  simMode: boolean;
  /** 当前数据源 —— 上课区域筛选仅在正选/补退选生效，预选时整段隐藏。 */
  dataSource: DataSource;
  /** 同课程号折叠开关（仅正选/补退选显示）。默认开启；关闭回退扁平模式。 */
  foldGroups?: boolean;
  onToggleFoldGroups?: () => void;
}

export function FilterBar({
  filters, updateFilter, cycleCredit, cycleDept, cycleType, cycleTag, cycleArea, cyclePlanFilter,
  clearAll, hasActiveFilters,
  allDepts, allCredits, allPlans, courseTypes, subTags, simMode, dataSource,
  foldGroups = true, onToggleFoldGroups,
}: Props) {
  // 「任意选修」在 plan 为空时禁用，点击时短暂显示内联提示
  const [anyHint, setAnyHint] = useState(false);
  const [hideTakenHint, setHideTakenHint] = useState(false);
  const planActive = !!filters.plan;

  const handleAnyElectiveClick = () => {
    if (!planActive) {
      setAnyHint(true);
      window.setTimeout(() => setAnyHint(false), 2500);
      return;
    }
    cycleType(ANY_ELECTIVE);
  };

  return (
    <div className="space-y-6">
      <FilterSection
        label="培养方案"
        activeCount={(filters.plan ? 1 : 0) + (filters.planFilter !== "none" ? 1 : 0) + (filters.hideTaken ? 1 : 0)}
        onClear={() => {
          if (filters.plan) updateFilter("plan", "");
          if (filters.planFilter !== "none") updateFilter("planFilter", "none");
          if (filters.hideTaken) updateFilter("hideTaken", false);
          if (filters.type.includes(ANY_ELECTIVE)) updateFilter("type", filters.type.filter((x) => x !== ANY_ELECTIVE));
          if (filters.typeExclude.includes(ANY_ELECTIVE)) updateFilter("typeExclude", filters.typeExclude.filter((x) => x !== ANY_ELECTIVE));
        }}
      >
        <PlanSelector
          value={filters.plan}
          onChange={(v) => {
            updateFilter("plan", v);
            // 清空 plan 时复位相关派生筛选项
            if (!v) {
              updateFilter("planFilter", "none");
              if (filters.type.includes(ANY_ELECTIVE)) {
                updateFilter("type", filters.type.filter((x) => x !== ANY_ELECTIVE));
              }
              if (filters.typeExclude.includes(ANY_ELECTIVE)) {
                updateFilter("typeExclude", filters.typeExclude.filter((x) => x !== ANY_ELECTIVE));
              }
            }
          }}
          options={allPlans}
        />
        {filters.plan && (
          <PlanOnlyToggle active={filters.planFilter === "include"} onClick={cyclePlanFilter} />
        )}
        <HideTakenToggle
          enabled={simMode}
          active={filters.hideTaken}
          onClick={() => {
            if (!simMode) {
              setHideTakenHint(true);
              window.setTimeout(() => setHideTakenHint(false), 2500);
              return;
            }
            updateFilter("hideTaken", !filters.hideTaken);
          }}
        />
        {hideTakenHint && (
          <p className="mt-2 text-[11px] text-red-500 leading-relaxed">
            「隐藏已修课程」需先开启模拟选课
          </p>
        )}
      </FilterSection>

      <FilterSection
        label="课程类型"
        activeCount={filters.type.length + filters.typeExclude.length}
        onClear={() => {
          updateFilter("type", []);
          updateFilter("typeExclude", []);
        }}
      >
        <div className="flex flex-wrap gap-1.5">
          {courseTypes.map((t) => {
            if (t === ANY_ELECTIVE) {
              return (
                <FilterBtn
                  key={t}
                  state={filters.type.includes(t) ? "include" : filters.typeExclude.includes(t) ? "exclude" : "none"}
                  onClick={handleAnyElectiveClick}
                  disabled={!planActive}
                  title={planActive ? ANY_ELECTIVE_HINT_ENABLED : ANY_ELECTIVE_HINT_DISABLED}
                >
                  {t}
                </FilterBtn>
              );
            }
            return (
              <FilterBtn
                key={t}
                state={filters.type.includes(t) ? "include" : filters.typeExclude.includes(t) ? "exclude" : "none"}
                onClick={() => cycleType(t)}
              >{t}</FilterBtn>
            );
          })}
        </div>
        {anyHint && (
          <p className="mt-2 text-[11px] text-red-500 leading-relaxed">
            「任意选修」需先在上方选择培养方案
          </p>
        )}
      </FilterSection>

      <FilterSection
        label="学分"
        activeCount={filters.credits.length + filters.creditsExclude.length}
        onClear={() => {
          updateFilter("credits", []);
          updateFilter("creditsExclude", []);
        }}
      >
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

      {subTags.length > 0 && (
        <FilterSection
          label="标签"
          activeCount={filters.tag.length + filters.tagExclude.length}
          onClear={() => {
            updateFilter("tag", []);
            updateFilter("tagExclude", []);
          }}
        >
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

      {dataSource !== "pre" && (
        <FilterSection
          label="上课区域"
          collapsible
          defaultCollapsed
          activeCount={filters.area.length + filters.areaExclude.length}
          onClear={() => {
            updateFilter("area", []);
            updateFilter("areaExclude", []);
          }}
        >
          <div className="space-y-3">
            {AREA_GROUPS.map((g) => (
              <div key={g.campus ?? "_misc"}>
                {g.campus && (
                  <div className="flex items-center gap-1 mb-1.5 text-[10px] font-semibold text-gray-400">
                    <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z" />
                    </svg>
                    {g.campus}
                  </div>
                )}
                <div className={`flex flex-wrap gap-1.5 ${g.campus ? "pl-2.5 border-l border-gray-200" : ""}`}>
                  {g.items.map((it) => (
                    <FilterBtn
                      key={it.value}
                      state={filters.area.includes(it.value) ? "include" : filters.areaExclude.includes(it.value) ? "exclude" : "none"}
                      onClick={() => cycleArea(it.value)}
                    >{it.label}</FilterBtn>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </FilterSection>
      )}

      <FilterSection
        label="开课学院"
        collapsible
        defaultCollapsed
        activeCount={filters.dept.length + filters.deptExclude.length}
        onClear={() => {
          updateFilter("dept", []);
          updateFilter("deptExclude", []);
        }}
      >
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

      {/* 同课程号折叠开关（仅正选/补退选）：默认开启，关闭回退「一行一个班级」。放在开课学院下方。 */}
      {dataSource !== "pre" && onToggleFoldGroups && (
        <FoldGroupsToggle active={foldGroups} onClick={onToggleFoldGroups} />
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

function FilterSection({
  label,
  children,
  collapsible = false,
  defaultCollapsed = false,
  activeCount = 0,
  peekHeight = 100,
  onClear,
}: {
  label: string;
  children: React.ReactNode;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  /** 折叠时若 >0 会在标题旁显示徽标，提示该分组仍有生效筛选。 */
  activeCount?: number;
  /** 折叠态露出的高度（px）；超出部分被底部渐变遮挡。 */
  peekHeight?: number;
  /** 该分组的"清空"回调；activeCount > 0 时在标题右侧出现小按钮。 */
  onClear?: () => void;
}) {
  const [expanded, setExpanded] = useState(!(collapsible && defaultCollapsed));

  const header = (
    <div className="flex items-center justify-between mb-2.5">
      <div className="flex items-center gap-1.5 text-[11px] text-gray-500 font-medium uppercase tracking-wider">
        {label}
        {activeCount > 0 && (
          <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold normal-case tracking-normal">
            {activeCount}
          </span>
        )}
      </div>
      {onClear && activeCount > 0 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClear(); }}
          title={`清空「${label}」`}
          className="text-[11px] normal-case tracking-normal text-gray-400 hover:text-rose-500 transition-colors"
        >
          清空
        </button>
      )}
    </div>
  );

  if (!collapsible) {
    return (
      <div>
        {header}
        {children}
      </div>
    );
  }

  return (
    <div>
      {header}
      {/* 渐变遮挡式折叠：折叠态裁剪到 peekHeight，底部白→透明渐变暗示「下面还有」 */}
      <div className="relative">
        <div className="overflow-hidden" style={expanded ? undefined : { maxHeight: peekHeight }}>
          {children}
        </div>
        {!expanded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-white via-white/85 dark:from-[#161B22] dark:via-[#161B22]/85 to-transparent" />
        )}
      </div>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="mt-1 w-full inline-flex items-center justify-center gap-1 py-1 text-[11px] font-medium text-gray-400 hover:text-gray-600 transition-colors"
      >
        {expanded ? "收起" : "展开更多"}
        <svg
          className={`w-3 h-3 transition-transform ${expanded ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          aria-hidden
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
    </div>
  );
}

function HideTakenToggle({ enabled, active, onClick }: { enabled: boolean; active: boolean; onClick: () => void }) {
  // 胶囊开关：未开模拟选课时整体灰色禁用；开启后未激活灰底、激活琥珀色 + thumb 滑到右侧。
  const trackCls = !enabled
    ? "bg-gray-200"
    : active
    ? "bg-amber-500"
    : "bg-gray-300";
  const labelCls = !enabled
    ? "text-gray-300"
    : active
    ? "text-amber-700 font-semibold"
    : "text-gray-600";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-disabled={!enabled || undefined}
      title={enabled ? "隐藏方案内已修必修、已勾限选、转专业已抵的课程" : "需开启模拟选课"}
      className={`mt-2 w-full inline-flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs transition-colors select-none min-h-[36px] hover:bg-gray-50 ${
        !enabled ? "cursor-not-allowed" : ""
      }`}
    >
      <span className={labelCls}>隐藏已修课程</span>
      <span className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${trackCls}`}>
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-out ${
            active ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}

function FoldGroupsToggle({ active, onClick }: { active: boolean; onClick: () => void }) {
  // 胶囊开关：折叠同名课程。默认开启（active）→ 品牌红；关闭 → 灰，回退扁平列表。
  const trackCls = active ? "bg-red-500" : "bg-gray-300";
  const labelCls = active ? "text-red-600 font-semibold" : "text-gray-600";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title="同一课程号的多个班级折叠为一行；关闭后每个班级单独成行"
      className="w-full inline-flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs transition-colors select-none min-h-[36px] hover:bg-gray-50"
    >
      <span className={labelCls}>折叠同名课程</span>
      <span className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${trackCls}`}>
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-out ${
            active ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}

function PlanOnlyToggle({ active, onClick }: { active: boolean; onClick: () => void }) {
  // 胶囊开关：仅看本方案课程。与 HideTakenToggle 同一视觉，激活色用品牌红。
  const trackCls = active ? "bg-red-500" : "bg-gray-300";
  const labelCls = active ? "text-red-600 font-semibold" : "text-gray-600";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title="只显示本培养方案内的课程"
      className="mt-2 w-full inline-flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs transition-colors select-none min-h-[36px] hover:bg-gray-50"
    >
      <span className={labelCls}>仅看本方案课程</span>
      <span className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${trackCls}`}>
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-out ${
            active ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}

function FilterBtn({ state, onClick, children, disabled = false, title }: {
  state: "none" | "include" | "exclude";
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  let cls: string;
  if (disabled) {
    // 灰色禁用态：与 exclude 区分（exclude 是深灰加删除线表"主动排除"，
    // disabled 是浅灰半透明表"不可用"）
    cls = "bg-gray-50 text-gray-300 border border-gray-200 opacity-70 cursor-not-allowed";
  } else if (state === "include") {
    cls = "bg-red-500 text-white shadow-sm shadow-red-200";
  } else if (state === "exclude") {
    cls = "bg-gray-200 text-gray-400 border border-gray-300 line-through decoration-gray-400";
  } else {
    cls = "bg-white text-gray-600 border border-gray-200 hover:border-gray-300 hover:text-gray-800 active:bg-gray-50";
  }

  return (
    <button
      onClick={onClick}
      title={title}
      aria-disabled={disabled || undefined}
      className={`inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-medium transition-all min-h-[32px] select-none ${cls}`}
    >
      {children}
    </button>
  );
}
