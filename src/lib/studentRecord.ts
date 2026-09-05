// 学生档案导入 —— 形状对齐 D1 student_records.record_json（build_student_records.py 产出）。
// 引导里输学号+姓名即可一键带出 方案/在读学期/已修学分/本学期选修/已修限选/核对必修，跳过手填。
import type { PlanCourse } from "../types";
import { REQUIRED_NATURES, isEnglishOffsetCourse } from "./creditPlan";
import { effectiveTermIndex, isDeferredSettlement } from "./term";

/** 课表里的一节课（正在修读的本学期课程）。schedule 与 formal_sections 同口径："星期三-第89节"，多段以 " / " 连接。 */
export interface StudentScheduleItem {
  courseId: string;
  courseName: string;
  teacher?: string;
  /** 教学班名（如「合班吴郁琴.2班」），与 formal_sections.className 同口径；校对真实班级最权威。 */
  className?: string;
  classroom?: string;
  schedule?: string;
  credits?: number;
}

/**
 * 已由学号导入确认过的规划学期课表快照。
 * `items: []` 仍然是有意义的：表示 D1 明确记录该生本学期无课表，不能再由前端猜班。
 */
export interface StudentScheduleSnapshot {
  items: StudentScheduleItem[];
  semester?: string;
  className?: string;
}

/** 已修明细里的一门课。 */
export interface StudentDetailCourse {
  courseId: string;
  courseName: string;
  credits: number;
  /** 课程性质（已归一化：公共必修课 / 专业限选 …，build 时联 plan_courses 补，可缺）。 */
  nature?: string;
  /** 修读学期原文（"24-25第1学期"，可缺）。 */
  semester?: string;
  /** 该课在培养方案里是第几学期（build 时按 enrollY 推算；0/缺 = 未知）。 */
  planTermIndex?: number;
  /** 成绩，及格判断用；缺省视为通过。 */
  grade?: number | string;
  passed?: boolean;
  /** 学号导入源记录里的任课教师，用于“评价我上学期课程”精确匹配。 */
  teacher?: string;
  teachingClass?: string;
  /** 构建脚本补算的非课表来源课程，不应用于教师评价。 */
  supplemented?: boolean;
}

export interface StudentRecord {
  studentId: string;
  // 脱敏：不含姓名。
  className?: string;
  /** 离线匹配出来的 planKey（"2023级-英语"），未命中则 undefined。 */
  planKey?: string;
  /** 最新规划快照学期 label（如 "26-27第1学期"），不等同当前在读学期。 */
  termLabel?: string;
  /** 本次模拟选课目标学期，统一 key（如 "2026-09"）。 */
  planningSemester?: string;
  /** true 表示该生存在于全校快照，但本学期确认无课表；历史课程与学分仍保留。 */
  noSchedule?: boolean;
  /** 在读是培养方案第几学期（build 算好；缺 = 无法推算）。 */
  readingPlanTerm?: number;
  /**
   * 成绩已出、计入已修学分的最后一个方案学期（含）。后端按「已结束学期」配置给出。
   * 缺省 = readingPlanTerm - 1（旧口径：整个在读学期都不计）；
   * == readingPlanTerm 表示在读学期的成绩也已经出完（学籍预警已更新），那一学期整体计入已修。
   */
  earnedThroughTerm?: number;
  /** 培养方案 ti<=在读 的必修 cid 全集（build 算好；核对必修自动排除用）。 */
  requiredCidsUpToReading?: string[];
  scheduleItems: StudentScheduleItem[];
  detailCourses: StudentDetailCourse[];
  /** 数据来源：live=VPS 教务实时抓取；snapshot=D1 离线快照兜底。缺省视为未知（旧接口）。 */
  source?: "live" | "snapshot";
}

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 一门已修课是否算通过（无成绩字段时默认通过；passed 显式 false / 成绩含「不及格」「F」时不通过）。 */
export function isPassed(c: StudentDetailCourse): boolean {
  if (c.passed === false) return false;
  const g = str(c.grade);
  if (!g) return true;
  if (/不及格|不通过|缺考|作弊|F\b/i.test(g)) return false;
  const n = Number(g);
  if (Number.isFinite(n)) return n >= 60;
  return true;
}

/**
 * 容错解析粘贴 / mock 的学生档案 JSON（字符串或已解析对象皆可）。
 * 字段缺失时降级，形状不对返回 null。
 */
