// AI帮我选 —— LLM 输出的白名单校验与重演。纯函数、无 React、无 fetch、无副作用。
// 原则：AI 只出主意，不碰状态 —— 任何最终写进 cart/chosen 的内容都必须先在这里
// 用本地数据（实际发给 LLM 的候选白名单）二次核验；解不出精确 optionKey 的班级绝不写 chosen
//（buildPlacement 对非法 key 会静默回退第一个班，等于换课不告知）。
// PickIssue 语义以 ./types.ts 的注释为准。

import type { Course, FormalSection } from "../../types";
import type { CreditPlanView } from "../creditPlan";
import { isAnyElective } from "../planMatch";
import type { MeetSlot } from "../scheduleParse";
import { optionMatchesKey } from "../schedulePlacement";
import { candidateSectionsOf, resolveCandidateSemester } from "./candidates";
import type {
  AiRecommendResponse,
  PickIssue,
  SectionOptionKey,
  SelectionProjection,
  ValidatedPick,
} from "./types";

/** 校验上下文：白名单来自 AiCandidateBundle，其余与候选构建同一份原料（保证同口径）。 */
export interface AiValidateContext {
  /** planKey，如 "2024级-计算机科学与技术"。 */
  plan: string;
  /** 规划学期日历 key = termToCalLabel(enrollYear(plan), term+1)，与候选构建同源；
   *  取班学期由 resolveCandidateSemester 统一解析（规划学期未发布 → 当前进行中的开课安排）。 */
  planLabel: string;
  view: CreditPlanView;
  courses: Course[];
  formalSections: FormalSection[];
  takenCids: Set<string>;
  cart: string[];
  chosen: Record<string, string>;
  /** AiCandidateBundle.whitelist：发出去的 cid -> optionKey 集。 */
  whitelist: Map<string, Set<SectionOptionKey>>;
  /** AiCandidateBundle.keyByClassName：`${cid}|${班级段原文}` -> optionKey。 */
  keyByClassName: Map<string, SectionOptionKey>;
  /** AiCandidateBundle.infoByCid：发出去的 cid -> 课名/学分（Course 查不到时的展示/学分兜底）。 */
  infoByCid: Map<string, { name: string; credits: number }>;
}

/** 置灰（不可勾选）的硬 issue；其余为黄色警示，可勾。 */
const HARD_ISSUES = new Set<PickIssue>(["unknown_cid", "unknown_section", "taken", "duplicate"]);

const slotKey = (m: MeetSlot) => `${m.day},${m.slot}`;

const isGeneralElective = (c: Course) =>
  c.tags.some((t) => t === "公选课" || t.startsWith("公选课-"));

/** 已占时段的一个来源（下学期必修 / 待选清单已选班）。 */
interface OccupiedEntry {
  cid: string;
  name: string;
  keys: Set<string>; // "day,slot"
}

// 下学期已占时段：必修 + 现有待选清单，选班取 chosen 覆盖、否则默认第一个班 —— 与
// buildPlacement / candidates.ts 的 context 同口径（默认班就是最终会落格的班）。
function buildOccupied(ctx: AiValidateContext, courseById: Map<string, Course>, targetSem: string | null): OccupiedEntry[] {
  const out: OccupiedEntry[] = [];
  const seen = new Set<string>();
  const push = (cid: string, name: string) => {
    if (seen.has(cid)) return;
    seen.add(cid);
    const { options } = candidateSectionsOf(ctx.formalSections, cid, targetSem);
    // 选班覆盖含旧版 bjh: key 兼容（optionMatchesKey），与 buildPlacement 同判定。
    const active = options.find((o) => optionMatchesKey(o, ctx.chosen[cid])) ?? options[0] ?? null;
    if (!active || active.slots.length === 0) return; // 未发布/无时段 → 不参与冲突判定
    out.push({ cid, name, keys: new Set(active.slots.map(slotKey)) });
  };
  for (const pc of ctx.view.nextSemRequired) push(pc.cid, pc.name);
  for (const cid of ctx.cart) push(cid, courseById.get(cid)?.name ?? cid);
  return out;
}

/** 一个 pick 实际占用的时段（合并班级组的并集；解析不到返回 []）。 */
function slotsOfPick(ctx: AiValidateContext, p: ValidatedPick, targetSem: string | null): MeetSlot[] {
  if (!p.optionKey) return [];
  const { options } = candidateSectionsOf(ctx.formalSections, p.pick.cid, targetSem);
  return options.find((o) => o.key === p.optionKey)?.slots ?? [];
}

