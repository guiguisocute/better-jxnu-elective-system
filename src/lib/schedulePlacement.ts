import type { Course, FormalSection, PlanCourse } from "../types";
import { parseSchedule } from "./scheduleParse";
import type { MeetSlot } from "./scheduleParse";
import { courseNature } from "./creditPlan";
import type { StudentScheduleItem, StudentScheduleSnapshot } from "./studentRecord";

// 把「下学期必修 + 待选清单」映射到周课表的可落格条目（下学期 = 在读学期 + 1）。
// 时段优先取规划学期 section；缺失时退回该课最近开课学期（preview，srcSem 标记）。
// SimPanel（面板）与 OnboardingModal（引导第6步）共用，避免逻辑分叉。

export type PlacedKind = "required" | "cart" | "imported";
export type PlacedStatus = "placed" | "none";

/** chosenSections 中表示「使用 D1 学号导入课表」的稳定 key。 */
export const IMPORTED_SCHEDULE_OPTION_KEY = "__student_schedule__";

/** 一门课的一个可选班级（section）。key = "班级名|教号"。 */
export interface PlacedOption {
  key: string;
  slots: MeetSlot[];
  teacher?: string;
  classroom?: string;
  className?: string;
  source: "student" | "formal";
  /** 该班级对应的原始 section（用于点待选清单跳转到对应班级详情）。 */
  section?: FormalSection;
}

export interface PlacedCourse {
  cid: string;
  name: string;
  credits: number;
  kind: PlacedKind;
  /** 在所选培养方案下的课程性质（已归一化）。供网格按标签色着色。 */
  nature: string;
  status: PlacedStatus;
  /** 未落格原因：已导入课表中无此课，或正式课表尚无可解析时段。 */
  noneReason?: "student-record" | "unpublished";
  slots: MeetSlot[];
  teacher?: string;
  classroom?: string;
  /** 时段所取自的学期（用于 preview 提示）。 */
  srcSem?: string;
  /** 该课在所取学期的开课班级数（>1 → 可选班）。 */
  altCount?: number;
  /** 全部可选班级（有时段的）；默认落格 = options[0] 或 chosen 覆盖。 */
  options: PlacedOption[];
  /** 当前落格的班级 key。 */
  activeKey?: string;
}

type Resolved = Pick<PlacedCourse, "status" | "noneReason" | "slots" | "teacher" | "classroom" | "srcSem" | "altCount" | "options" | "activeKey">;

const optionKey = (s: FormalSection) => `${s.className}|${s.teacherId}`;

function slotSignature(slots: MeetSlot[]): string {
  return slots.map((m) => `${m.day},${m.slot}`).sort().join("|");
}

function importedGroups(snapshot: StudentScheduleSnapshot | null): Map<string, StudentScheduleItem[]> {
  const groups = new Map<string, StudentScheduleItem[]>();
  for (const item of snapshot?.items ?? []) {
    if (!item.courseId) continue;
    const rows = groups.get(item.courseId) ?? [];
    rows.push(item);
    groups.set(item.courseId, rows);
  }
  return groups;
}

function uniqueText(values: Array<string | undefined>): string | undefined {
  const out = [...new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v))];
  return out.length > 0 ? out.join(" / ") : undefined;
}

