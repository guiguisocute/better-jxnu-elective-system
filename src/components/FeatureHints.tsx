import type { DataSource } from "../types";

// 无任何筛选时，中间区不直接堆出全部课程，而是渲染这一层「落地入口」：
// 价值主张（带对比口吻）+ 4 个优势点 + 明确入口（浏览全部 / 模拟选课）+ 左侧筛选引导。
// 这是用户进站第一屏，目标是让人留下来、知道这站强在哪，而不是被一屏课程糊脸。
// 它不是分步引导；点「浏览全部」临时揭开本次列表（见 HomePage.hintsDismissed）。
interface Props {
  variant: "desktop" | "mobile";
  dataSource: DataSource;
  /** 已在模拟选课态时隐藏「开始模拟选课」入口（避免重复）。 */
  simActive?: boolean;
  onShowAll: () => void;
  onEnterSim: () => void;
  /** 左侧筛选栏是否展开（桌面用）：折叠时给可点的「展开筛选」按钮，展开时给文字提示。 */
  sidebarOpen?: boolean;
  onExpandSidebar?: () => void;
}

/* ---------- 图标 ---------- */
function FunnelIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
    </svg>
  );
}
function BoltIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 2L4.5 13.5h6L11 22l8.5-11.5h-6L13 2z" />
    </svg>
  );
}
function StarIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path d="M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.9l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94L12 2.5z" />
    </svg>
  );
}
function GradCapIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M22 10L12 5 2 10l10 5 10-5z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 12v4.5c0 1.1 2.7 2.5 6 2.5s6-1.4 6-2.5V12M22 10v5" />
    </svg>
  );
}
function ArrowRightIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7m7-7H4" />
    </svg>
  );
}
function CartIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
      <circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.7 13.4a2 2 0 002 1.6h9.7a2 2 0 002-1.6L23 6H6" />
    </svg>
  );
}
function ThemeIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
    </svg>
  );
}

const FEATURES = [
  { icon: FunnelIcon, title: "增强筛选", desc: "类型 / 学分 / 标签 / 时段 / 教室 任意组合" },
  { icon: BoltIcon, title: "极速响应", desc: "搜索、翻页、查看零等待" },
  { icon: StarIcon, title: "教师评分", desc: "同学匿名打分，挑课不靠运气" },
  { icon: GradCapIcon, title: "毕业进度", desc: "课表方案精准模拟，毕业学分实时清算" },
] as const;

const TITLE = "看清每一门课";
const SUBTITLE = "致力于减少每位江师大er的选课折磨";

/* ---------- 子件 ---------- */
function Eyebrow() {
  return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-50 text-red-500 text-[11px] font-semibold tracking-wide">
      <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
      JXNU 选课 PLUS
    </span>
  );
}

