import Avatar from "boring-avatars";
import { seedColors } from "../../lib/avatar";

// 匿名头像：boring-avatars beam 变体，palette 由 seed 确定性派生。
export function AnonAvatar({ seed, size }: { seed: string | null | undefined; size: number }) {
  return (
    <span
      className="inline-flex rounded-full overflow-hidden shrink-0 select-none"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <Avatar size={size} name={seed || "momo"} variant="beam" colors={seedColors(seed)} />
    </span>
  );
}
