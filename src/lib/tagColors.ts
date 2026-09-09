// tag / 课程性质 的展示层（配色 + 窄列文案）。从 TagBadge.tsx 拆出：组件文件只导出组件
// （fast refresh 约束），配色函数供 TagBadge 与 SimScheduleGrid 周课表格子共用，
// 保证「格子色 = 标签色」。

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
  "任意选修": "text-indigo-600 border-indigo-300 bg-indigo-50/60 border-dashed",
};

// 表格「标签」列专用的缩写文案。11px 字号下一个汉字就是 11px，而这一列的净宽只有 60~75px
// （1280 视口更窄），6 字以上的标签必被截断 —— 与其省略号吃掉尾字，不如先把冗余字去掉。
// 约束：① 只影响**展示**，配色/筛选/搜索一律用原 tag，完整名走 title；
//       ② 缩写后必须两两不同；③ 保留区分度最高的那一段（教师教育必修/选修 → 必修/选修）。
const COMPACT_TAG: Record<string, string> = {
  "公共必修课": "公共必修",
  "教师教育课程": "教师教育",
  "教师教育必修": "教育必修",
  "教师教育选修": "教育选修",
  "大学英语特色课": "英语特色",
};

/** 窄列展示用的标签文案（详情页/卡片等宽松场景请用原 tag）。 */
export function compressTag(tag: string): string {
  const short = COMPACT_TAG[tag];
  if (short) return short;
  // 「公选课-XXX」：父级「公选课」已被 compactTags 去掉，子分类名本身就够认，
  // 且同为翠绿配色 —— 去掉 4 个字的前缀，9 字标签直接降到 5 字（本列最长的一类）。
  if (tag.startsWith("公选课-")) return tag.slice(4);
  return tag;
}

/** tag / 课程性质 → 配色类（浅底 + 同色边框 + 深色文字）。 */
export function tagColorClasses(tag: string): string {
  const color = TAG_COLORS[tag];
  if (color) return color;
  if (tag.startsWith("公选课-")) return "text-emerald-500 border-emerald-200 bg-emerald-50/50";
  return "text-gray-500 border-gray-200 bg-gray-50/50";
}