function FeatureItem({ icon: Icon, title, desc, row }: {
  icon: typeof FEATURES[number]["icon"];
  title: string;
  desc: string;
  row?: boolean;
}) {
  if (row) {
    return (
      <div className="flex items-start gap-3 text-left">
        <div className="shrink-0 w-9 h-9 rounded-xl bg-red-50 text-red-500 flex items-center justify-center">
          <Icon className="w-[18px] h-[18px]" />
        </div>
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-gray-700">{title}</h3>
          <p className="text-[12px] text-gray-400 leading-snug mt-0.5">{desc}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center text-center gap-2.5 px-1">
      <div className="w-11 h-11 rounded-2xl bg-red-50 text-red-500 flex items-center justify-center">
        <Icon className="w-5 h-5" />
      </div>
      <h3 className="text-[13px] font-semibold text-gray-700">{title}</h3>
      <p className="text-[12px] text-gray-400 leading-snug">{desc}</p>
    </div>
  );
}

function CTAButtons({ simActive, onShowAll, onEnterSim, stacked }: {
  simActive?: boolean;
  onShowAll: () => void;
  onEnterSim: () => void;
  stacked?: boolean;
}) {
  return (
    <div className={`flex ${stacked ? "flex-col" : "items-center justify-center flex-wrap"} gap-3`}>
      <button
        onClick={onShowAll}
        className="group inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-red-500 text-white text-sm font-semibold shadow-sm shadow-red-500/20 hover:bg-red-600 transition-colors"
      >
        浏览全部
        <ArrowRightIcon className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
      </button>
      {!simActive && (
        <button
          onClick={onEnterSim}
          className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-xl border border-red-200 bg-white text-red-600 text-sm font-semibold hover:bg-red-50 transition-colors"
        >
          <CartIcon className="w-4 h-4" />
          开始模拟选课
        </button>
      )}
    </div>
  );
}

/* ---------- 主组件 ---------- */
export function FeatureHints({
  variant, simActive, onShowAll, onEnterSim, sidebarOpen, onExpandSidebar,
}: Props) {
  if (variant === "mobile") {
    return (
      <div className="rounded-2xl bg-white border border-gray-100 shadow-sm px-6 py-9">
        <div className="text-center">
          <Eyebrow />
          <h2 className="mt-3.5 text-[19px] font-bold text-gray-800 leading-snug">{TITLE}</h2>
          <p className="mt-2 text-[13px] text-gray-400 leading-relaxed">{SUBTITLE}</p>
        </div>

        <div className="mt-6 space-y-4">
          {FEATURES.map((f) => (
            <FeatureItem key={f.title} icon={f.icon} title={f.title} desc={f.desc} row />
          ))}
        </div>

        <div className="mt-7">
          <CTAButtons simActive={simActive} onShowAll={onShowAll} onEnterSim={onEnterSim} stacked />
        </div>

        {/* 右上角三按钮图例 —— 解决「看了犯懵」 */}
        <div className="mt-7 rounded-xl bg-gray-50 border border-gray-100 px-4 py-3.5">
          <ul className="space-y-2.5 text-[12px] text-gray-600">
            <li className="flex items-center gap-2.5"><ThemeIcon className="w-4 h-4 text-gray-400 shrink-0" />切换浅色 / 深色主题</li>
            <li className="flex items-center gap-2.5"><CartIcon className="w-4 h-4 text-gray-400 shrink-0" />开启模拟选课（角标=待选门数）</li>
            <li className="flex items-center gap-2.5"><FunnelIcon className="w-4 h-4 text-gray-400 shrink-0" />打开筛选面板（学院 / 学分 / 标签…）</li>
          </ul>
        </div>

        <p className="mt-5 text-center text-[12px] text-gray-400 leading-relaxed">
          点任意课程可查看详情
        </p>
      </div>
    );
  }

  // 桌面：渲染在表格白卡内（外层已是卡片）。撑高到与左右侧栏齐平，消除下方留白。
  return (
    <div className="flex flex-col justify-center items-stretch px-8 py-16 min-h-[calc(100vh-220px)]">
      <div className="max-w-lg mx-auto text-center">
        <Eyebrow />
        <h2 className="mt-4 text-[26px] font-bold text-gray-800 leading-tight">{TITLE}</h2>
        <p className="mt-3 text-sm text-gray-500 leading-relaxed">{SUBTITLE}</p>
        <div className="mt-7">
          <CTAButtons simActive={simActive} onShowAll={onShowAll} onEnterSim={onEnterSim} />
        </div>

        {/* 左侧筛选引导：折叠→可点「展开筛选」；展开→文字提示。 */}
        <div className="mt-4">
          {sidebarOpen ? (
            <p className="text-[12px] text-gray-400">
              ← 试一试：在左侧筛选栏，随便点一点~
            </p>
          ) : (
            <button
              onClick={() => onExpandSidebar?.()}
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-gray-500 hover:text-red-600 transition-colors"
            >
              <FunnelIcon className="w-3.5 h-3.5" />
              展开左侧筛选栏（学院 / 学分 / 标签…）
            </button>
          )}
        </div>
      </div>

      <div className="mt-14 grid grid-cols-2 xl:grid-cols-4 gap-x-5 gap-y-8 max-w-3xl mx-auto w-full">
        {FEATURES.map((f) => (
          <FeatureItem key={f.title} icon={f.icon} title={f.title} desc={f.desc} />
        ))}
      </div>

      <p className="mt-12 text-center text-[12px] text-gray-400">
        点任意课程可查看详情　·　右上角可切换学期
      </p>
    </div>
  );
}
