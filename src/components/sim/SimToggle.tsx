import type { SimMode } from "../../hooks/useSimMode";

interface Props {
  mode: SimMode;
  cartCount: number;
  onClick: () => void;
}

// 顶部搜索行右侧的「模拟选课」三态开关：browse / onboarding / sim。
export function SimToggle({ mode, cartCount, onClick }: Props) {
  if (mode === "onboarding") {
    return (
      <button
        className="shrink-0 inline-flex items-center gap-2 h-10 pl-3 pr-3.5 rounded-xl bg-red-50 border-2 border-red-300 text-red-700 cursor-default"
        disabled
      >
        <span className="relative inline-flex w-9 h-5 rounded-full bg-red-200">
          <span className="absolute top-0.5 left-2.5 w-4 h-4 rounded-full bg-brand-fg shadow" />
        </span>
        <span className="text-[13px] font-bold inline-flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25">
            <path strokeLinecap="round" d="M21 12a9 9 0 11-6.219-8.56" />
          </svg>
          引导中…
        </span>
      </button>
    );
  }

  if (mode === "sim") {
    return (
      <button
        onClick={onClick}
        title="关闭模拟选课"
        className="shrink-0 inline-flex items-center gap-2 h-10 pl-3 pr-3 rounded-xl bg-red-500 text-white border-2 border-red-500 shadow-sm shadow-red-200 transition-colors hover:bg-red-600"
      >
        <span className="relative inline-flex w-9 h-5 rounded-full bg-white/30">
          <span className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-brand-fg shadow transition-transform" />
        </span>
        <span className="text-[13px] font-bold inline-flex items-center gap-1.5">
          模拟选课
          <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded-full bg-brand-fg text-red-600 text-[11px] font-black">
            {cartCount}
          </span>
          <span className="text-[11px] font-medium text-white/80">门</span>
        </span>
      </button>
    );
  }

  // browse
  return (
    <button
      onClick={onClick}
      title="进入模拟选课"
      className="shrink-0 group inline-flex items-center gap-2 h-10 pl-3 pr-3.5 rounded-xl border-2 border-red-200 text-red-600 transition-colors hover:bg-red-50 hover:border-red-300"
    >
      <span className="relative inline-flex w-9 h-5 rounded-full bg-gray-200 transition-colors group-hover:bg-red-200">
        <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-brand-fg shadow transition-transform" />
      </span>
      <span className="text-[13px] font-bold inline-flex items-center gap-1">
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25">
          <path d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
        </svg>
        模拟选课
      </span>
    </button>
  );
}