/**
 * 逐条校验 AI 返回的 picks（顺序保持原样，UI 按序渲染）：
 * - unknown_cid：以候选 whitelist（实际发给 LLM 的集合）为唯一权威——courses.json 并非全集
 *   （只在往期学期开过课的方案选修不在其中），Course 查不到不代表课不存在，只影响展示兜底；
 * - unknown_section：班级段经 keyByClassName 解歧失败（或解出的 key 不在该 cid 白名单）即标；
 * - taken / duplicate / already_in_cart：按 PickIssue 注释语义；
 * - conflict：与下学期必修已占槽 + 待选清单已选班求交，conflictWith 填课名；
 * - ge_limit / any_elective_limit：把 HomePage.confirmCartLimit 的软上限计数前置 ——
 *   现有 cart + 此前已通过的同类 pick + 该 pick 后 >2 门即标（黄色警示，可勾）。
 */
export function validateAiPicks(resp: AiRecommendResponse, ctx: AiValidateContext): ValidatedPick[] {
  const courseById = new Map(ctx.courses.map((c) => [c.id, c]));
  // 取班学期与候选构建同一解析规则（同入参 → 同结果），保证白名单/时段口径一致。
  const targetSem = resolveCandidateSemester(ctx.formalSections, ctx.planLabel).sem;
  const occupied = buildOccupied(ctx, courseById, targetSem);
  const cartSet = new Set(ctx.cart);

  // 软上限基数：现有清单里的公选 / 任意选修门数（与 confirmCartLimit 同口径）。
  let geCount = 0;
  let anyCount = 0;
  for (const cid of ctx.cart) {
    const c = courseById.get(cid);
    if (!c) continue;
    if (isGeneralElective(c)) geCount += 1;
    else if (isAnyElective(c, ctx.plan)) anyCount += 1;
  }

  const seenCids = new Set<string>();
  const out: ValidatedPick[] = [];
  for (const pick of resp.picks ?? []) {
    const cid = pick.cid;
    const issues: PickIssue[] = [];
    const wl = ctx.whitelist.get(cid);
    const course = courseById.get(cid) ?? null;
    // 白名单是唯一权威：course 为 null 只是「courses.json 没收录」（往期开课的方案选修），不置灰。
    if (!wl) issues.push("unknown_cid");

    // 班级段解歧：LLM 只回显候选行第 9 段原文，这里解成精确 optionKey 才能写 chosen。
    let optionKey: SectionOptionKey | null = null;
    let section: FormalSection | null = null;
    let slots: MeetSlot[] = [];
    if (wl) {
      const resolved = ctx.keyByClassName.get(`${cid}|${(pick.sectionKey ?? "").trim()}`);
      if (resolved && wl.has(resolved)) {
        const { options } = candidateSectionsOf(ctx.formalSections, cid, targetSem);
        const opt = options.find((o) => o.key === resolved);
        if (opt) {
          optionKey = resolved;
          section = opt.section;
          slots = opt.slots;
        }
      }
      if (!optionKey) issues.push("unknown_section");
    }

    if (ctx.takenCids.has(cid)) issues.push("taken");
    // 重复推荐：仅保留第一条（无论第一条本身是否还有别的 issue），其余置灰。
    if (seenCids.has(cid)) issues.push("duplicate");
    seenCids.add(cid);
    if (cartSet.has(cid)) issues.push("already_in_cart");

    const conflictWith: string[] = [];
    if (slots.length > 0) {
      const keys = new Set(slots.map(slotKey));
      for (const oc of occupied) {
        if (oc.cid === cid) continue; // 已在清单的同课自己不和自己冲
        if ([...oc.keys].some((k) => keys.has(k))) conflictWith.push(oc.name);
      }
      if (conflictWith.length > 0) issues.push("conflict");
    }

    const selectable = !issues.some((i) => HARD_ISSUES.has(i));

    // 软上限：只统计「可勾且不在清单」的 pick（已在清单的已计入基数）。
    // course 为 null（仅往期开课的方案选修）时无法归类——方案内课程本就不属公选/任意选修，跳过即可。
    if (course && selectable && !cartSet.has(cid)) {
      if (isGeneralElective(course)) {
        if (geCount >= 2) issues.push("ge_limit");
        geCount += 1;
      } else if (isAnyElective(course, ctx.plan)) {
        if (anyCount >= 2) issues.push("any_elective_limit");
        anyCount += 1;
      }
    }

    // 展示名/学分解析：course 查不到时用候选行披露过的 infoByCid 兜底。
    const info = ctx.infoByCid.get(cid);
    const name = course?.name ?? info?.name ?? null;
    const credits = course?.credits ?? info?.credits ?? null;

    out.push({ pick, course, name, credits, section, optionKey, issues, conflictWith, selectable });
  }
  return out;
}

