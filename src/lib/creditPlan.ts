import type { Course, MajorRequirement, PlanCourse } from "../types";
import { matchedPlans } from "./planMatch";
import { termIndexOf, effectiveTermIndex, isDeferredSettlement } from "./term";

// 学分核算视图模型 —— 纯派生，零持久化。两大块（用户口径）：
//   必修 = 公共必修(课) + 专业主干 + 专业类基础 + 教师教育必修（强制修满）
//   选修 = 其余（公选课/专业任选/任意选修…），只为凑满「毕业最低总学分」；专业限选是其中的硬性子目标
//
// 学期语义（v2 重构）：term = **当前在读**学期；选课规划的是**下学期** planTerm = term + 1。
//   - 非本学期必修(prevReq, ti ≤ term-1)：已通过，含在教务总分里。
//   - 本学期必修(readReq, ti == term)：在读、未考试，默认按理论计入（浅蓝）。
//   - 下学期必修(nextReq, ti == planTerm)：本次选课要排的课，红色「理论投影」+ 周课表落格。
//   - 教务总分(totalEarned) 完全不含在读本学期（连本学期必修也不含）。
//   - 选修已修 = (totalEarned − 非本学期必修) + 本学期(在读)选修。

// 必修性质（已归一化：公共必修→公共必修课）。师范专业的「教师教育必修」也算强制必修。
export const REQUIRED_NATURES = ["公共必修课", "专业主干", "专业类基础", "教师教育必修"];
// byNature 的 key 是 raw（未归一化的「公共必修」；教师教育必修 不归一化）。
const REQUIRED_NATURES_RAW = ["公共必修", "专业主干", "专业类基础", "教师教育必修"];

const NEXT_SEM_CAP = 30;
// 转专业学生学分上限放宽到 34（教务规则）。
const TRANSFER_NEXT_SEM_CAP = 34;
// 转专业边界：前 N 学期视为「原专业修读」。
const TRANSFER_BOUNDARY = 2;

export type BlockKey = "required" | "elective";

// 已修学分的颜色分段（环图 / 进度条共用）。
export interface CreditSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

export interface CreditBlock {
  key: BlockKey;
  label: string;
  /** 应修学分。null = 培养方案未匹配。 */
  required: number | null;
  earned: number;
  /** 红色「下学期理论投影」计入本块的部分。 */
  planned: number;
  /** required 为 null 时也为 null。 */
  remaining: number | null;
  color: string;
  /** 已修学分按子类着色拆分（earned 之和）。 */
  segments: CreditSegment[];
  /** 仅选修块：专业限选硬性子目标。 */
  subTarget?: SubTarget | null;
}

/** 块内的硬性子目标（专业限选）。 */
export interface SubTarget {
  label: string;
  required: number;
  earned: number;
  /** 下学期理论：cart 内同性质课程学分（用于环图斜纹紫 + 子条斜纹段，动态随 cart 变化）。 */
  planned: number;
  color: string;
}

/** 用户在引导里填写/勾选的已修信息（持久化在 useCreditPlan）。 */
export interface CreditInputs {
  /** 教务总分（不含在读本学期）= 非本学期必修 + 非本学期选修。 */
  totalEarned: number;
  /** 本学期（在读）已选选修学分（不含必修）。 */
  electiveThisSem: number;
  /** 当前**在读**是培养方案第几学期（1-based，自动推算 + 可手改）。 */
  term: number;
  /** 已修的专业限选课 cid。 */
  takenMajorElectives: Set<string>;
  /** 排除的必修 cid（统一承载：非本学期重修/未修 + 在读预计不过 + 下学期取消选课）。 */
  excludedRequired: Set<string>;
  /** 转专业模式：开启后前 TRANSFER_BOUNDARY 学期的必修/限选仅在原专业匹配时才计入对应分类。 */
  transferMode: boolean;
  /** 原专业前 TRANSFER_BOUNDARY 学期的 cid 集合（同 cid = 抵转入专业对应课）。 */
  transferEarlyCids: Set<string>;
  /** 转专业「已抵」勾选：未与原专业同 cid、但用户确认已从其他课抵掉学分的转入专业前两学期必修 cid。计入已修必修（默认不计）。 */
  transferOffsetCids: Set<string>;
  /** 显示未来学期（ti > planTerm）必修课：核对列表追加这批 + 环图浅蓝规划进度（仅展示，不进待选清单）。 */
  showFutureRequired: boolean;
  /** 校外慕课抵扣：勾选 = +5 学分直接计入选修。 */
  moocOffset: boolean;
  /** 赛事学分抵扣：输入值（浮点）直接计入选修。 */
  competitionOffset: number;
}

