import { DAY_LABELS, SLOT_KEYS } from "../lib/scheduleParse";
import type { ScheduleFilterMap, CellState } from "../lib/scheduleParse";

// 周一..周日，与学校课表一致（共 7 列）。
const DAYS = 7;

const SLOT_LABEL: Record<string, string> = {
  "1-2": "1-2", "3": "3", "4": "4", "5": "5", "6-7": "6-7", "8-9": "8-9", "晚上": "晚",
};

interface Props {
  filter: ScheduleFilterMap;
  cycleCell: (day: number, slot: string) => void;
  removeCell: (day: number, slot: string) => void;
  clear: () => void;
  active: boolean;
  /** "day,slot" → 该格上课的班级数（当前学期），用于格内提示。 */
  cellCounts?: Record<string, number>;
}

type CellAppearance = CellState | "none";

function cellCls(state: CellAppearance): string {
  // 亮色用 Tailwind 类；暗色集中到 index.css 的 .fltgrid-* 无层级规则（须压过通用 .bg-*/.text-* 补丁，见该处注释）。
  if (state === "include") return "bg-red-500 text-white ring-2 ring-red-600 border-transparent shadow-sm fltgrid-occ";
  if (state === "exclude") return "bg-gray-200/80 text-gray-400 border-gray-300 line-through decoration-gray-400 fltgrid-cell-ex";
  return "bg-gray-50/40 hover:bg-red-50/40 hover:border-red-200 border-gray-200 text-gray-700 fltgrid-cell";
}

export function ScheduleFilter({ filter, cycleCell, removeCell, clear, active, cellCounts = {} }: Props) {
  // 行序：1-2 / 3 / 4 / 5 /（中午分隔）/ 6-7 / 8-9 / 晚上
  const rows: Array<{ kind: "lunch" } | { kind: "slot"; slot: string }> = [];
  for (const s of SLOT_KEYS) {
    if (s === "6-7") rows.push({ kind: "lunch" });
    rows.push({ kind: "slot", slot: s });
  }

  return (
    <div>
      {/* 标题 */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="inline-flex items-center justify-center w-4 h-4 rounded text-white text-[9px] font-black shrink-0" style={{ background: "#ef4444" }}>表</span>
          <span className="text-[11px] font-semibold tracking-wider text-red-700 uppercase shrink-0">课表筛选</span>
        </div>
        {active && (
          <button onClick={clear} className="text-[10px] text-red-600 hover:bg-red-50 px-1.5 py-0.5 rounded font-medium shrink-0">清除</button>
        )}
      </div>

      {/* 课表网格 */}
      <div className="select-none rounded-lg overflow-hidden border border-gray-200 bg-white fltgrid">
        {/* 表头：星期 */}
        <div className="flex bg-red-50 border-b border-red-200 fltgrid-head">
          <div className="shrink-0 w-7" />
          <div className="flex-1 grid" style={{ gridTemplateColumns: `repeat(${DAYS}, 1fr)`, gap: 2, padding: 2 }}>
            {DAY_LABELS.slice(0, DAYS).map((d, i) => (
              <div key={i} className="flex items-center justify-center text-[10px] text-gray-600 fltgrid-day font-medium py-0.5">周{d}</div>
            ))}
          </div>
        </div>

        {/* 表身 */}
        <div className="flex flex-col fltgrid-body" style={{ gap: 2, padding: 2 }}>
          {rows.map((row) =>
            row.kind === "lunch" ? (
              <div
                key="lunch"
                className="rounded flex items-center justify-center text-[10px] bg-red-50 text-red-700 fltgrid-lunch"
                style={{ height: 14, letterSpacing: "0.5em" }}
              >
                中午
              </div>
            ) : (
              <div key={row.slot} className="flex" style={{ gap: 2 }}>
                <div className="shrink-0 w-7 flex items-center justify-center text-[9px] font-mono text-gray-400 bg-gray-50/70 rounded fltgrid-slot">
                  {SLOT_LABEL[row.slot]}
                </div>
                <div className="flex-1 grid" style={{ gridTemplateColumns: `repeat(${DAYS}, 1fr)`, gap: 2 }}>
                  {Array.from({ length: DAYS }).map((_, d) => {
                    const key = `${d},${row.slot}`;
                    // filter 是稀疏 map，未设置的格子为 undefined → 退回 "none"。
                    const state: CellAppearance = (filter[key] as CellState | undefined) ?? "none";
                    const count = cellCounts[key] ?? 0;
                    return (
                      <button
                        key={d}
                        onClick={() => cycleCell(d, row.slot)}
                        className={`relative rounded border h-9 transition-all cursor-pointer flex items-center justify-center ${cellCls(state)}`}
                      >
                        {state === "none" && count > 0 && (
                          <span className="absolute right-0.5 top-0.5 w-1 h-1 rounded-full bg-gray-300 fltgrid-dot" />
                        )}
                        {state !== "none" && (
                          <span
                            className={`absolute -top-px -right-px text-[8px] leading-none px-0.5 py-px rounded-bl text-white font-bold ${
                              state === "include" ? "bg-red-600 fltgrid-state-inc" : "bg-gray-400 fltgrid-state-ex"
                            }`}
                          >
                            {state === "include" ? "仅" : "排"}
                          </span>
                        )}
                        {state === "include" && count > 0 && (
                          <span className="text-[10px] font-bold text-white">{count}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ),
          )}
        </div>
      </div>

      {/* 图例：色块对应格子状态；点击格子在三态间循环切换。
          色块复用 .fltgrid-* 钩子，暗色下与真实格子完全同色（详见 index.css）。 */}
      <div className="mt-2 space-y-1 text-[10px]">
        <div className="flex items-center gap-3 flex-wrap text-gray-500">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-gray-50/40 border border-gray-200 fltgrid-cell" />
            <span>默认</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-red-500 fltgrid-occ" />
            <span className="text-red-700 font-medium">仅看该时间段</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-gray-200 border border-gray-300 fltgrid-cell-ex" />
            <span className="line-through decoration-gray-400">排除该时间段</span>
          </span>
        </div>
        <p className="text-gray-400">点击课表循环切换</p>
      </div>

      {/* 活动格子 chip */}
      {active && (
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          {Object.entries(filter).map(([key, state]) => {
            const [d, slot] = key.split(",");
            const isInc = state === "include";
            return (
              <span
                key={key}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-medium text-[10px] ${
                  isInc
                    ? "bg-red-50 text-red-700 border border-red-200"
                    : "bg-gray-200/70 text-gray-500 border border-gray-300 line-through decoration-gray-400"
                }`}
              >
                {isInc && <span style={{ color: "#ef4444" }}>●</span>}
                周{DAY_LABELS[Number(d)]} {slot}
                <button
                  onClick={() => removeCell(Number(d), slot)}
                  className="opacity-60 hover:opacity-100 no-underline"
                  title="移除"
                >
                  <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <path d="M6 6l12 12M6 18L18 6" />
                  </svg>
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
