const TAG_COLORS: Record<string, string> = {
  "公选课": "text-emerald-600 border-emerald-200 bg-emerald-50/50",
  "公共必修课": "text-amber-600 border-amber-200 bg-amber-50/50",
  "专业课": "text-blue-600 border-blue-200 bg-blue-50/50",
  "教师教育课程": "text-purple-600 border-purple-200 bg-purple-50/50",
  "其他": "text-gray-500 border-gray-200 bg-gray-50/50",
};

export function TagBadge({ tag }: { tag: string }) {
  let color = TAG_COLORS[tag];
  if (!color) {
    if (tag.startsWith("公选课-")) color = "text-emerald-500 border-emerald-200 bg-emerald-50/50";
    else color = "text-gray-500 border-gray-200 bg-gray-50/50";
  }
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-md text-[11px] font-medium border ${color}`}>
      {tag}
    </span>
  );
}