/** 红色「下学期理论投影」：下学期自动必修 + 待选清单。 */
export interface CreditProjection {
  value: number;
  color: string;
  nextRequired: number;
  cart: number;
}

export interface CreditPlanView {
  found: boolean;
  blocks: CreditBlock[]; // [必修, 选修]
  minTotal: number | null;
  /** 已修（教务确认 + 在读理论）= 必修块 earned + 选修块 earned。 */
  earned: number;
  /** 红色理论投影（下学期自动必修 + 待选）。 */
  projection: CreditProjection;
  /** 毕业还差 = max(0, minTotal - earned - projection)。minTotal 为 null 时 null。 */
  totalRemaining: number | null;
  /** 毕业超出 = max(0, earned + projection - minTotal)。minTotal 为 null 时 null。 */
  totalOverflow: number | null;
  /** 下学期已规划学分（下学期必修 + 待选清单）= projection.value，对照 30 上限。 */
  nextSemCredits: number;
  nextSemCap: number;
  nextSemOver: boolean;
  /** 下学期应修必修课（auto-import，供课表落格 + 取消必修）。 */
  nextSemRequired: PlanCourse[];
  /** 下学期必修中被用户取消（excludedRequired）的，供待选清单展示「已取消，可恢复」。 */
  nextSemRequiredExcluded: PlanCourse[];
  /** 本学期（在读）必修课（环图本学期必修子类 + 引导核对用）。 */
  readingSemRequired: PlanCourse[];
  /** 下学期必修里属「大学英语 Ⅲ/Ⅳ」、可用大学英语特色课抵消的 cid（Phase 2 用）。 */
  englishOffsetCids: string[];
  /**
   * 「未封顶」的非本学期必修学分（即按勾选/转专业逻辑算出来、还没和 totalEarned 做 min 的原始值）。
   * 用途：当 prevReqRaw > totalEarned 时说明用户填的已修学分 < 核对页勾的必修学分（典型场景：重修很多）。
   * 引导核对页据此弹「请取消重修课程 或 修改已修学分」。
   */
  prevReqRaw: number;
  /** 未来学期（ti > planTerm）必修课全集（核对页追加列表用；勾除态看 excludedRequired）。 */
  futureSemRequired: PlanCourse[];
  /** 未来必修中未被勾除的学分合计（未封顶，诊断用）。 */
  futureReqCredits: number;
  /** 环图实际画出的浅蓝「未来必修」学分（showFutureRequired 关时为 0；封顶在剩余缺口）。 */
  futureReqShown: number;
}

// 子类着色色板。
const SEG_COLOR = {
  prevReq: "#2563EB", // 非本学期必修（深蓝）
  readReq: "#93C5FD", // 本学期必修·在读（浅蓝）
  futureReq: "#E0F2FE", // 未来必修·规划（极浅蓝）
  otherElective: "#10B981", // 其他选修（绿）
  majorElective: "#8B5CF6", // 专业限选（紫）
  projection: "rgba(220,38,38,0.55)", // 下学期理论投影（红）
  remaining: "#f3f4f6", // 剩余（灰）
};
const BLOCK_COLOR: Record<BlockKey, string> = {
  required: SEG_COLOR.prevReq,
  elective: SEG_COLOR.otherElective,
};

