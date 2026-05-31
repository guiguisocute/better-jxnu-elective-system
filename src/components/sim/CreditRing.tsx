import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { PieChart } from "echarts/charts";
import { TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { CreditPlanView } from "../../lib/creditPlan";
import { useTheme } from "../../hooks/useTheme";

echarts.use([PieChart, TooltipComponent, CanvasRenderer]);

interface Props {
  view: CreditPlanView;
  size?: number;
  stroke?: number;
}

// 毕业核算环（ECharts doughnut）。两大块按子类着色 + 各块「下学期理论」投影(块色斜纹) + 剩余(灰)：
//   非本学期必修(深蓝) / 本学期必修·在读(浅蓝) / 其他选修(绿) / 专业限选(紫) / 各块理论(块色 decal 斜纹) / 剩余(灰)。
// 数据项 name 稳定 → setOption 合并时角度平滑过渡。悬停显示子类名+学分。中心写已修 / 毕业最低。
export function CreditRing({ view, size = 120, stroke = 12 }: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const { resolved } = useTheme();
  const isDark = resolved === "dark";

  useEffect(() => {
    if (!elRef.current) return;
    const chart = echarts.init(elRef.current);
    chartRef.current = chart;
    return () => {
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.resize({ width: size, height: size });

    const proj = view.projection.value;
    const denom = view.minTotal ?? Math.max(1, view.earned + proj + 1);
    const inner = Math.max(0, size / 2 - stroke);
    const outer = size / 2;

    // 暗色下：剩余区从 #f3f4f6 调到深灰；段间边框从白色调到 card 背景色，避免亮缝
    const restColor = isDark ? "#2A2A2A" : "#f3f4f6";
    const segBorder = isDark ? "#1E1E1E" : "#fff";

    // 稳定的数据项集合：各块已修子段(实色) + 各块下学期理论(块色 + decal 斜纹) + 剩余(灰)。
    // 「未来必修」(极浅蓝)现在已是必修块 segments 的一部分（buildCreditPlan 注入），
    // 会跟着第一段 flatMap 渲染，不能再单独 push 一次，否则双倍。
    // decal 由 CanvasRenderer 直接绘制（无需 aria 组件）；万一 decal 不渲染，底色仍是块色，语义不丢。
    // 专业限选子目标若有 cart 项（subTarget.planned > 0），从选修块 planned 里"挑出"对应学分单独用紫色斜纹片，
    // 让加车 → 紫色弧随之增长（之前全归绿色斜纹，紫弧静止）。
    const stripeDecal = {
      symbol: "rect",
      color: "rgba(255,255,255,0.55)",
      dashArrayX: [1, 0],
      dashArrayY: [2, 5],
      rotation: Math.PI / 4,
    } as const;
    const data = [
      ...view.blocks.flatMap((b) =>
        b.segments.map((seg) => ({
          name: seg.label,
          value: seg.value,
          itemStyle: { color: seg.color },
        })),
      ),
      ...view.blocks.flatMap((b) => {
        const subPlanned = b.subTarget?.planned ?? 0;
        const ownPlanned = Math.max(0, b.planned - subPlanned);
        const slices: { name: string; value: number; itemStyle: object }[] = [];
        if (ownPlanned > 0) {
          slices.push({
            name: `${b.label}·下学期理论`,
            value: ownPlanned,
            itemStyle: { color: b.color, decal: stripeDecal },
          });
        }
        if (subPlanned > 0 && b.subTarget) {
          slices.push({
            name: `${b.subTarget.label}·下学期理论`,
            value: subPlanned,
            itemStyle: { color: b.subTarget.color, decal: stripeDecal },
          });
        }
        return slices;
      }),
      {
        name: "剩余",
        value: Math.max(0, denom - view.earned - proj),
        itemStyle: { color: restColor },
      },
    ];

    chart.setOption({
      animationDuration: 600,
      animationDurationUpdate: 550,
      animationEasingUpdate: "cubicOut",
      tooltip: {
        trigger: "item",
        confine: true,
        borderWidth: 0,
        backgroundColor: "rgba(17,24,39,0.92)",
        textStyle: { color: "#fff", fontSize: 11 },
        formatter: (p: { name: string; value: number }) =>
          p.name === "剩余" ? `还差 ${p.value} 学分` : `${p.name}：${p.value} 学分`,
      },
      series: [
        {
          type: "pie",
          radius: [inner, outer],
          center: ["50%", "50%"],
          startAngle: 90,
          clockwise: true,
          avoidLabelOverlap: false,
          label: { show: false },
          labelLine: { show: false },
          itemStyle: { borderColor: segBorder, borderWidth: 1 },
          data,
        },
      ],
    });
  }, [view, size, stroke, isDark]);

  return (
    <div className="relative inline-flex" style={{ width: size, height: size }}>
      <div ref={elRef} style={{ width: size, height: size }} />
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <div className="text-[9px] text-gray-400 uppercase tracking-wider">已修</div>
        <div className="text-xl font-black text-gray-800 leading-none mt-0.5">
          {view.earned}
          {view.projection.value > 0 && <span className="text-red-500 text-base">+{view.projection.value}</span>}
        </div>
        <div className="text-[10px] text-gray-400 mt-0.5 font-mono">/ {view.minTotal ?? "?"}</div>
      </div>
    </div>
  );
}

type LegendItem = { label: string; color: string; striped?: boolean };
const LEGEND: LegendItem[] = [
  { label: "非本学期必修", color: "#2563EB" },
  { label: "本学期必修", color: "#93C5FD" },
  { label: "选修", color: "#10B981" },
  { label: "专业限选", color: "#8B5CF6" },
  { label: "斜纹 = 下学期理论", color: "#9CA3AF", striped: true },
];
const FUTURE_LEGEND: LegendItem = { label: "未来必修", color: "#E0F2FE" };

/** 环图图例（主色说明），供面板 / 引导复用。斜纹项表示「下学期理论」用所属块色。
 *  showFuture=true 时追加「未来必修」浅蓝项（与开关联动）。 */
export function CreditRingLegend({ className = "", showFuture = false }: { className?: string; showFuture?: boolean }) {
  const items = showFuture ? [...LEGEND.slice(0, 2), FUTURE_LEGEND, ...LEGEND.slice(2)] : LEGEND;
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1">
        {items.map((l) => (
          <span key={l.label} className="inline-flex items-center gap-1 text-[10px] text-gray-500">
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm"
              style={
                l.striped
                  ? { background: l.color, backgroundImage: "repeating-linear-gradient(45deg, rgba(255,255,255,.75) 0 1.5px, transparent 1.5px 3px)" }
                  : { background: l.color }
              }
            />
            {l.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 「显示未来学期必修课」勾选开关，供引导核对页 / 面板毕业核算复用。
 *  勾上后：核对列表追加未来学期必修、环图多出极浅蓝规划弧（仅展示，不进待选清单）。 */
export function FutureRequiredToggle({
  checked,
  onChange,
  className = "",
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      title="显示培养方案里未来学期的必修课（极浅蓝规划进度，仅展示，不计入待选清单）"
      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium transition-colors select-none ${
        checked ? "bg-sky-50 border-sky-200 text-sky-700" : "bg-white border-gray-200 text-gray-500 hover:border-gray-300"
      } ${className}`}
    >
      <span
        className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
          checked ? "bg-sky-400 border-sky-400 text-white" : "border-gray-300"
        }`}
      >
        {checked && (
          <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
      </span>
      显示未来学期必修课
    </button>
  );
}
