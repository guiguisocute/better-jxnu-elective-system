// AI帮我选 —— 候选集构建：把全量课表 + 培养方案裁成 LLM 可消化的 ~10k token 纯文本。
// 纯函数、无 React、无 fetch、无副作用。输出契约见 ./types.ts（AiCandidateBundle）：
//   - context：学生盘面摘要（只含缺口数字/已占时段，不含学号、姓名、成绩明细，已修课只给数字不给清单）
//   - candidates：候选行（逐行满足 CANDIDATE_LINE_RE）+ "## " 分组标题
//   - whitelist / keyByClassName：校验层白名单与班级段解歧映射（AI 只回显班级段原文，
//     必须经 keyByClassName 精确解成 optionKey 后才允许写 chosen —— buildPlacement 对非法 key 会静默回退第一个班）

import type { Course, FormalSection, PlanCourse } from "../../types";
import type { CreditPlanView } from "../creditPlan";
import { REQUIRED_NATURES } from "../creditPlan";
import { isAnyElective } from "../planMatch";
import type { MeetSlot } from "../scheduleParse";
import { DAY_LABELS, SLOT_KEYS, parseSchedule } from "../scheduleParse";
import { legacyBjhOptionKey, optionMatchesKey, sectionOptionKey } from "../schedulePlacement";
import { enrollYear, termToCalLabel } from "../term";
import type { AiCandidateBundle, SectionOptionKey } from "./types";
import { CANDIDATE_MAX_LINES, CONTEXT_MAX_CHARS } from "./types";

/** 每门课最多发出的班级行数（超出的按评分截断，计入 stats.truncatedSections）。 */
const SECTIONS_PER_COURSE = 4;
/** 当前实际开课的任意选修最多注入的课程门数（偏好命中优先，其次评分）。 */
const ANY_ELECTIVE_MAX = 20;
/** context 里待选清单最多逐条列出的门数（再多折叠成「…等 N 门」）。 */
const CART_LIST_MAX = 30;

// ---------- 共享小工具（validate.ts 也复用） ----------

/** 一门课在候选学期里的一个可选班级（同 className+教号 的多行 section 已合并）。 */
export interface CandidateSection {
  /** 与 schedulePlacement.sectionOptionKey 同构：`${className}|${teacherId}`。 */
  key: SectionOptionKey;
  /** 旧版按 bjh 存下的选班 key（兼容既有 localStorage/分享码里的 `bjh:` 前缀，
   *  与 schedulePlacement.formalOptions 同法收集；查找请走 optionMatchesKey）。 */
  legacyKeys?: string[];
  className: string;
  teacher: string;
  teacherId: string;
  slots: MeetSlot[];
  /** 合并组的第一行原始 section（取余量/详情用）。 */
  section: FormalSection;
}

/**
 * 解析候选取班的唯一权威学期：规划学期已发布 → 规划学期；未发布 → 全量开课数据里最新的
 * 学期（= 目前时间点正在进行的开课安排）。**不做逐课往期回退** —— 目标学期没开的课一律
 * 不进候选：只在往期开过的课很可能已停开，绝不能被 AI 推荐出来。
 */
export function resolveCandidateSemester(
  formalSections: FormalSection[],
  planLabel: string,
): { sem: string | null; isFallback: boolean } {
  let latest: string | null = null;
  for (const s of formalSections) {
    if (planLabel && s.semester === planLabel) return { sem: planLabel, isFallback: false };
    if (latest === null || s.semester > latest) latest = s.semester;
  }
  return { sem: latest, isFallback: latest !== null };
}

/**
 * 某课在目标学期（resolveCandidateSemester 解析出的唯一权威学期）的全部可落格班级。
 * 与 schedulePlacement.buildPlacement 的 formalOptions 同口径：无可解析时段的班级被过滤
 * （buildPlacement 也放不下它们，发出去只会产生写不进 chosen 的 key）。
 * 目标学期没开该课 → options 为空（没有逐课往期回退）。
 */