function importedSlots(items: StudentScheduleItem[]): MeetSlot[] {
  const out: MeetSlot[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    for (const slot of parseSchedule(item.schedule ?? "")) {
      const key = `${slot.day},${slot.slot}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(slot);
    }
  }
  return out;
}

export function buildPlacement(
  nextSemRequired: PlanCourse[],
  cartCourses: Course[],
  formalSections: FormalSection[],
  planLabel: string,
  chosen: Record<string, string> = {},
  selectedPlan = "",
  importedSchedule: StudentScheduleSnapshot | null = null,
): PlacedCourse[] {
  const byCid = new Map<string, PlacedCourse>();
  // 快照只约束它所属的规划学期；用户若手动切到别的学期，不能继续套用旧课表。
  const importedApplies = importedSchedule != null
    && (!importedSchedule.semester || !planLabel || importedSchedule.semester === planLabel);
  const activeImportedSchedule = importedApplies ? importedSchedule : null;
  const importedByCid = importedGroups(activeImportedSchedule);

  const resolveFormal = (cid: string): Resolved => {
    const all = formalSections.filter((s) => s.id === cid);
    if (all.length === 0) return { status: "none", noneReason: "unpublished", slots: [], options: [] };
    const sems = [...new Set(all.map((s) => s.semester))];
    const sem = planLabel && sems.includes(planLabel) ? planLabel : [...sems].sort().at(-1)!;
    const inSem = all.filter((s) => s.semester === sem);
    const options: PlacedOption[] = inSem
      .map((s) => ({
        key: optionKey(s),
        slots: parseSchedule(s.schedule),
        teacher: s.teacher,
        classroom: s.classroom,
        className: s.className,
        source: "formal" as const,
        section: s,
      }))
      .filter((o) => o.slots.length > 0);
    if (options.length === 0) return { status: "none", noneReason: "unpublished", slots: [], options: [] };
    const active = options.find((o) => o.key === chosen[cid]) ?? options[0];
    return {
      status: "placed",
      slots: active.slots,
      teacher: active.teacher,
      classroom: active.classroom,
      srcSem: sem,
      altCount: inSem.length,
      options,
      activeKey: active.key,
    };
  };

  const resolve = (cid: string, allowFormalFallback: boolean): Resolved => {
    const items = importedByCid.get(cid);
    // 非空 importedSchedule 代表用户已完成学号导入。D1 没有该门课时，培养方案必修不得猜一个默认班；
    // 用户后来主动加入待选清单的课程仍允许用正式开课数据排班。
    if (!items) {
      if (activeImportedSchedule && !allowFormalFallback) {
        return { status: "none", noneReason: "student-record", slots: [], options: [] };
      }
      return resolveFormal(cid);
    }

    const slots = importedSlots(items);
    const teacher = uniqueText(items.map((x) => x.teacher));
    const classroom = uniqueText(items.map((x) => x.classroom));
    if (slots.length === 0) {
      return {
        status: "none",
        noneReason: "student-record",
        slots: [],
        teacher,
        classroom,
        srcSem: activeImportedSchedule?.semester || planLabel || undefined,
        options: [],
      };
    }

    // 正式开课数据只作为“主动换班”的候选。若其中有一个班与 D1 时段完全相同，
    // 用真实课表 option 替换它，避免列表里出现两个看似相同的班；教师/教室仍以 D1 为准。
    const formal = resolveFormal(cid);
    const exact = formal.options.find((o) => slotSignature(o.slots) === slotSignature(slots));
    const importedOption: PlacedOption = {
      key: IMPORTED_SCHEDULE_OPTION_KEY,
      slots,
      teacher,
      classroom,
      className: activeImportedSchedule?.className,
      source: "student",
      section: exact?.section,
    };
    const options = [importedOption, ...formal.options.filter((o) => o !== exact)];
    const active = options.find((o) => o.key === chosen[cid]) ?? importedOption;
    const activeIsImported = active.source === "student";
    return {
      status: "placed",
      slots: active.slots,
      teacher: active.teacher,
      classroom: active.classroom,
      srcSem: activeIsImported
        ? activeImportedSchedule?.semester || planLabel || undefined
        : formal.srcSem,
      altCount: options.length,
      options,
      activeKey: active.key,
    };
  };

  for (const c of nextSemRequired) {
    byCid.set(c.cid, {
      cid: c.cid,
      name: c.name,
      credits: c.credits,
      kind: "required",
      nature: c.nature,
      ...resolve(c.cid, false),
    });
  }
  for (const c of cartCourses) {
    if (byCid.has(c.id)) continue;
    byCid.set(c.id, {
      cid: c.id,
      name: c.name,
      credits: c.credits || 0,
      kind: "cart",
      nature: courseNature(c, selectedPlan),
      ...resolve(c.id, true),
    });
  }

  // D1 课表可能含培养方案外课/已选选修；它们同样必须出现在真实课表里，不能因不在必修或购物车而丢失。
  for (const [cid, items] of importedByCid) {
    if (byCid.has(cid)) continue;
    const first = items[0];
    byCid.set(cid, {
      cid,
      name: first.courseName || cid,
      credits: items.find((x) => x.credits != null)?.credits ?? 0,
      kind: "imported",
      nature: "已导入课表",
      ...resolve(cid, false),
    });
  }
  return [...byCid.values()];
}

/** 落格时段取自非规划学期的那些学期（用于 preview 提示文案）。 */
export function previewSemsOf(placed: PlacedCourse[], planLabel: string): string[] {
  return [
    ...new Set(
      placed
        .filter((p) => p.status === "placed" && p.srcSem && p.srcSem !== planLabel)
        .map((p) => p.srcSem!),
    ),
  ];
}
