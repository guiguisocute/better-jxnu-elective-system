import type { Dimension, TeacherDims } from "../../lib/reviewDimensions";
import { DIMENSIONS, DIMENSION_COLORS, DIMENSION_LABELS, starTextFor } from "../../lib/reviewDimensions";

interface Props {
  dims: TeacherDims | null;
  /** compact = 详情页窄栏（条稍细、字号更小） */
  compact?: boolean;
}

// 设计稿的 5 维彩色横条：左侧维度名，中间色条（宽度 = avg/5），右侧星级文案 + 数值。
// 无人评的维度显示灰条 + 「暂无」。
export function DimensionBars({ dims, compact = false }: Props) {
  return (
    <div className={compact ? "space-y-1.5" : "space-y-2.5"}>
      {DIMENSIONS.map((d: Dimension) => {
        const agg = dims?.[d];
        const has = !!agg && agg.count > 0;
        const color = DIMENSION_COLORS[d];
        const pct = has ? Math.max(4, (agg.avg / 5) * 100) : 0;
        return (
          <div key={d} className="flex items-center gap-3">
            <span
              className={`shrink-0 text-gray-600 ${compact ? "w-14 text-[11px]" : "w-16 text-xs"}`}
            >
              {DIMENSION_LABELS[d]}
            </span>
            <div className={`flex-1 rounded-full bg-gray-100 overflow-hidden ${compact ? "h-1.5" : "h-2"}`}>
              {has && (
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${pct}%`, backgroundColor: color.bar }}
                />
              )}
            </div>
            <span className={`shrink-0 text-right tabular-nums ${compact ? "w-24 text-[11px]" : "w-28 text-xs"}`}>
              {has ? (
                <>
                  <span className={`font-semibold ${color.text}`}>{starTextFor(d, agg.avg)}</span>
                  <span className="text-gray-400 ml-1.5">{agg.avg.toFixed(1)}</span>
                </>
              ) : (
                <span className="text-gray-300">暂无</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