/**
 * 勾选集实时重演：nextSemCredits = view.nextSemCredits + 勾选项学分和。
 * 不整体重跑 buildCreditPlan —— 它的 projection 本就是线性求和（下学期必修 + cart 各性质学分直加），
 * 增量加法与整体重跑严格等价；且这里拿不到 requirement / planCourses 等全套入参。
 * 已在待选清单的 pick 不再加学分（已含在 view.nextSemCredits 里）。
 * conflicts = 勾选项 vs 必修/已选班（校验时算好的 conflictWith）+ 勾选集内部两两求交。
 */
export function projectSelection(
  picks: ValidatedPick[],
  checkedIdx: Set<number>,
  ctx: AiValidateContext,
): SelectionProjection {
  const chosen: ValidatedPick[] = [];
  let add = 0;
  for (const i of [...checkedIdx].sort((a, b) => a - b)) {
    const p = picks[i];
    if (!p || !p.selectable) continue;
    chosen.push(p);
    // 学分用解析后的 credits（course ?? infoByCid 兜底），别直读 course——它可能为 null。
    if (!p.issues.includes("already_in_cart")) add += p.credits ?? 0;
  }
  const nextSemCredits = ctx.view.nextSemCredits + add;

  const conflicts: [string, string][] = [];
  const pairSeen = new Set<string>();
  const pushPair = (a: string, b: string) => {
    const k = a <= b ? `${a} ${b}` : `${b} ${a}`;
    if (pairSeen.has(k)) return;
    pairSeen.add(k);
    conflicts.push([a, b]);
  };
  const nameOf = (p: ValidatedPick) => p.name ?? p.pick.cid;
  // 1) 勾选项 vs 下学期必修/已选班（复用校验时的 conflictWith）。
  for (const p of chosen) {
    for (const other of p.conflictWith) pushPair(nameOf(p), other);
  }
  // 2) 勾选集内部两两求交。
  const targetSem = resolveCandidateSemester(ctx.formalSections, ctx.planLabel).sem;
  const slotSets = chosen.map((p) => new Set(slotsOfPick(ctx, p, targetSem).map(slotKey)));
  for (let i = 0; i < chosen.length; i++) {
    for (let j = i + 1; j < chosen.length; j++) {
      if (chosen[i].pick.cid === chosen[j].pick.cid) continue;
      if ([...slotSets[i]].some((k) => slotSets[j].has(k))) pushPair(nameOf(chosen[i]), nameOf(chosen[j]));
    }
  }

  return {
    nextSemCredits,
    cap: ctx.view.nextSemCap,
    over: nextSemCredits > ctx.view.nextSemCap,
    conflicts,
  };
}

/**
 * 把勾选的 picks 合并进现有 cart/chosen（合并、不替换）：
 * - cart：追加尚未在清单里的 cid（保持原有顺序在前）；
 * - chosen：勾选项解歧出的精确 optionKey 覆盖同 cid 旧值，其余原样保留。
 * 只吸收 selectable 且解出 optionKey 的 pick —— 落地通道是 HomePage.handleApplyBundle，
 * 这里绝不产出会让 buildPlacement 静默回退的脏 key。
 */
export function buildBundlePatch(
  currentCart: string[],
  currentChosen: Record<string, string>,
  picks: ValidatedPick[],
  checkedIdx: Set<number>,
): { cart: string[]; chosen: Record<string, string> } {
  const cart = [...currentCart];
  const inCart = new Set(currentCart);
  const chosen = { ...currentChosen };
  for (const i of [...checkedIdx].sort((a, b) => a - b)) {
    const p = picks[i];
    if (!p || !p.selectable || !p.optionKey) continue;
    const cid = p.pick.cid;
    if (!inCart.has(cid)) {
      inCart.add(cid);
      cart.push(cid);
    }
    chosen[cid] = p.optionKey;
  }
  return { cart, chosen };
}