export function candidateSectionsOf(
  formalSections: FormalSection[],
  cid: string,
  sem: string | null,
): { options: CandidateSection[]; sem: string | null } {
  if (!sem) return { options: [], sem: null };
  const groups = new Map<string, FormalSection[]>();
  for (const s of formalSections) {
    if (s.id !== cid || s.semester !== sem) continue;
    const key = sectionOptionKey(s);
    const rows = groups.get(key) ?? [];
    rows.push(s);
    groups.set(key, rows);
  }
  const options: CandidateSection[] = [...groups]
    .map(([key, rows]) => {
      // 同班级被拆成多行（理论+实验/多时段）时取时段并集。
      const slots: MeetSlot[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        for (const m of parseSchedule(row.schedule)) {
          const k = `${m.day},${m.slot}`;
          if (seen.has(k)) continue;
          seen.add(k);
          slots.push(m);
        }
      }
      return {
        key,
        legacyKeys: [...new Set(rows.map(legacyBjhOptionKey).filter((k): k is string => k !== null))],
        className: rows[0].className,
        teacher: rows[0].teacher,
        teacherId: rows[0].teacherId,
        slots,
        section: rows[0],
      };
    })
    .filter((o) => o.slots.length > 0);
  return { options, sem };
}

/** 时段紧凑格式："一1-2,三8-9"（按周几 + 节次块排序）。 */
export function formatSlots(slots: MeetSlot[]): string {
  const rank = (m: MeetSlot) => m.day * 10 + Math.max(0, SLOT_KEYS.indexOf(m.slot));
  return [...slots]
    .sort((a, b) => rank(a) - rank(b))
    .map((m) => `${DAY_LABELS[m.day] ?? "?"}${m.slot}`)
    .join(",");
}

// ---------- 内部工具 ----------

/** 段内清洗：管道符/换行是行格式的结构字符，正文里一律替换成空格，再按段限长截断。 */
function clean(raw: string | undefined | null, max: number): string {
  return (raw ?? "").replace(/[|\r\n]+/g, " ").trim().slice(0, max);
}

/** 学分段：必须匹配 `\d+(\.\d+)?`（非法/负数一律 "0"）。 */
function fmtCredits(credits: number): string {
  const n = Number(credits);
  return Number.isFinite(n) && n >= 0 ? String(n) : "0";
}

const isGeneralElective = (c: Course) =>
  c.tags.some((t) => t === "公选课" || t.startsWith("公选课-"));

/**
 * 偏好分词：空格分词（≥2 字符）+ 中文连续段的 2-gram。
 * 过滤少量高频虚词 2-gram，避免「我想上一点轻松的课」这类句子命中一堆无关课名。
 */
const TOKEN_STOP = new Set(["喜欢", "想上", "想学", "希望", "不要", "课程", "一点", "有点", "轻松", "老师", "最好", "尽量", "推荐"]);
export function preferenceTokens(preference: string): string[] {
  const out = new Set<string>();
  for (const w of (preference || "").split(/\s+/)) {
    const t = w.trim().toLowerCase();
    if (t.length >= 2 && !TOKEN_STOP.has(t)) out.add(t);
  }
  for (const run of (preference || "").match(/[一-鿿]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const g = run.slice(i, i + 2);
      if (!TOKEN_STOP.has(g)) out.add(g);
    }
  }
  return [...out];
}

/** 一门课构建好的候选行（未提交：commit 时才写 whitelist/keyByClassName/infoByCid）。 */
interface BuiltCourse {
  cid: string;
  /** 展示课名/学分（提交时灌进 infoByCid——courses.json 不含只在往期开课的方案选修，展示要靠它兜底）。 */
  name: string;
  credits: number;
  lines: string[];
  /** 班级段原文 → 完整 optionKey（提交时灌进 keyByClassName）。 */
  regs: Array<{ seg: string; key: SectionOptionKey }>;
  /** 该课发出班级里的最高评分（无评分 = -1），公选组按它降序截断。 */
  bestAvg: number;
  /** 本课因 top-N 截断丢掉的班级数。 */
  truncated: number;
}

// ---------- 主函数 ----------

export interface AiCandidateArgs {
  /** planKey，如 "2024级-计算机科学与技术"。 */
  plan: string;
  view: CreditPlanView;
  /** 当前在读第几学期（选课目标 = term + 1）。 */
  term: number;
  courses: Course[];
  /** 当前所选方案的 plan_courses（已按 cid 去重）。 */
  planCourses: PlanCourse[];
  formalSections: FormalSection[];
  takenCids: Set<string>;
  cart: string[];
  /** useChosenSections 的选班覆盖（必修已占时段按它取班）。 */
  chosen: Record<string, string>;
  ratingOf: (cid: string, teacherId: string) => { avg: number; count: number } | null;
  /** 实时余量；没有实时数据时返回 null（候选行该段写 "-"）。 */
  remainingOf: (s: FormalSection) => { left: number; cap: number } | null;
  preference: string;
}

