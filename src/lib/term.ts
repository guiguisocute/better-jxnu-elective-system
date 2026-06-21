// 培养方案学期推算：年级(入学年) + 当前日历学期 → 培养方案「第N学期」(1-based)。
// 第1学期 = 入学年秋；之后春/秋各算一个学期，依次 +1。
// 注意：不同口径可能差一（教务有时把入学当年春也算），所以结果在引导里允许用户手改。
// 选课规划的是「下学期」(= 在读学期 + 1)，由上层用 term+1 算，本模块只算在读学期。
//
// 内部 semester key 全量统一为 "YYYY-MM"（秋=09、春=03，按实际开学月份）。
// 历史代码里曾用 "YYYY-春/秋"，迁移后已无该形态；CalTerm.season 仍是中文概念抽象（与日历语义贴合）。

export interface CalTerm {
  year: number;
  season: "春" | "秋";
}

/** 年级字符串（"2025" / "2025级" / "2025级-英语"）→ 入学年 number；取不到返回 NaN。 */
export function enrollYear(yearOrPlanKey: string): number {
  const m = (yearOrPlanKey || "").match(/\d{4}/);
  return m ? Number(m[0]) : NaN;
}

/**
 * 当前「在读」的那个学期是培养方案第几学期（1-based）。
 * （选课规划的是它的下一个学期 = term + 1，由上层计算。）
 * - 秋 = (year - 入学年) * 2 + 1；春 = (year - 1 - 入学年) * 2 + 2
 * - 例：2025级 在 2026春 → 在读第2学期（规划第3 = 2026秋，上层 +1）。
 * 无法推算或结果 < 1 时返回 1。
 */
export function currentPlanTerm(enrollY: number, now: CalTerm): number {
  if (!Number.isFinite(enrollY)) return 1;
  const cur =
    now.season === "秋"
      ? (now.year - enrollY) * 2 + 1
      : (now.year - 1 - enrollY) * 2 + 2;
  return Math.max(1, cur);
}

/** 当前日历学期：月份 2-7 → 春，1 月算上一年秋，其余 → 秋（与 HomePage.currentSemester 同口径）。 */
export function currentCalTerm(now: Date = new Date()): CalTerm {
  const m = now.getMonth() + 1;
  if (m >= 2 && m <= 7) return { year: now.getFullYear(), season: "春" };
  if (m === 1) return { year: now.getFullYear() - 1, season: "秋" };
  return { year: now.getFullYear(), season: "秋" };
}

// 五年制方案第 10-12 学期用中文「第十/十一/十二学期」，需一并识别。
const CN_TERM: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12,
};

/** "第3学期"/"第十学期" → 3/10；取不到返回 0。 */
export function termIndexOf(label: string): number {
  const m = (label || "").match(/第\s*(\d+)\s*学期/);
  if (m) return Number(m[1]);
  const c = (label || "").match(/第\s*([一二三四五六七八九十]+)\s*学期/);
  return c && CN_TERM[c[1]] != null ? CN_TERM[c[1]] : 0;
}

// 延迟结算课程：计划开课学期 ≠ 学分结算学期，且全程不进周课表。
//   形势与政策(028010)：多数方案排在第2学期、全员必修，但成绩到第7学期末才结算。
//   学分核算按「结算学期」(7) 归类 —— 第7学期前不计已修、不自动排课，作为「未来必修」缺口展示。
const DEFERRED_SETTLEMENT_TERM: Record<string, number> = {
  "028010": 7, // 形势与政策
};

/** 该 cid 是否为延迟结算课（按结算学期而非开课学期核算，且不进课表）。 */
export function isDeferredSettlement(cid: string): boolean {
  return cid in DEFERRED_SETTLEMENT_TERM;
}

/** 学分核算用的「有效学期序」：延迟结算课取结算学期，其余等同 termIndexOf(label)。 */
export function effectiveTermIndex(cid: string, label: string): number {
  const t = DEFERRED_SETTLEMENT_TERM[cid];
  return t != null ? t : termIndexOf(label);
}

/** N → "第N学期"。 */
export function termLabel(n: number): string {
  return `第${n}学期`;
}

/**
 * 培养方案「第N学期」→ 日历学期 key（"2026-09"），与 formal_sections.semester / build_data.format_semester 同口径。
 * 第1学期=入学年秋(09)；奇数学期=秋、偶数=春(03)；每两个学期跨一个自然年。
 * enrollY 非法时返回 ""。
 */
export function termToCalLabel(enrollY: number, term: number): string {
  if (!Number.isFinite(enrollY) || term < 1) return "";
  const odd = term % 2 === 1;
  const year = enrollY + (odd ? (term - 1) / 2 : term / 2);
  return `${year}-${odd ? "09" : "03"}`;
}

// 测试学期：仅正选/补退选 视图给它们加「（测试）」后缀 + 顶部提示横幅（数据是借的/占位时提示用户）。
// 预选视图永远不带后缀。
// 2026-09 已改用真实开班数据(openclass_status)，故移出测试集合；将来若再引入借用/占位学期，加进来即可。
const TEST_SEMESTERS = new Set<string>([]);

/** 给定学期 key 是否属于"借数据/未发布"测试集合（用于在详情页给提示）。 */
export function isTestSemester(sem: string): boolean {
  return TEST_SEMESTERS.has(sem);
}

/**
 * 学期 label 展示格式：key 本身已是 "YYYY-MM"，函数职责退化为「按需追加测试后缀」。
 * 例："2026-09" → "2026-09"（预选）/ "2026-09（测试）"（正选 / 补退选，sem ∈ TEST_SEMESTERS）。
 *
 * opts.isFormalView=true 时，若 sem ∈ TEST_SEMESTERS 才追加「（测试）」；
 * 预选侧调用 formatSemesterLabel(sem) 即可（无 flag → 永不带后缀）。
 */
export function formatSemesterLabel(
  sem: string,
  opts?: { isFormalView?: boolean },
): string {
  if (!sem) return sem;
  const suffix = opts?.isFormalView && TEST_SEMESTERS.has(sem) ? "（测试）" : "";
  return `${sem}${suffix}`;
}
