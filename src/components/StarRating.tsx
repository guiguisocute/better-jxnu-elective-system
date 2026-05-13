interface Props {
  rating: number | null;
  count?: number;
  size?: "sm" | "md";
}

export function StarRating({ rating, count, size = "sm" }: Props) {
  const s = size === "sm" ? 14 : 18;
  const gap = size === "sm" ? 1 : 2;

  if (rating === null || rating === undefined) {
    return (
      <div className="flex items-center" style={{ gap }}>
        {[1, 2, 3, 4, 5].map((i) => (
          <svg key={i} width={s} height={s} viewBox="0 0 20 20" fill="#E5E7EB">
            <path d="M10 15.27L16.18 19l-1.64-7.03L20 7.24l-7.19-.61L10 0 7.19 6.63 0 7.24l5.46 4.73L3.82 19z" />
          </svg>
        ))}
        <span className="text-[11px] text-gray-300 ml-0.5">--</span>
      </div>
    );
  }

  const stars: ("full" | "half" | "empty")[] = [];
  for (let i = 1; i <= 5; i++) {
    if (rating >= i) stars.push("full");
    else if (rating >= i - 0.5) stars.push("half");
    else stars.push("empty");
  }

  return (
    <div className="flex items-center" style={{ gap }}>
      {stars.map((type, i) => (
        <svg key={i} width={s} height={s} viewBox="0 0 20 20">
          <defs>
            <linearGradient id={`half-${i}-${rating}`}>
              <stop offset="50%" stopColor="#FBBF24" />
              <stop offset="50%" stopColor="#E5E7EB" />
            </linearGradient>
          </defs>
          <path
            d="M10 15.27L16.18 19l-1.64-7.03L20 7.24l-7.19-.61L10 0 7.19 6.63 0 7.24l5.46 4.73L3.82 19z"
            fill={
              type === "full"
                ? "#FBBF24"
                : type === "half"
                ? `url(#half-${i}-${rating})`
                : "#E5E7EB"
            }
          />
        </svg>
      ))}
      {count !== undefined && (
        <span className="text-[11px] text-gray-400 ml-0.5">{count}</span>
      )}
    </div>
  );
}
