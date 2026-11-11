import { useId } from "react";

interface Props {
  semester: string;
  onViewHistory: () => void;
}

/** 未发布目录不是请求失败，也不是筛选无结果；保留阶段和学期切换入口。 */
export function PreselectionUpdating({ semester, onViewHistory }: Props) {
  const titleId = useId();
  const upcoming = semester === "2027-03";
  return (
    <section className="bg-card rounded-xl px-5 py-12 sm:px-10 sm:py-16 text-center" aria-labelledby={titleId}>
      <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-3xl bg-brand/8 text-brand" aria-hidden="true">
        <svg className="h-11 w-11" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="8" y="11" width="32" height="29" rx="5" />
          <path d="M16 7v8m16-8v8M8 21h32M16 28h6m-6 6h4" />
          <circle cx="32" cy="33" r="8" fill="var(--color-card)" />
          <path d="M32 29v4l3 2" />
        </svg>
      </div>
      <p className="mb-3 inline-flex items-center gap-2 rounded-full bg-brand/8 px-3 py-1 text-xs font-medium text-brand">
        <span className="h-1.5 w-1.5 rounded-full bg-brand motion-safe:animate-pulse" aria-hidden="true" />
        {semester} · 预选
      </p>
      <h2 id={titleId} className="text-2xl font-bold tracking-tight text-ink">课程数据正在更新中</h2>
      <p className="mx-auto mt-3 max-w-md text-sm leading-7 text-gray-500">
        {upcoming ? "2027 年春季学期的预选课程目录暂未就绪。" : "该学期的预选课程目录暂未就绪。"}
        <br />课程目录发布后将陆续更新，请稍后刷新查看。
      </p>
      {upcoming && (
        <div className="mx-auto mt-7 max-w-md rounded-xl border border-gray-100 bg-page px-5 py-4 text-left">
          <p className="text-xs text-gray-400">预选开放时间 · 台北时间（UTC+8）</p>
          <p className="mt-1.5 text-sm font-semibold text-ink">2026 年 11 月 11 日 <span className="text-brand tabular-nums">12:00</span> 起</p>
          <p className="mt-2 text-xs leading-5 text-gray-500">本站数据更新可能稍有延迟，实际开放情况以学校选课系统为准。</p>
        </div>
      )}
      <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
        <button type="button" onClick={() => window.location.reload()} className="min-h-11 rounded-xl bg-brand px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">刷新查看</button>
        <button type="button" onClick={onViewHistory} className="min-h-11 rounded-xl border border-gray-200 px-5 py-2.5 text-sm font-medium text-gray-600 transition-colors hover:bg-page focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">查看往期正选 / 补退选</button>
      </div>
      <p className="mt-6 text-xs leading-5 text-gray-400">无需重复设置筛选条件，也可通过上方入口切换学期。</p>
    </section>
  );
}
