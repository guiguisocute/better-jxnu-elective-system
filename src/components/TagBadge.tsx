const TAG_COLORS: Record<string, string> = {
  "公选课": "text-emerald-600 border-emerald-200 bg-emerald-50/50",
  "公共必修课": "text-amber-600 border-amber-200 bg-amber-50/50",
  "教师教育课程": "text-purple-600 border-purple-200 bg-purple-50/50",
  "其他": "text-gray-500 border-gray-200 bg-gray-50/50",
  // 培养方案课程性质（真实出现的值；"公共必修" 已在 build_data.py 归一化为 "公共必修课"）
  "专业主干": "text-blue-700 border-blue-300 bg-blue-50/60",
  "专业限选": "text-indigo-600 border-indigo-200 bg-indigo-50/60",
  "专业任选": "text-sky-500 border-sky-200 bg-sky-50/40",
  "专业类基础": "text-cyan-600 border-cyan-200 bg-cyan-50/50",
  "教师教育必修": "text-purple-700 border-purple-300 bg-purple-50/60",
  "教师教育选修": "text-purple-500 border-purple-200 bg-purple-50/40",
  // 其他可能出现的值（保底）
  "学科基础": "text-cyan-600 border-cyan-200 bg-cyan-50/50",
  "专业必修": "text-blue-700 border-blue-300 bg-blue-50/60",
  "专业选修": "text-sky-500 border-sky-200 bg-sky-50/40",
  "任选": "text-gray-500 border-gray-200 bg-gray-50/50",
  "通识选修": "text-teal-600 border-teal-200 bg-teal-50/50",
  "集中实践": "text-orange-600 border-orange-200 bg-orange-50/50",
  "学位课": "text-red-600 border-red-300 bg-red-50/60 font-bold",
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
