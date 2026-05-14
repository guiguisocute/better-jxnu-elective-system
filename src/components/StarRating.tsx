interface Props {
  rating: number | null;
  count?: number;
  size?: "sm" | "md";
}

const STAR_PATH =
  "M10 15.27L16.18 19l-1.64-7.03L20 7.24l-7.19-.61L10 0 7.19 6.63 0 7.24l5.46 4.73L3.82 19z";

function Star({ size, fillPercent }: { size: number; fillPercent: number }) {
  // 双层裁切方案：灰星打底 + 金色星按 fillPercent% 宽度覆盖。
  // 完全规避 SVG 全局 ID 跨实例冲突（iOS Safari 半星掉图标的根因）。
  return (
    <span
      style={{
        position: "relative",
        display: "inline-block",
        width: size,
        height: size,
        lineHeight: 0,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 20 20"
        fill="#E5E7EB"
        style={{ position: "absolute", inset: 0 }}
      >
        <path d={STAR_PATH} />
      </svg>
      {fillPercent > 0 && (
        <span
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            height: "100%",
            width: `${fillPercent}%`,
            overflow: "hidden",
            lineHeight: 0,
          }}
          aria-hidden
        >
          <svg
            width={size}
            height={size}
            viewBox="0 0 20 20"
            fill="#FBBF24"
            style={{ display: "block" }}
          >
            <path d={STAR_PATH} />
          </svg>
        </span>
      )}
    </span>
  );
}

export function StarRating({ rating, count, size = "sm" }: Props) {
  const s = size === "sm" ? 14 : 18;
  const gap = size === "sm" ? 1 : 2;

  if (rating === null || rating === undefined) {
    return (
      <div className="flex items-center" style={{ gap }}>
        {[1, 2, 3, 4, 5].map((i) => (
          <Star key={i} size={s} fillPercent={0} />
        ))}
        <span className="text-[11px] text-gray-300 ml-0.5">--</span>
      </div>
    );
  }

  return (
    <div className="flex items-center" style={{ gap }}>
      {[1, 2, 3, 4, 5].map((i) => {
        // 第 i 颗星的填充比例：clamp(rating - (i-1), 0, 1) * 100
        const fillPercent = Math.max(0, Math.min(1, rating - (i - 1))) * 100;
        return <Star key={i} size={s} fillPercent={fillPercent} />;
      })}
      {count !== undefined && (
        <span className="text-[11px] text-gray-500 ml-1.5 tabular-nums">
          {rating.toFixed(2)}
          <span className="text-gray-400">分</span>
          <span className="mx-1 text-gray-300">·</span>
          {count}
          <span className="text-gray-400">人评分</span>
        </span>
      )}
    </div>
  );
}
