import { DAY_LABELS, SLOT_KEYS, parseSchedule, unselectedIncludeSlotsFromSchedule } from "../lib/scheduleParse";
import type { ScheduleFilterMap } from "../lib/scheduleParse";

// 详情页只读周课表：把单个 section 的上课时间画成 7天×时段 的网格。
// 本课占用格 = 浅红；课表筛选 include 下被这门课额外占用、却不在所选格子里的时段 = 深红（冲突）。
// 与 ScheduleFilter 共用同一套行序/视觉骨架，但不可交互。

const DAYS = 7;

const SLOT_LABEL: Record<string, string> = {
  "1-2": "1-2", "3": "3", "4": "4", "5": "5", "6-7": "6-7", "8-9": "8-9", "晚上": "晚",
};

type CellState = "none" | "occupied" | "conflict";

function cellCls(state: CellState): string {
  // 本课占用格用浅红（与所在「本班级信息」红卡片一致）；冲突格用浅红斜条纹（与周课表一致，不刺眼）。
  // 暗色配色集中在 index.css 的 .secgrid-* 无层级规则（必须压过通用 .bg-red-* 补丁，见该处注释）。
  if (state === "conflict") return "sim-cell-conflict text-rose-600";
  if (state === "occupied") return "bg-red-100 text-red-700 secgrid-occ";
  return "bg-white secgrid-cell";
}

interface Props {
  schedule: string;
  filter?: ScheduleFilterMap;
}

export function SectionScheduleGrid({ schedule, filter }: Props) {
  const meets = parseSchedule(schedule);
  if (meets.length === 0) return null;

  const occupied = new Set(meets.map((m) => `${m.day},${m.slot}`));
  const conflict = new Set(
    (filter ? unselectedIncludeSlotsFromSchedule(schedule, filter) : []).map((m) => `${m.day},${m.slot}`),
  );
  const hasConflict = conflict.size > 0;

  // 行序：1-2 / 3 / 4 / 5 /（中午分隔）/ 6-7 / 8-9 / 晚上
  const rows: Array<{ kind: "lunch" } | { kind: "slot"; slot: string }> = [];
  for (const s of SLOT_KEYS) {
    if (s === "6-7") rows.push({ kind: "lunch" });
    rows.push({ kind: "slot", slot: s });
  }

  return (
    <div>
      <div className="select-none rounded-lg overflow-hidden border border-red-200 bg-white secgrid">
        {/* 表头：星期 */}
        <div className="flex bg-red-50 border-b border-red-200 secgrid-head">
          <div className="shrink-0 w-7" />
          <div className="flex-1 grid" style={{ gridTemplateColumns: `repeat(${DAYS}, 1fr)`, gap: 2, padding: 2 }}>
            {DAY_LABELS.slice(0, DAYS).map((d, i) => (
              <div key={i} className="flex items-center justify-center text-[10px] text-gray-600 secgrid-day font-medium py-0.5">周{d}</div>
            ))}
          </div>
        </div>

        {/* 表身：底色作分界线 */}
        <div className="flex flex-col bg-gray-200 secgrid-body" style={{ gap: 2, padding: 2 }}>
          {rows.map((row) =>
            row.kind === "lunch" ? (
              <div
                key="lunch"
                className="rounded flex items-center justify-center text-[10px] bg-red-50 text-red-700 secgrid-lunch"
                style={{ height: 12, letterSpacing: "0.5em" }}
              >
                中午
              </div>
            ) : (
              <div key={row.slot} className="flex" style={{ gap: 2 }}>
                <div className="shrink-0 w-7 flex items-center justify-center text-[9px] font-mono text-gray-400 bg-gray-50/70 rounded secgrid-slot">
                  {SLOT_LABEL[row.slot]}
                </div>
                <div className="flex-1 grid" style={{ gridTemplateColumns: `repeat(${DAYS}, 1fr)`, gap: 2 }}>
                  {Array.from({ length: DAYS }).map((_, d) => {
                    const key = `${d},${row.slot}`;
                    const state: CellState = conflict.has(key) ? "conflict" : occupied.has(key) ? "occupied" : "none";
                    return (
                      <div
                        key={d}
                        className={`relative rounded h-8 flex items-center justify-center ${cellCls(state)}`}
                      >
                        {state === "conflict" && (
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                            <path fillRule="evenodd" clipRule="evenodd" d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 0 1 .75.75v3.75a.75.75 0 0 1-1.5 0V9a.75.75 0 0 1 .75-.75zm0 8.25a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5z" />
                          </svg>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ),
          )}
        </div>
      </div>

      {/* 图例 */}
      <div className="mt-2 flex items-center gap-3 flex-wrap text-[10px] text-gray-500">
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 rounded-sm bg-red-100 secgrid-legend" />本课时间
        </span>
        {hasConflict && (
          <span className="inline-flex items-center gap-1">
            <span className="w-3 h-3 rounded-sm sim-cell-conflict border border-rose-200" />
            <span className="text-rose-600">时段冲突</span>
          </span>
        )}
      </div>
    </div>
  );
}
