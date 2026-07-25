import type { CreditBlock } from "../../lib/creditPlan";

// 学分块进度条：已修按子类分段着色 → 块色斜纹「下学期理论」→ 灰底还需。
// required 为 null（培养方案未匹配）时退化为子段实色 + 灰底 + "?"。
// 选修块带「专业限选」硬性子目标的细进度。

export function CreditBar({ block, nextSemKey }: { block: CreditBlock; nextSemKey?: string }) {
  const nextSemName = nextSemKey || "下学期";
  const { label, required, earned, planned, remaining, segments, subTarget } = block;
  const unknown = required == null;
  const denom = unknown ? 0 : required;
  const pct = (v: number) => (unknown || denom === 0 ? 0 : Math.min(100, (v / denom) * 100));
  const earnedPct = pct(earned);
  const plannedPct = unknown || denom === 0 ? 0 : Math.min(Math.max(0, 100 - earnedPct), (planned / denom) * 100);
  const completed = !unknown && earned + planned >= required;

  // 子段累计左偏移（百分比），用于堆叠着色。
  let acc = 0;

  return (
    <div className="py-1.5">
      <div className="flex items-baseline justify-between mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ background: block.color }} />
          <span className="text-[12px] font-semibold text-gray-700 truncate">{label}</span>
          {planned > 0 && (
            <span
              className="inline-flex items-center text-[10px] font-bold px-1 rounded border"
              style={{ color: block.color, background: block.color + "14", borderColor: block.color + "55" }}
            >
              +{planned}
            </span>
          )}
          {completed && (
            <span className="inline-flex items-center text-[10px] font-bold px-1 rounded text-emerald-600 bg-emerald-50 border border-emerald-200">
              已达标
            </span>
          )}
        </div>
        <div className="text-[11px] font-mono shrink-0">
          <span className="text-gray-800 font-bold">
            {earned}
            {planned > 0 && <span style={{ color: block.color }}>+{planned}</span>}
          </span>
          <span className="text-gray-400"> / {unknown ? <span className="text-amber-600">?</span> : required}</span>
          {!unknown && remaining! > 0 && (
            <span className="text-gray-400 ml-1.5">
              还差 <span className="text-red-500 font-bold">{remaining}</span>
            </span>
          )}
        </div>
      </div>
      <div className="relative h-2 rounded-full bg-gray-100 overflow-hidden">
        {!unknown &&
          segments.map((seg) => {
            const w = pct(seg.value);
            const left = acc;
            acc += w;
            if (w <= 0) return null;
            return (
              <div
                key={seg.key}
                className="absolute inset-y-0 transition-[width,left] duration-500 ease-out"
                style={{ left: `${left}%`, width: `${w}%`, background: seg.color }}
                title={`${seg.label} ${seg.value} 分`}
              />
            );
          })}
        {!unknown && plannedPct > 0 && (
          <div
            className="absolute inset-y-0 transition-[width,left] duration-500 ease-out"
            style={{
              left: `${earnedPct}%`,
              width: `${plannedPct}%`,
              background: block.color,
              backgroundImage: "repeating-linear-gradient(45deg, rgba(255,255,255,.55) 0 3px, transparent 3px 6px)",
            }}
            title={`${nextSemName}理论（${label}）+${planned} 分`}
          />
        )}
        {unknown && (
          <div
            className="absolute inset-0"
            style={{ backgroundImage: "repeating-linear-gradient(to right, #d1d5db 0 4px, transparent 4px 8px)" }}
          />
        )}
      </div>

      {/* 专业限选 硬性子目标（选修块）。 */}
      {subTarget && subTarget.required > 0 && (
        <div className="mt-1.5 pl-3.5">
          <div className="flex items-baseline justify-between mb-0.5">
            <span className="inline-flex items-center gap-1 text-[10px] text-gray-500">
              <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ background: subTarget.color }} />
              {subTarget.label}
              {subTarget.planned > 0 && (
                <span
                  className="inline-flex items-center text-[9px] font-bold px-1 rounded border ml-0.5"
                  style={{ color: subTarget.color, background: subTarget.color + "14", borderColor: subTarget.color + "55" }}
                >
                  +{subTarget.planned}
                </span>
              )}
            </span>
            <span className="text-[10px] font-mono">
              <span className="font-bold" style={{ color: subTarget.earned >= subTarget.required ? "#059669" : subTarget.color }}>
                {subTarget.earned}
              </span>
              {subTarget.planned > 0 && (
                <span style={{ color: subTarget.color }}>+{subTarget.planned}</span>
              )}
              <span className="text-gray-400"> / {subTarget.required}</span>
            </span>
          </div>
          {(() => {
            const earnedPct = Math.min(100, (subTarget.earned / subTarget.required) * 100);
            const plannedPct = Math.min(Math.max(0, 100 - earnedPct), (subTarget.planned / subTarget.required) * 100);
            return (
              <div className="relative h-1 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 transition-[width] duration-500 ease-out"
                  style={{ width: `${earnedPct}%`, background: subTarget.color }}
                />
                {plannedPct > 0 && (
                  <div
                    className="absolute inset-y-0 transition-[width,left] duration-500 ease-out"
                    style={{
                      left: `${earnedPct}%`,
                      width: `${plannedPct}%`,
                      background: subTarget.color,
                      backgroundImage: "repeating-linear-gradient(45deg, rgba(255,255,255,.55) 0 3px, transparent 3px 6px)",
                    }}
                    title={`${nextSemName}理论（${subTarget.label}）+${subTarget.planned} 分`}
                  />
                )}
              </div>
            );
          })()}
          <p className="mt-1 text-[10px] text-gray-400 leading-relaxed">
            培养方案的限选学分要求并不一定为毕业要求，详情请咨询当前学院教务处。
          </p>
        </div>
      )}

      {unknown && (
        <div className="text-[9px] text-amber-600/80 mt-0.5">培养方案未明确应修学分 · 当前仅累计统计</div>
      )}
    </div>
  );
}