// 课程性质 → 主色（沿用设计指南色板；未知性质用中性灰）。其它模块仍在用。
const NATURE_COLOR: Record<string, string> = {
  公共必修: "#F59E0B",
  公共必修课: "#F59E0B",
  专业类基础: "#14B8A6",
  专业主干: "#3B82F6",
  专业必修: "#3B82F6",
  专业限选: "#6366F1",
  专业选修: "#6366F1",
  专业任选: "#0EA5E9",
  公选课: "#10B981",
  教师教育: "#A855F7",
  教师教育必修: "#A855F7",
  教师教育选修: "#A855F7",
  任意选修: "#818CF8",
};
const DEFAULT_COLOR = "#9CA3AF";

export function natureColor(nature: string): string {
  return NATURE_COLOR[nature] ?? DEFAULT_COLOR;
}

/** planKey（"2025级-计算机科学与技术"）→ 匹配的 MajorRequirement，未命中返回 null。 */
export function findRequirement(
  requirements: MajorRequirement[],
  selectedPlan: string,
): MajorRequirement | null {
  if (!selectedPlan) return null;
  const sep = selectedPlan.indexOf("级-");
  if (sep === -1) return null;
  const year = selectedPlan.slice(0, sep);
  const major = selectedPlan.slice(sep + 2);
  return requirements.find((r) => r.year === year && r.major === major) ?? null;
}

/** 一门 cart 课程相对所选方案的归类性质（已归一化）。 */
export function courseNature(course: Course, selectedPlan: string): string {
  const matched = matchedPlans(course, selectedPlan);
  const nature = matched.map((p) => p.nature).find(Boolean);
  if (nature) return nature;
  if (course.tags.some((t) => t === "公选课" || t.startsWith("公选课-"))) return "公选课";
  return "任意选修";
}

type NatureClass = "required" | "majorElective" | "elective";

function classOfNature(nature: string): NatureClass {
  if (REQUIRED_NATURES.includes(nature)) return "required";
  if (nature === "专业限选") return "majorElective";
  return "elective";
}

/** 大学英语 Ⅲ/Ⅳ（可用大学英语特色课抵消）。「（三级）」是级别不是册数，按结尾的 Ⅲ/Ⅳ 判定。 */
export function isEnglishOffsetCourse(name: string): boolean {
  return name.includes("大学英语") && (name.includes("Ⅲ") || name.includes("Ⅳ"));
}

const sumCredits = (cs: PlanCourse[]) => cs.reduce((s, c) => s + c.credits, 0);