export function parseStudentRecord(input: string | Record<string, unknown>): StudentRecord | null {
  let obj: Record<string, unknown>;
  try {
    obj = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;

  const sid = str(obj.studentId ?? obj.xh ?? obj.学号);
  const rawSchedule = (obj.scheduleItems ?? obj.schedule ?? []) as unknown[];
  const rawDetail = (obj.detailCourses ?? obj.courses ?? []) as unknown[];
  if (!sid && !Array.isArray(rawSchedule) && !Array.isArray(rawDetail)) return null;

  const scheduleItems: StudentScheduleItem[] = (Array.isArray(rawSchedule) ? rawSchedule : []).map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      courseId: str(o.courseId ?? o.kch ?? o.课程号),
      courseName: str(o.courseName ?? o.kcmc ?? o.课程名称),
      teacher: str(o.teacher ?? o.js ?? o.教师) || undefined,
      className: str(o.className ?? o.teachingClass ?? o.教学班) || undefined,
      classroom: str(o.classroom ?? o.js ?? o.教室) || undefined,
      schedule: str(o.schedule ?? o.sksj ?? o.上课时间) || undefined,
      credits: o.credits != null ? num(o.credits) : undefined,
    };
  });

  const detailCourses: StudentDetailCourse[] = (Array.isArray(rawDetail) ? rawDetail : []).map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      courseId: str(o.courseId ?? o.kch ?? o.课程号),
      courseName: str(o.courseName ?? o.kcmc ?? o.课程名称),
      credits: num(o.credits ?? o.xf ?? o.学分),
      nature: str(o.nature ?? o.kcxz ?? o.课程性质) || undefined,
      semester: str(o.semester ?? o.xq ?? o.学期) || undefined,
      planTermIndex: o.planTermIndex != null ? num(o.planTermIndex) : undefined,
      grade: (o.grade ?? o.cj ?? o.成绩) as number | string | undefined,
      passed: typeof o.passed === "boolean" ? o.passed : undefined,
      teacher: str(o.teacher ?? o.js ?? o.教师) || undefined,
      teachingClass: str(o.teachingClass ?? o.jxbmc ?? o.教学班) || undefined,
      supplemented: o.supplemented === true,
    };
  });

  const rawRequired = obj.requiredCidsUpToReading;
  return {
    studentId: sid,
    className: str(obj.className ?? obj.bj ?? obj.班级) || undefined,
    planKey: str(obj.planKey) || undefined,
    termLabel: str(obj.termLabel ?? obj.xq ?? obj.学期) || undefined,
    planningSemester: str(obj.planningSemester) || undefined,
    noSchedule: obj.noSchedule === true,
    readingPlanTerm: obj.readingPlanTerm != null ? num(obj.readingPlanTerm) || undefined : undefined,
    // 0 是合法值（大一上，此前没有任何已修学期），不能用 `|| undefined` 抹掉。
    earnedThroughTerm: obj.earnedThroughTerm != null ? num(obj.earnedThroughTerm) : undefined,
    requiredCidsUpToReading: Array.isArray(rawRequired)
      ? rawRequired.filter((x): x is string => typeof x === "string")
      : undefined,
    scheduleItems,
    detailCourses,
    source: obj.source === "live" || obj.source === "snapshot" ? obj.source : undefined,
  };
}

/**
 * 档案里的学期分界线（导入侧唯一口径，deriveInputsFromRecord / computeImportExclusions 共用）。
 *
 * 教务一开放选课就把当前学期切到下一个，所以「教务当前学期的前一个」= 在读学期（reading）
 * 这条推断，在成绩出完之后仍然会把已经读完的那一学期扣住不算。后端的「已结束学期」配置
 * 给出 settledThrough，前端必须用同一条线，否则后端算 118、页面还是 88。
 *
 * - settledThrough：成绩已出、计入已修的最后一个学期（含）
 * - reading：在读学期；readingSettled 时它已经结算完，不再有「在读」这一段
 * - horizon：已修/在读的最远边界，超过它的是规划学期的预排课，一律不算
 */
function termBounds(record: StudentRecord) {
  const reading = record.readingPlanTerm != null && record.readingPlanTerm > 0 ? record.readingPlanTerm : 0;
  const settledThrough = record.earnedThroughTerm ?? reading - 1;
  return {
    reading,
    settledThrough,
    horizon: Math.max(reading, settledThrough),
    readingSettled: reading > 0 && settledThrough >= reading,
  };
}

/** 该门课属于「规划学期预排」（尚未修读）→ 已修、特色课抵扣、隐藏已修都不能算它。 */
function isBeyondHorizon(pti: number, horizon: number): boolean {
  return horizon > 0 && pti > horizon;
}

