// 评价系统 V2 契约（前端唯一真源）。
// functions/api/reviews*.ts 不在 tsc -b 编译范围，字段名与此文件手动保持一致。

export type Dimension = "overall" | "assess" | "attendance" | "difficulty" | "teaching";

/** 展示与提交的固定顺序（overall 在前，其余 4 维为新增维度） */
export const DIMENSIONS: Dimension[] = ["overall", "assess", "attendance", "difficulty", "teaching"];

/** 「按老师」视图综合分只取这 4 个新维度（overall 单列展示） */
export const NEW_DIMENSIONS: Dimension[] = ["assess", "attendance", "difficulty", "teaching"];

export const DIMENSION_LABELS: Record<Dimension, string> = {
  overall: "总体评分",
  assess: "考核给分",
  attendance: "考勤频率",
  difficulty: "课程强度",
  teaching: "教学质量",
};

/** 表格/胶囊里的短标签 */
export const DIMENSION_SHORT: Record<Dimension, string> = {
  overall: "总体",
  assess: "考核",
  attendance: "考勤",
  difficulty: "强度",
  teaching: "教学",
};

// index 0 = 1★ … index 4 = 5★
export const DIMENSION_STAR_TEXT: Record<Dimension, string[]> = {
  overall: ["很差", "较差", "一般", "不错", "强烈推荐"],
  assess: ["给分很低", "给分偏严", "中规中矩", "给分不错", "给分超好"],
  attendance: ["每堂必点", "经常点名", "偶尔点名", "很少点名", "一次未点"],
  difficulty: ["毫无压力", "比较简单", "中等", "有点强度", "硬核劝退"],
  teaching: ["照本宣科", "比较平淡", "还算清晰", "讲得很好", "醍醐灌顶"],
};

/** 设计稿配色：总体红 / 考核橙 / 考勤蓝 / 难度紫 / 教学绿 */
export const DIMENSION_COLORS: Record<Dimension, { bar: string; text: string; chipBg: string; chipText: string }> = {
  overall: { bar: "#DC2626", text: "text-red-600", chipBg: "bg-red-50", chipText: "text-red-600" },
  assess: { bar: "#EA580C", text: "text-orange-600", chipBg: "bg-orange-50", chipText: "text-orange-600" },
  attendance: { bar: "#2563EB", text: "text-blue-600", chipBg: "bg-blue-50", chipText: "text-blue-600" },
  difficulty: { bar: "#7C3AED", text: "text-violet-600", chipBg: "bg-violet-50", chipText: "text-violet-600" },
  teaching: { bar: "#059669", text: "text-emerald-600", chipBg: "bg-emerald-50", chipText: "text-emerald-600" },
};

/** 分数（0.5–5，含平均分小数）→ 对应星级文案（四舍五入到 1–5 档） */
export function starTextFor(dim: Dimension, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  const idx = Math.min(4, Math.max(0, Math.round(value) - 1));
  return DIMENSION_STAR_TEXT[dim][idx];
}

/** 单维度聚合 */
export interface DimAgg {
  avg: number;
  count: number;
}

/** 一个 (course, teacher) 的全维度聚合；缺维度 = 该维度暂无人评 */
export type TeacherDims = Partial<Record<Dimension, DimAgg>>;

/** GET /api/reviews/all 形状：{ [courseId]: { [teacherId]: TeacherDims } } */
export type AllReviews = Record<string, Record<string, TeacherDims>>;

/** 一条评价（GET /api/reviews/comments 行 / mine 返回） */
export interface ReviewRow {
  id: number;
  courseId: string;
  teacherId: string;
  avatar: string | null;
  nickname: string | null;
  overall: number | null;
  assess: number | null;
  attendance: number | null;
  difficulty: number | null;
  teaching: number | null;
  overallC: string | null;
  assessC: string | null;
  attendanceC: string | null;
  difficultyC: string | null;
  teachingC: string | null;
  createdAt: string;
  updatedAt: string;
  helpful: number;
  myVote: boolean;
  mine: boolean;
  /** 审核状态（mine 接口返回；approved/pending/rejected，公开列表恒为 approved） */
  status?: string;
}

/** POST /api/reviews body（≥1 维非空；评语可只在打了分的维度上填） */
export interface ReviewSubmit {
  courseId: string;
  teacherId: string;
  voterId: string;
  avatar?: string | null;
  nickname?: string | null;
  overall?: number | null;
  assess?: number | null;
  attendance?: number | null;
  difficulty?: number | null;
  teaching?: number | null;
  overallC?: string | null;
  assessC?: string | null;
  attendanceC?: string | null;
  difficultyC?: string | null;
  teachingC?: string | null;
  /** 当前互斥人机验证 provider 产生的 token（Turnstile/Cap） */
  captchaToken?: string | null;
  /** 兼容旧版客户端；新代码使用 captchaToken */
  turnstileToken?: string | null;
}

/** 4 新维度等权平均（忽略无人评的维度）；一个维度都没有 → null */
export function compositeOf(dims: TeacherDims): number | null {
  let total = 0;
  let n = 0;
  for (const d of NEW_DIMENSIONS) {
    const agg = dims[d];
    if (agg && agg.count > 0) {
      total += agg.avg;
      n++;
    }
  }
  return n > 0 ? total / n : null;
}