export function buildCreditPlan(
  requirement: MajorRequirement | null,
  planCourses: PlanCourse[],
  cartCourses: Course[],
  selectedPlan: string,
  inputs: CreditInputs,
): CreditPlanView {
  const { totalEarned, electiveThisSem, term, takenMajorElectives, excludedRequired, transferMode, transferEarlyCids, transferOffsetCids, showFutureRequired, moocOffset, competitionOffset } = inputs;
  const planTerm = term + 1;

  // 必修 / 限选 应修（byNature.sumXf + minMajorElective 权威）。
  const requiredTotal = requirement
    ? REQUIRED_NATURES_RAW.reduce((s, n) => s + (requirement.byNature[n]?.sumXf ?? 0), 0)
    : 0;
  const minMajorElective = requirement?.minMajorElective ?? 0;
  const minTotal = requirement?.minTotal ?? null;

  // 必修按学期分三组（排除勾除项）。
  let prevReqCredits = 0; // ti ≤ term-1：非本学期必修（已通过，含在教务总分）
  const readingSemRequired: PlanCourse[] = []; // ti == term：在读本学期必修
  const nextSemRequired: PlanCourse[] = []; // ti == planTerm：下学期必修（要选）
  const nextSemRequiredExcluded: PlanCourse[] = [];
  const futureSemRequired: PlanCourse[] = []; // ti > planTerm：未来学期必修（仅规划展示）
  for (const pc of planCourses) {
    if (!REQUIRED_NATURES.includes(pc.nature)) continue;
    // 延迟结算课（如形势与政策）按结算学期归类，不按开课学期 —— 结算前一律是未来必修缺口、永不进课表。
    const ti = effectiveTermIndex(pc.cid, pc.semester);
    if (ti <= 0) continue;
    const excluded = excludedRequired.has(pc.cid);
    const matched = transferEarlyCids.has(pc.cid);
    // 转专业前两学期「未检测到」的必修（原专业无同 cid）：默认不计学分（缺口）。
    //   用户在核对页勾「已抵」(transferOffsetCids) = 已从其他课抵掉该学分 → 计入 prevReq。
    //   不再按 ti+2 窗口自动排进下学期课表（无开课学期限制；要上自行加入待选）。
    const transferGapCounts =
      !transferMode || ti > TRANSFER_BOUNDARY || matched || transferOffsetCids.has(pc.cid);
    if (ti <= term - 1) {
      // 未计入的「原专业已修学分」通过 totalEarned 余量自动落入选修绿色段（公式 totalEarned − prevReq）。
      if (!excluded && transferGapCounts) {
        prevReqCredits += pc.credits;
      }
    } else if (ti === term) {
      if (!excluded) readingSemRequired.push(pc);
    } else if (ti === planTerm && !isDeferredSettlement(pc.cid)) {
      // 延迟结算课即使结算学期 == 下学期也不排课 —— 落到 else 当未来必修缺口。
      if (excluded) nextSemRequiredExcluded.push(pc);
      else nextSemRequired.push(pc);
    } else {
      // ti > planTerm（或延迟结算课）：未来学期必修。全量收集（含被勾除的），浅蓝学分按 excludedRequired 再过滤。
      futureSemRequired.push(pc);
    }
  }
  const readReqCredits = sumCredits(readingSemRequired);
  const nextReqCredits = sumCredits(nextSemRequired);
  futureSemRequired.sort(
    (a, b) =>
      effectiveTermIndex(a.cid, a.semester) - effectiveTermIndex(b.cid, b.semester) ||
      a.name.localeCompare(b.name),
  );

  // 专业限选 已修（用户勾选 ∪ 转专业自动匹配的前两学期限选）。
  // 并集口径：取 has(cid) 而非累加同 cid，避免重复计数。
  let majorElectiveEarned = 0;
  for (const pc of planCourses) {
    if (pc.nature !== "专业限选") continue;
    const ti = termIndexOf(pc.semester);
    const autoFromTransfer =
      transferMode && ti > 0 && ti <= TRANSFER_BOUNDARY && transferEarlyCids.has(pc.cid);
    if (takenMajorElectives.has(pc.cid) || autoFromTransfer) majorElectiveEarned += pc.credits;
  }

  // 待选清单按性质归类累加。
  let cartRequired = 0;
  let cartMajorElective = 0;
  let cartElective = 0;
  for (const c of cartCourses) {
    const cr = c.credits || 0;
    const cls = classOfNature(courseNature(c, selectedPlan));
    if (cls === "required") cartRequired += cr;
    else if (cls === "majorElective") cartMajorElective += cr;
    else cartElective += cr;
  }
  const cartTotal = cartRequired + cartMajorElective + cartElective;

  // 「必修学分只能少不能多」：非本学期必修封顶在教务总分内 —— 已修必修不可能超过实际总学分。
  //   勾「已抵」最多把已在选修里的那部分学分挪回必修（纯重分类），绝不凭空增加 view.earned。
  const effectivePrevReq = Math.min(prevReqCredits, totalEarned);

  // 必修块：已修(蓝) = 非本学期 + 本学期；红色投影 = 下学期必修 + cart 必修。
  const reqEarned = effectivePrevReq + readReqCredits;
  const requiredPlanned = nextReqCredits + cartRequired;

  // 选修块：已修(绿) = (教务总分 − 非本学期必修) + 本学期选修 + 校外抵扣（慕课 +5 / 赛事自定义）；专业限选(紫)为其子段。
  const externalOffset = (moocOffset ? 5 : 0) + Math.max(0, competitionOffset);
  const electiveEarnedTotal = Math.max(0, totalEarned - effectivePrevReq + electiveThisSem + externalOffset);
  const purpleEarned = Math.min(majorElectiveEarned, electiveEarnedTotal);
  const greenOther = Math.max(0, electiveEarnedTotal - purpleEarned);
  const electivePlanned = cartElective + cartMajorElective;
  const electiveRequired = minTotal != null ? Math.max(0, minTotal - requiredTotal) : null;

  // 红色理论投影（针对下学期）。
  const projectionValue = nextReqCredits + cartTotal;
  const projection: CreditProjection = {
    value: projectionValue,
    color: SEG_COLOR.projection,
    nextRequired: nextReqCredits,
    cart: cartTotal,
  };

  // 未来学期必修（ti > planTerm）：极浅蓝规划段，独立列在必修块尾。
  //   - 计入 mkBlock 的 segments，因此 requiredBlock.earned 会随勾选同步增长；
  //   - 仍封顶在「投影后剩余缺口」，避免画出超过 minTotal 的进度；
  //   - earned/totalRemaining 的全局口径也用同一个 futureReqShown，三处保持一致。
  const earnedBeforeFuture = reqEarned + electiveEarnedTotal;
  const gapBeforeFuture = minTotal != null ? Math.max(0, minTotal - earnedBeforeFuture - projectionValue) : 0;
  const futureReqCredits = sumCredits(futureSemRequired.filter((c) => !excludedRequired.has(c.cid)));
  const futureReqShown = showFutureRequired ? Math.min(futureReqCredits, gapBeforeFuture) : 0;

  const mkBlock = (
    key: BlockKey,
    label: string,
    required: number | null,
    segments: CreditSegment[],
    planned: number,
    subTarget: SubTarget | null = null,
  ): CreditBlock => {
    const earned = segments.reduce((s, seg) => s + seg.value, 0);
    return {
      key,
      label,
      required,
      earned,
      planned,
      remaining: required == null ? null : Math.max(0, required - earned - planned),
      color: BLOCK_COLOR[key],
      segments,
      subTarget,
    };
  };

  const requiredBlock = mkBlock(
    "required",
    "必修",
    requirement ? requiredTotal : null,
    [
      { key: "prevReq", label: "非本学期必修", value: effectivePrevReq, color: SEG_COLOR.prevReq },
      { key: "readReq", label: "本学期必修", value: readReqCredits, color: SEG_COLOR.readReq },
      // 未来必修也算进必修块，让条/数值随勾选同步增长（封顶在剩余缺口，避免画过界）。
      ...(futureReqShown > 0 ? [{ key: "futureReq", label: "未来必修", value: futureReqShown, color: SEG_COLOR.futureReq }] : []),
    ],
    requiredPlanned,
  );
  const electiveBlock = mkBlock(
    "elective",
    "选修",
    electiveRequired,
    [
      { key: "otherElective", label: "其他选修", value: greenOther, color: SEG_COLOR.otherElective },
      { key: "majorElective", label: "专业限选", value: purpleEarned, color: SEG_COLOR.majorElective },
    ],
    electivePlanned,
    requirement
      ? { label: "专业限选", required: minMajorElective, earned: majorElectiveEarned, planned: cartMajorElective, color: SEG_COLOR.majorElective }
      : null,
  );

  const blocks: CreditBlock[] = [requiredBlock, electiveBlock];

  // 全局 earned 也把 futureReqShown 算进去，三处口径（必修块/环图/毕业还差）一致。
  const earned = earnedBeforeFuture + futureReqShown;
  const rawTotalGap = minTotal != null ? minTotal - earned - projectionValue : null;
  const totalRemaining = rawTotalGap != null ? Math.max(0, rawTotalGap) : null;
  const totalOverflow = rawTotalGap != null ? Math.max(0, -rawTotalGap) : null;
  const nextSemCap = transferMode ? TRANSFER_NEXT_SEM_CAP : NEXT_SEM_CAP;

  return {
    found: requirement != null,
    blocks,
    minTotal,
    earned,
    projection,
    totalRemaining,
    totalOverflow,
    nextSemCredits: projectionValue,
    nextSemCap,
    nextSemOver: projectionValue > nextSemCap,
    nextSemRequired,
    nextSemRequiredExcluded,
    readingSemRequired,
    englishOffsetCids: nextSemRequired.filter((c) => isEnglishOffsetCourse(c.name)).map((c) => c.cid),
    prevReqRaw: prevReqCredits,
    futureSemRequired,
    futureReqCredits,
    futureReqShown,
  };
}