/** 学号导入后可一次性回填引导各步的建议值。 */
export interface ImportSuggestion {
  /** 在读培养方案第几学期（缺 = 无法推算，引导沿用自动推算）。 */
  term?: number;
  /** 已修总学分（成绩已出的所有学期，含必修+选修）。在读学期成绩未出时不含它。 */
  totalEarned: number;
  /** 本学期（在读、成绩未出）已选选修学分（含专业限选，不含必修）。readingSettled 时为 0。 */
  electiveThisSem: number;
  /** 已修专业限选 cid（往期 + 本期）。 */
  takenMajorElectiveCids: string[];
  /** 核对必修：培养方案要求但档案里没出现的必修 cid（自动排除）。 */
  excludedRequiredCids: string[];
  /** 已修课程总数（去重 cid）。 */
  takenCount: number;
  /** 本学期总学分（必修+选修，仅供展示）。 */
  readingCredits: number;
  /** 在读学期的成绩也已出完（学分已并入 totalEarned，不再有「在读」这一段）。 */
  readingSettled: boolean;
}

/**
 * 从档案派生引导各步建议值（含特色课抵扣）。
 * 特色课按序号 1:1 抵大英缺口（低 ti 优先），仅影响 excludedRequiredCids（UI 勾选）。
 * 特色课始终当必修处理（不进 electiveThisSem）。
 */
export function deriveInputsFromRecord(record: StudentRecord, planCourses?: PlanCourse[]): ImportSuggestion {
  const term = record.readingPlanTerm;
  const { settledThrough, horizon, readingSettled } = termBounds(record);
  const taken = new Set<string>();
  let pastCount = 0;
  let curCount = 0;
  for (const c of record.detailCourses) {
    if (!isPassed(c)) continue;
    const pti = c.planTermIndex ?? 0;
    // 教务课表含规划学期课程；它们尚未修读，不能进已修、特色课抵扣或隐藏已修。
    if (isBeyondHorizon(pti, horizon)) continue;
    if (c.courseId) taken.add(c.courseId);
    if (c.nature === "大学英语特色课" && pti > 0 && horizon > 0) {
      // 已结算的算「往期」（学分已在 totalEarned 里），只有真正在读的那一学期算「本学期」。
      if (pti <= settledThrough) pastCount += 1;
      else curCount += 1;
    }
  }

  const rawMissing = (record.requiredCidsUpToReading ?? []).filter(
    (cid) => !taken.has(cid) && !isDeferredSettlement(cid),
  );

  // 特色课按序号 1:1 抵大英缺口（低 ti 优先），本学期特色课可抵任何大英。
  // 仅影响 excludedRequiredCids（UI 勾选），不改变特色课分类。
  let excludedRequiredCids = rawMissing;
  if (planCourses && (pastCount > 0 || curCount > 0)) {
    const byCid = new Map(planCourses.map((c) => [c.cid, c]));
    const englishMissing = rawMissing
      .filter((cid) => {
        const pc = byCid.get(cid);
        return pc != null && isEnglishOffsetCourse(pc.name);
      })
      .sort((a, b) => {
        const pa = byCid.get(a)!;
        const pb = byCid.get(b)!;
        return effectiveTermIndex(pa.cid, pa.semester) - effectiveTermIndex(pb.cid, pb.semester);
      });

    const covered = new Set(englishMissing.slice(0, pastCount));
    let remainCur = curCount;
    for (const cid of englishMissing) {
      if (remainCur <= 0) break;
      if (covered.has(cid)) continue;
      covered.add(cid);
      remainCur -= 1;
    }
    excludedRequiredCids = rawMissing.filter((cid) => !covered.has(cid));
  }

  let totalEarned = 0;
  let electiveThisSem = 0;
  let readingCredits = 0;
  const takenMajorElectiveCids: string[] = [];

  for (const c of record.detailCourses) {
    if (!isPassed(c)) continue;
    const pti = c.planTermIndex ?? 0;
    if (isBeyondHorizon(pti, horizon)) continue;
    // 成绩已出的学期整体进 totalEarned；只有还在读、没出成绩的那一学期单列。
    const isReading = horizon > 0 && pti > settledThrough;
    if (c.nature === "专业限选" && c.courseId) takenMajorElectiveCids.push(c.courseId);
    if (isReading) {
      readingCredits += c.credits;
      const isRequired = c.nature != null && (REQUIRED_NATURES.includes(c.nature) || c.nature === "大学英语特色课");
      if (!isRequired) electiveThisSem += c.credits;
    } else {
      totalEarned += c.credits;
    }
  }

  return {
    term: term && term > 0 ? term : undefined,
    totalEarned,
    electiveThisSem,
    takenMajorElectiveCids,
    excludedRequiredCids,
    takenCount: taken.size,
    readingCredits,
    readingSettled,
  };
}

