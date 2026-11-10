/** 共用品牌标识：小尺寸使用品牌交付的简化图标，深色底保留浅色底板。 */
export const JUXING_TAGLINE = "学 AI，就上飓星科技";

export function JuxingLogo({ plate = false, themed = false, size = 24 }: { plate?: boolean; themed?: boolean; size?: 24 | 28 | 32 }) {
  const image = (withPlate: boolean, className = "") => (
    <img
      src={`/img/juxing/juxing-logo-mini${withPlate ? "-plate" : ""}.svg`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      className={`shrink-0 object-contain ${className}`}
    />
  );
  return themed ? (
    <span className="inline-flex shrink-0" style={{ width: size, height: size }}>
      {image(false, "block dark:hidden")}
      {image(true, "hidden dark:block")}
    </span>
  ) : image(plate);
}

export function JuxingCobrand() {
  return (
    <div className="sm:ml-0.5 flex shrink-0 items-center gap-2 sm:border-l border-white/40 sm:pl-3 sm:pr-1" title="江西飓星科技有限公司 · 技术支持" aria-label="飓星科技技术支持">
      <JuxingLogo plate size={28} />
      <span className="hidden sm:inline whitespace-nowrap text-[13px] font-semibold text-white">飓星科技</span>
    </div>
  );
}

export function JuxingSupport({ className = "" }: { className?: string }) {
  return (
    <div className={`flex shrink-0 items-center gap-2.5 border-t border-gray-200 bg-card px-4 pt-2.5 pb-3 ${className}`} title="江西飓星科技有限公司">
      <JuxingLogo plate size={32} />
      <div className="flex min-w-0 flex-col gap-px">
        <span className="text-xs font-medium text-gray-800">飓星科技 提供支持</span>
        <span className="text-[10px] text-gray-500">{JUXING_TAGLINE}</span>
      </div>
    </div>
  );
}
