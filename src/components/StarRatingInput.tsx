import { useState } from "react";

interface Props {
  value: number;
  onChange: (v: number) => void;
  size?: number;
}

export function StarRatingInput({ value, onChange, size = 24 }: Props) {
  const [hover, setHover] = useState(0);

  const handleClick = (star: number, half: boolean) => {
    onChange(half ? star - 0.5 : star);
  };

  return (
    <div
      className="flex items-center"
      style={{ gap: 4 }}
      onMouseLeave={() => setHover(0)}
    >
      {[1, 2, 3, 4, 5].map((star) => {
        const active = hover || value;
        const isFull = active >= star;
        const isHalf = !isFull && active >= star - 0.5;

        return (
          <div
            key={star}
            className="relative cursor-pointer"
            style={{ width: size, height: size }}
          >
            {/* Left half click area */}
            <div
              className="absolute left-0 top-0 w-1/2 h-full z-10"
              onMouseEnter={() => setHover(star - 0.5)}
              onClick={() => handleClick(star, true)}
            />
            {/* Right half click area */}
            <div
              className="absolute right-0 top-0 w-1/2 h-full z-10"
              onMouseEnter={() => setHover(star)}
              onClick={() => handleClick(star, false)}
            />
            <svg width={size} height={size} viewBox="0 0 20 20">
              <defs>
                <linearGradient id={`input-half-${star}`}>
                  <stop offset="50%" stopColor="#FBBF24" />
                  <stop offset="50%" stopColor="#E5E7EB" />
                </linearGradient>
              </defs>
              <path
                d="M10 15.27L16.18 19l-1.64-7.03L20 7.24l-7.19-.61L10 0 7.19 6.63 0 7.24l5.46 4.73L3.82 19z"
                fill={
                  isFull
                    ? "#FBBF24"
                    : isHalf
                    ? `url(#input-half-${star})`
                    : "#E5E7EB"
                }
                className="transition-colors"
              />
            </svg>
          </div>
        );
      })}
      <span className="text-sm font-medium text-gray-600 ml-1 min-w-[2.5rem]">
        {value > 0 ? value.toFixed(1) : ""}
      </span>
    </div>
  );
}
