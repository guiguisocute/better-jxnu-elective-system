interface Props {
  enrolled: number | null;
  capacity: number | null;
  stale?: boolean;
  className?: string;
}

export function EnrollmentCapacityBadge({ enrolled, capacity, stale = false, className = "" }: Props) {
  const hasEnrollment = enrolled !== null;
  const hasCapacity = capacity !== null && capacity >= 0;
  let label = "实时人数待获取";
  let tone = "bg-gray-100 text-gray-500 ring-gray-200";

  if (hasEnrollment && stale) {
    label = "实时人数更新延迟";
  } else if (hasEnrollment && !hasCapacity) {
    label = "已选人数已更新，容量待补充";
  } else if (hasEnrollment && hasCapacity) {
    const remaining = capacity - enrolled;
    if (remaining <= 0) {
      label = "容量已满";
      tone = "bg-red-50 text-red-600 ring-red-200";
    } else if (remaining <= 5 || remaining / capacity <= 0.2) {
      label = `余量紧张，剩余 ${remaining}`;
      tone = "bg-amber-50 text-amber-700 ring-amber-200";
    } else {
      label = `余量充足，剩余 ${remaining}`;
      tone = "bg-emerald-50 text-emerald-700 ring-emerald-200";
    }
  }

  return (
    <span
      title={label}
      aria-label={`${enrolled ?? "未知"} 人已选，容量 ${capacity ?? "未知"}；${label}`}
      className={`inline-flex min-w-[52px] items-center justify-center rounded-md px-1.5 py-1 text-[11px] font-bold tabular-nums ring-1 ring-inset ${tone} ${className}`}
    >
      {enrolled ?? "-"}<span className="mx-0.5 font-normal opacity-60">/</span>{capacity ?? "-"}
    </span>
  );
}
