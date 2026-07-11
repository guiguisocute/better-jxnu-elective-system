// AI帮我选 —— 前后端契约与共享类型。
// 注意：functions/api/ai/recommend.ts 不在 tsc -b 编译范围内（tsconfig.app 只 include src），
// 无法直接 import 本文件 —— 后端按此处的 JSON 形状/正则「镜像实现」，任何形状变更两侧必须同步改。

import type { Course, FormalSection } from "../../types";

// ---------- 候选行格式 ----------
// 一行一班，管道分隔，字段序固定（9 段）：
//   cid|课名|学分|性质|教师|评分|余量|时间|班级
// 例：160086|大学体育Ⅲ|1|公共必修课|张三|4.5(12)|23/60|一3,4/三8,9|01班
// 评分 = "均分(人数)" 或 "-"；余量 = "剩余/容量" 或 "-"；时间 = 紧凑中文（周几+节次）或 "-"。
// 分组标题行以 "## " 开头（如 "## 方案内选修"），不参与行校验。
// 服务端逐行用同一正则校验形状 —— 这是防「借候选块把任意 prompt 直通上游」的硬闸。
export const CANDIDATE_LINE_RE =
  /^[0-9A-Za-z]{4,12}\|[^|\n]{1,60}\|\d+(?:\.\d+)?\|[^|\n]{0,20}\|[^|\n]{0,40}\|[^|\n]{0,16}\|[^|\n]{0,16}\|[^|\n]{0,80}\|[^|\n]{0,40}$/;

/** 候选块行数上限（截断由 candidates.ts 负责并在 stats 里披露；服务端超限直接 400）。 */
export const CANDIDATE_MAX_LINES = 400;
/** 用户偏好长度上限（前端 UI 限制 + 服务端硬校验）。 */
export const PREFERENCE_MAX_CHARS = 500;
/** 学生上下文摘要长度上限（服务端硬校验）。 */
export const CONTEXT_MAX_CHARS = 4000;

// ---------- POST /api/ai/recommend 契约 ----------

export interface AiRecommendRequest {
  /** localStorage 的 voter UUID（src/lib/voter.ts），仅作配额 scope，不是身份。 */
  voterId: string;
  /** planKey，如 "2024级-计算机科学与技术（师范）"。 */
  plan: string;
  /** 学生上下文摘要：纯文本多行，只含缺口数字/已占时段/约束，不含学号、姓名、成绩明细。 */
  context: string;
  /** 候选块：候选行 + "## " 分组标题行。 */
  candidates: string;
  /** 用户偏好一句话（可空串）。 */
  preference: string;
}

export interface AiPick {
  cid: string;
  /** 候选行第 9 段（班级）的**原文**。LLM 只做回显，不自行拼 key；
   *  校验层用 keyByClassName（`${cid}|${班级段原文}` -> 完整 optionKey）解成
   *  schedulePlacement.sectionOptionKey 形状（`${className}|${teacherId}`）后才写 chosen。
   *  候选集构建时若同课同班级名撞车，班级段会带教师名后缀保证可解歧。 */
  sectionKey: string;
  /** 推荐理由，≤60 字，纯文本（渲染层禁 URL/HTML）。 */
  reason: string;
}

export interface AiRecommendResponse {
  picks: AiPick[];
  /** 整体策略一句话。 */
  strategy: string;
  /** 上游用量回显（可选，监控用）。 */
  usage?: { in: number; out: number };
}

export type AiErrorCode =
  | "bad_request"   // 形状校验不过
  | "quota_voter"   // 该用户今日次数用完
  | "quota_site"    // 全站今日次数用完
  | "budget"        // 全站 token 熔断
  | "upstream"      // LLM 侧失败（含重试后仍坏 JSON）
  | "disabled";     // AI_API_KEY 未配置

export interface AiErrorResponse {
  error: string;
  code: AiErrorCode;
}

// ---------- candidates.ts 输出 ----------

/** 选班 key 与 schedulePlacement.sectionOptionKey 同构：`${className}|${teacherId}`。 */
export type SectionOptionKey = string;

export interface AiCandidateBundle {
  /** AiRecommendRequest.context 的内容。 */
  context: string;
  /** AiRecommendRequest.candidates 的内容。 */
  candidates: string;
  /** 发出去的候选全集：cid -> 该课发出的班级 key 集（"className|teacherId"）。校验层白名单第一重。 */
  whitelist: Map<string, Set<SectionOptionKey>>;
  /** 候选行 `${cid}|${班级段原文}` -> 完整 optionKey 的解歧映射（AiPick.sectionKey 解析用）。 */
  keyByClassName: Map<string, SectionOptionKey>;
  /** 发出去的每个 cid 的课名/学分。courses.json 并非全集（只在往期学期开过课的方案选修不在其中），
   *  校验/渲染层 Course 查不到时用它兜底展示与学分重演（增量字段，不改既有语义）。 */
  infoByCid: Map<string, { name: string; credits: number }>;
  /** 统计与截断披露（UI 显示「已按评分截断 N 个班级」）。 */
  stats: { courses: number; sections: number; truncatedSections: number; approxTokens: number };
}

// ---------- validate.ts 输出 ----------

export type PickIssue =
  | "unknown_cid"       // 不在候选白名单（实际发给 LLM 的集合是唯一权威；置灰，不可选）
  | "unknown_section"   // cid 对但班级对不上（置灰，不可选）
  | "taken"             // 已修（置灰，不可选）
  | "duplicate"         // AI 重复推荐同一门课（仅保留第一条，其余置灰）
  | "already_in_cart"   // 已在待选清单（默认不勾，可选）
  | "conflict"          // 与下学期必修/已勾选项时间冲突（黄色警示，可勾）
  | "ge_limit"          // 使公选课超过 2 门（黄色警示，可勾）
  | "any_elective_limit"; // 使任意选修超过 2 门（黄色警示，可勾）

export interface ValidatedPick {
  pick: AiPick;
  course: Course | null;
  /** 解析后的展示课名（course ?? infoByCid 兜底；均无 → null，渲染层退回 cid）。 */
  name: string | null;
  /** 解析后的学分（course ?? infoByCid 兜底；projectSelection 的学分来源，勿再直读 course.credits）。 */
  credits: number | null;
  /** 精确匹配到的班级（planTerm 学期或回退学期）。 */
  section: FormalSection | null;
  /** 解歧后的完整选班 key（写 chosen 用）。 */
  optionKey: SectionOptionKey | null;
  issues: PickIssue[];
  /** 与谁冲突（课名列表，issues 含 conflict 时非空）。 */
  conflictWith: string[];
  /** false = 含 unknown_cid / unknown_section / taken / duplicate 之一，置灰不可选。 */
  selectable: boolean;
}

/** 勾选集实时重演结果（AiTab 每次勾选变化后调用）。 */
export interface SelectionProjection {
  /** 下学期理论学分（必修 + 现有 cart + 勾选项），即 view.nextSemCredits 的重演值。 */
  nextSemCredits: number;
  cap: number;          // 30 / 转专业 34
  over: boolean;
  /** 勾选集内部 + 与必修/已选班的冲突对（课名 x 课名）。 */
  conflicts: [string, string][];
}