/**
 * 学号导入「核对必修」的自动取消勾选集：培养方案 ti≤在读 的必修全集中、
 * 档案里没修过的 cid → 标缺口（取消勾选）。三条修正：
 *   1) 跳过延迟结算课（形势与政策等不进课表的必修），避免误判成缺口。
 *   2) 已结算学期的特色课（pti ≤ settledThrough）按序号抵任何大英缺口（已在 totalEarned，prevReq 安全）。
 *   3) 在读学期的特色课可抵任何大英缺口（抵更早的大英时学分改入 electiveThisSem 对消）。
 */
export function computeImportExclusions(record: StudentRecord, planCourses: PlanCourse[]): string[] {
  const { settledThrough, horizon } = termBounds(record);
  const taken = new Set<string>();
  let pastCount = 0;
  let curCount = 0;
  for (const c of record.detailCourses) {
    if (!isPassed(c)) continue;
    const pti = c.planTermIndex ?? 0;
    if (isBeyondHorizon(pti, horizon)) continue;
    if (c.courseId) taken.add(c.courseId);
    if (c.nature === "大学英语特色课" && pti > 0 && horizon > 0) {
      if (pti <= settledThrough) pastCount += 1;
      else curCount += 1;
    }
  }

  const byCid = new Map(planCourses.map((c) => [c.cid, c]));
  const missing = (record.requiredCidsUpToReading ?? []).filter(
    (cid) => !taken.has(cid) && !isDeferredSettlement(cid),
  );

  if (pastCount > 0 || curCount > 0) {
    const englishMissing = missing
      .filter((cid) => {
        const pc = byCid.get(cid);
        return pc != null && isEnglishOffsetCourse(pc.name);
      })
      .sort((a, b) => {
        const pa = byCid.get(a)!;
        const pb = byCid.get(b)!;
        return effectiveTermIndex(pa.cid, pa.semester) - effectiveTermIndex(pb.cid, pb.semester);
      });

    // 往期特色课先抵（低 ti 优先），本学期特色课再抵剩余缺口（不限 ti）。
    const covered = new Set(englishMissing.slice(0, pastCount));
    let remainCur = curCount;
    for (const cid of englishMissing) {
      if (remainCur <= 0) break;
      if (covered.has(cid)) continue;
      covered.add(cid);
      remainCur -= 1;
    }
    return missing.filter((cid) => !covered.has(cid));
  }
  return missing;
}

/**
 * 按【学号】拉取学生档案（接 functions/api/student-record → D1 student_records 表）。
 * 脱敏：全程不涉及姓名。学号查不到统一 404。
 * 注意：源数据无成绩字段，detailCourses 一律视为已通过（isPassed 返回 true）。
 */
export async function importStudentRecord(studentId: string, captchaToken = ""): Promise<StudentRecord> {
  const sid = studentId.trim();
  if (!sid) throw new Error("请输入学号。");
  const devDemo = import.meta.env.DEV && /^(demo|local|test)$/i.test(sid);
  if (devDemo) {
    const res = await fetch("/student-record-demo.json", { cache: "no-cache" });
    const rec = parseStudentRecord((await res.json()) as Record<string, unknown>);
    if (!rec) throw new Error("本地 demo 数据格式异常。");
    return rec;
  }

  let res: Response;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (captchaToken) headers["X-Human-Verification-Token"] = captchaToken;
    res = await fetch("/api/student-record", {
      method: "POST",
      headers,
      body: JSON.stringify({ sid }),
    });
  } catch {
    throw new Error("网络异常，稍后再试。");
  }

  // 本地 dev 没起 Functions，/api/* 会回 index.html —— 用 content-type 判一下。
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    if (import.meta.env.DEV) {
      throw new Error("本地 Vite 预览未连接学号库；请输入 demo 体验导入流程。");
    }
    throw new Error("接口未部署或返回了非 JSON。");
  }

  if (res.status === 403) throw new Error("人机验证失败或已过期，请重新验证后再查。");
  if (res.status === 404) throw new Error("没有该学号的记录。");
  if (!res.ok) throw new Error(`服务异常（${res.status}）。`);

  const data = (await res.json()) as Record<string, unknown>;
  const rec = parseStudentRecord(data);
  if (!rec) throw new Error("返回数据格式异常。");
  return rec;
}