/**
 * 构建 AI 推荐候选集：context 摘要 + 候选行块 + 白名单/解歧映射。
 * 候选范围 = 本方案选修（非必修性质）+ 全部公选课 + 当前开课的任意选修（按偏好/评分 top 20），
 * 排除已修（takenCids）/ 已在待选清单 / 下学期必修；每门课班级按评分降序截 top 4；
 * 专业限选仅在实际硬缺口 > 0 时单列；专业任选和任意选修进入同一无来源权重的排序池。
 * 总行数 ≤ CANDIDATE_MAX_LINES，超预算时公选组优先按评分截断。
 * **取班学期唯一权威** = resolveCandidateSemester（规划学期，未发布则当前进行中的开课安排）；
 * 该学期没开的课不进候选——绝不按往期开课推荐可能已停开的课。
 */
export function buildAiCandidateBundle(args: AiCandidateArgs): AiCandidateBundle {
  const { plan, view, term, courses, planCourses, formalSections, takenCids, cart, chosen, ratingOf, remainingOf, preference } = args;
  const planTerm = term + 1;
  const planLabel = termToCalLabel(enrollYear(plan), planTerm);
  const { sem: targetSem, isFallback } = resolveCandidateSemester(formalSections, planLabel);
  const cartSet = new Set(cart);
  const courseById = new Map(courses.map((c) => [c.id, c]));
  const nextReqCids = new Set(view.nextSemRequired.map((c) => c.cid));
  const electiveBlock = view.blocks.find((b) => b.key === "elective") ?? null;
  const majorElectiveTarget = electiveBlock?.subTarget ?? null;
  const majorElectiveGap = majorElectiveTarget
    ? Math.max(0, majorElectiveTarget.required - majorElectiveTarget.earned - majorElectiveTarget.planned)
    : 0;
  const tokens = preferenceTokens(preference);

  const scorePreference = (text: string): number => {
    const hay = text.toLowerCase();
    return tokens.reduce((score, token) => score + (hay.includes(token) ? 1 : 0), 0);
  };

  const whitelist = new Map<string, Set<SectionOptionKey>>();
  const keyByClassName = new Map<string, SectionOptionKey>();
  const infoByCid = new Map<string, { name: string; credits: number }>();
  const emitted = new Set<string>();
  let truncatedSections = 0;
  let sectionsCount = 0;
  let budget = CANDIDATE_MAX_LINES;

  /** 已修 / 已在清单 / 已发出 / 下学期必修 —— 一律不进候选。 */
  const skip = (cid: string) =>
    takenCids.has(cid) || cartSet.has(cid) || emitted.has(cid) || nextReqCids.has(cid);

  // 一门课 → 候选行组。班级按评分降序截 top N；同课同班级名撞车时班级段带教师名后缀解歧。
  const buildCourse = (cid: string, name: string, credits: number, nature: string): BuiltCourse | null => {
    if (!/^[0-9A-Za-z]{4,12}$/.test(cid)) return null; // cid 形状不合 CANDIDATE_LINE_RE，整课跳过
    const { options } = candidateSectionsOf(formalSections, cid, targetSem);
    if (options.length === 0) return null;
    const avgOf = (o: CandidateSection) => ratingOf(cid, o.teacherId)?.avg ?? -1;
    const cntOf = (o: CandidateSection) => ratingOf(cid, o.teacherId)?.count ?? 0;
    const sorted = [...options].sort(
      (a, b) => avgOf(b) - avgOf(a) || cntOf(b) - cntOf(a) || a.className.localeCompare(b.className),
    );
    const kept = sorted.slice(0, SECTIONS_PER_COURSE);
    let truncated = sorted.length - kept.length;
    // 班级名出现次数（仅统计发出的班级）——重名才需要教师名后缀。
    const nameCount = new Map<string, number>();
    for (const o of kept) nameCount.set(o.className, (nameCount.get(o.className) ?? 0) + 1);
    const lines: string[] = [];
    const regs: Array<{ seg: string; key: SectionOptionKey }> = [];
    const segSeen = new Set<string>();
    let bestAvg = -1;
    for (const o of kept) {
      let seg = clean(o.className, 40) || "-";
      if ((nameCount.get(o.className) ?? 0) > 1) seg = clean(`${o.className}·${o.teacher}`, 40);
      if (segSeen.has(seg)) seg = clean(`${seg}·${o.teacherId}`, 40);
      if (segSeen.has(seg)) {
        truncated += 1; // 极端截断后仍撞车 → 丢弃该班（无法解歧就不发）
        continue;
      }
      segSeen.add(seg);
      const r = ratingOf(cid, o.teacherId);
      if (r && r.avg > bestAvg) bestAvg = r.avg;
      const rem = remainingOf(o.section);
      lines.push(
        [
          cid,
          clean(name, 60) || cid,
          fmtCredits(credits),
          clean(nature, 20),
          clean(o.teacher, 40) || "-",
          r ? clean(`${r.avg.toFixed(1)}(${r.count})`, 16) : "-",
          rem ? clean(`${rem.left}/${rem.cap}`, 16) : "-",
          clean(formatSlots(o.slots), 80) || "-",
          seg,
        ].join("|"),
      );
      regs.push({ seg, key: o.key });
    }
    if (lines.length === 0) return null;
    return { cid, name: name || cid, credits: Number.isFinite(Number(credits)) ? Number(credits) : 0, lines, regs, bestAvg, truncated };
  };

  // 提交一门课：占预算 + 写白名单/解歧映射/展示兜底。预算不足则整课按截断计入 stats。
  const commit = (built: BuiltCourse, group: string[]): boolean => {
    if (built.lines.length > budget) {
      truncatedSections += built.lines.length;
      return false;
    }
    group.push(...built.lines);
    budget -= built.lines.length;
    sectionsCount += built.lines.length;
    truncatedSections += built.truncated;
    emitted.add(built.cid);
    // 三组（方案选修/公选/任意选修）统一走此处 → infoByCid 覆盖全部实际发出的 cid。
    infoByCid.set(built.cid, { name: built.name, credits: built.credits });
    const keys = whitelist.get(built.cid) ?? new Set<SectionOptionKey>();
    for (const { seg, key } of built.regs) {
      keys.add(key);
      keyByClassName.set(`${built.cid}|${seg}`, key);
    }
    whitelist.set(built.cid, keys);
    return true;
  };

  type RankedCourse = { built: BuiltCourse; preferenceScore: number };

  // 专业限选只有在真实硬缺口 > 0 时单列优先；已经达标后与普通选修一起公平排序。
  const majorGapGroup: string[] = [];
  const majorGapBuilt: RankedCourse[] = [];
  const ordinaryBuilt: RankedCourse[] = [];
  for (const pc of planCourses) {
    if (REQUIRED_NATURES.includes(pc.nature) || skip(pc.cid)) continue;
    const built = buildCourse(pc.cid, pc.name, pc.credits, pc.nature);
    if (!built) continue;
    const c = courseById.get(pc.cid);
    const ranked = {
      built,
      preferenceScore: scorePreference(`${pc.name} ${pc.nature} ${c?.dept ?? ""} ${c?.tags.join(" ") ?? ""}`),
    };
    if (pc.nature === "专业限选" && majorElectiveGap > 0) majorGapBuilt.push(ranked);
    else ordinaryBuilt.push(ranked);
  }
  majorGapBuilt.sort(
    (a, b) => b.preferenceScore - a.preferenceScore || b.built.bestAvg - a.built.bestAvg || a.built.cid.localeCompare(b.built.cid),
  );
  for (const item of majorGapBuilt) commit(item.built, majorGapGroup);

  // 任意选修不再要求用户必须先写关键词才有候选资格：从当前实际开课中按偏好、评分取 top 20，
  // 再和专业任选等方案内普通选修放进同一个排序池，不给“是否在方案内”任何额外权重。
  const anyBuilt: RankedCourse[] = [];
  for (const c of courses) {
    if (skip(c.id) || !isAnyElective(c, plan) || isGeneralElective(c)) continue;
    const built = buildCourse(c.id, c.name, c.credits, "任意选修");
    if (!built) continue;
    anyBuilt.push({
      built,
      preferenceScore: scorePreference(`${c.name} ${c.dept} ${c.tags.join(" ")}`),
    });
  }
  anyBuilt.sort(
    (a, b) => b.preferenceScore - a.preferenceScore || b.built.bestAvg - a.built.bestAvg || a.built.cid.localeCompare(b.built.cid),
  );
  ordinaryBuilt.push(...anyBuilt.slice(0, ANY_ELECTIVE_MAX));
  ordinaryBuilt.sort(
    (a, b) => b.preferenceScore - a.preferenceScore || b.built.bestAvg - a.built.bestAvg || a.built.cid.localeCompare(b.built.cid),
  );
  const ordinaryGroup: string[] = [];
  for (const item of ordinaryBuilt) commit(item.built, ordinaryGroup);

  // ---- 组 2：公选课（用剩余预算；超预算时按评分降序保留 = 「公选组优先截」）----
  const geGroup: string[] = [];
  const geBuilt: BuiltCourse[] = [];
  for (const c of courses) {
    if (skip(c.id) || !isGeneralElective(c)) continue;
    const subTag = c.tags.find((t) => t.startsWith("公选课-"));
    const built = buildCourse(c.id, c.name, c.credits, subTag ?? "公选课");
    if (built) geBuilt.push(built);
  }
  geBuilt.sort((a, b) => b.bestAvg - a.bestAvg || a.cid.localeCompare(b.cid));
  for (const built of geBuilt) commit(built, geGroup);

  // ---- 拼候选块（组序固定；空组不输出标题）----
  const blocks: string[] = [];
  if (majorGapGroup.length > 0) blocks.push(`## 专业限选（仅补足 ${majorElectiveGap} 学分硬缺口）`, ...majorGapGroup);
  if (ordinaryGroup.length > 0) blocks.push("## 普通选修（专业任选与任意选修同级）", ...ordinaryGroup);
  if (geGroup.length > 0) blocks.push("## 公选课", ...geGroup);
  const candidates = blocks.join("\n");

  // ---- context 摘要（≤ CONTEXT_MAX_CHARS；不含学号/姓名/成绩明细，已修只给数字）----
  const ctx: string[] = [];
  ctx.push(`培养方案：${plan || "未选择"}；当前在读第 ${term} 学期，本次选课目标为第 ${planTerm} 学期${planLabel ? `（${planLabel}）` : ""}。`);
  ctx.push(
    `学分盘面：毕业最低总学分 ${view.minTotal ?? "未知"}；已获学分（含在读理论）${view.earned}；` +
      `下学期已规划 ${view.nextSemCredits} 学分，上限 ${view.nextSemCap}${view.nextSemOver ? "（已超）" : ""}。`,
  );
  ctx.push(
    `选修块缺口：还需 ${electiveBlock?.remaining ?? "未知"} 学分；` +
      (majorElectiveTarget
        ? majorElectiveGap > 0
          ? `其中专业限选硬缺口 ${majorElectiveGap} 学分，只需补足该数值，不要超额。`
          : "专业限选硬目标已经达标，不再优先推荐。"
        : "没有专业限选硬目标。"),
  );
  ctx.push("普通选修公平规则：专业任选与任意选修优先级完全相同，只按偏好、时段、评分和余量比较，不因是否在培养方案内加权。");
  ctx.push("下学期必修（系统已自动排入，禁止重复推荐）：");
  const occupied: MeetSlot[] = [];
  const occupiedSeen = new Set<string>();
  if (view.nextSemRequired.length === 0) ctx.push("- （无）");
  for (const pc of view.nextSemRequired) {
    const { options } = candidateSectionsOf(formalSections, pc.cid, targetSem);
    // 已占时段口径 = 选班覆盖（chosen，含旧版 bjh: key 兼容）优先，否则默认第一个班 —— 与 buildPlacement 一致。
    const active = options.find((o) => optionMatchesKey(o, chosen[pc.cid])) ?? options[0] ?? null;
    ctx.push(`- ${pc.cid} ${pc.name} ${pc.credits}学分 ${active ? formatSlots(active.slots) : "时间待公布"}`);
    for (const m of active?.slots ?? []) {
      const k = `${m.day},${m.slot}`;
      if (occupiedSeen.has(k)) continue;
      occupiedSeen.add(k);
      occupied.push(m);
    }
  }
  ctx.push(`下学期已占用时段合计：${formatSlots(occupied) || "暂无"}。`);
  if (cart.length > 0) {
    ctx.push("当前待选清单已有（勿重复推荐）：");
    for (const cid of cart.slice(0, CART_LIST_MAX)) {
      const c = courseById.get(cid);
      ctx.push(c ? `- ${cid} ${c.name} ${c.credits}学分` : `- ${cid}`);
    }
    if (cart.length > CART_LIST_MAX) ctx.push(`- …等 ${cart.length - CART_LIST_MAX} 门`);
  } else {
    ctx.push("当前待选清单为空。");
  }
  if (isFallback && targetSem) {
    ctx.push(
      `注意：第 ${planTerm} 学期${planLabel ? `（${planLabel}）` : ""}开课安排尚未发布，` +
        `候选班级取自当前进行中的 ${targetSem} 开课安排，实际开课以正选公布为准。`,
    );
  }
  let context = ctx.join("\n");
  if (context.length > CONTEXT_MAX_CHARS) context = context.slice(0, CONTEXT_MAX_CHARS);

  return {
    context,
    candidates,
    whitelist,
    keyByClassName,
    infoByCid,
    stats: {
      courses: emitted.size,
      sections: sectionsCount,
      truncatedSections,
      // 中文场景的粗略换算（监控/预估用，非计费口径）。
      approxTokens: Math.round((context.length + candidates.length) / 1.6),
    },
  };
}
