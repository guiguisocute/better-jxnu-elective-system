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

/** 一门课的一个可选班级（section）。key = "班级名|教号"。 */
export interface PlacedOption {
  key: string;
  slots: MeetSlot[];
  teacher?: string;
  classroom?: string;
  className?: string;
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
        section: s,
      }))
      .filter((o) => o.slots.length > 0);
    if (options.length === 0) return { status: "none", noneReason: "unpublished", slots: [], options: [] };
    const active = options.find((o) => o.key === chosen[cid]) ?? options[0];
    // 选中的班级（学号导入校对出的默认班 / 用户手动换的班）置顶：选班列表一眼可见，
    // 且班级很多触发折叠时不会被藏在 12 个之后。默认班 == options[0] 时顺序不变。
    const ordered = [active, ...options.filter((o) => o !== active)];
    return {
      status: "placed",
      slots: active.slots,
      teacher: active.teacher,
      classroom: active.classroom,
      srcSem: sem,
      altCount: inSem.length,
      options: ordered,
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

    // 学号导入：所有班级时段都已在正式开课数据里。导入时已按真实课表「校对」出对应班级写入 chosen，
    // 这里直接用正式开课数据排班（chosen 命中即为自动选上的真实班级），不再注入「真实课表」虚拟班。
    const formal = resolveFormal(cid);
    if (formal.options.length > 0) return formal;

    // 校对兜底：正式开课数据里没有这门课的可解析时段（例如规划学期尚未发布该课），
    // 退回用导入课表的时段占位，避免课程从周课表里消失。
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
    return {
      status: "placed",
      slots,
      teacher,
      classroom,
      srcSem: activeImportedSchedule?.semester || planLabel || undefined,
      altCount: 0,
      options: [],
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

/**
 * 校对：把一门导入课程对应到正式开课数据里的同一个班级，返回它的 optionKey（"班级名|教号"）。
 * 优先取 preferredSem（规划学期）的开课，缺则取最近学期。匹配优先级：
 *   教学班名(className)完全吻合 > 教师名 + 时段都吻合 > 时段签名吻合 > 教师名吻合。
 * className 最权威：同教师/同时段的「合班」只能靠它区分；且当导入快照缺时段时（仅有教学班名+教师），
 * 退回教师名会错配到同教师的第一个班（如把「合班吴郁琴.2班」错配成 .1班）。都不中返回 null。
 */
export function matchImportedSection(
  formalSections: FormalSection[],
  preferredSem: string | undefined,
  cid: string,
  items: StudentScheduleItem[],
): string | null {
  const all = formalSections.filter((s) => s.id === cid);
  if (all.length === 0) return null;
  const sems = [...new Set(all.map((s) => s.semester))];
  const sem = preferredSem && sems.includes(preferredSem) ? preferredSem : [...sems].sort().at(-1)!;
  // 教学班名匹配不要求 section 有可解析时段（合班课的某些班时段可能缺失）；
  // 其余按时段/教师匹配的仍要求有时段，避免落到空时段班。
  const inSem = all.filter((s) => s.semester === sem);
  const inSemTimed = inSem.filter((s) => parseSchedule(s.schedule).length > 0);

  // 1) 教学班名完全吻合（最权威）。
  const wantClasses = new Set(
    items.map((x) => x.className?.trim()).filter((v): v is string => !!v),
  );
  if (wantClasses.size > 0) {
    const byClass = inSem.find((s) => !!s.className && wantClasses.has(s.className.trim()));
    if (byClass) return optionKey(byClass);
  }

  if (inSemTimed.length === 0) return null;

  const wantTeachers = new Set(
    (uniqueText(items.map((x) => x.teacher)) ?? "").split(" / ").map((t) => t.trim()).filter(Boolean),
  );
  const wantSig = slotSignature(importedSlots(items));
  const teacherEq = (s: FormalSection) =>
    wantTeachers.size > 0 && !!s.teacher && s.teacher.split(" / ").some((t) => wantTeachers.has(t.trim()));
  const sigEq = (s: FormalSection) => slotSignature(parseSchedule(s.schedule)) === wantSig;

  // 2) 教师 + 时段，3) 时段，4) 教师。
  const both = inSemTimed.find((s) => teacherEq(s) && sigEq(s));
  if (both) return optionKey(both);
  const bySig = inSemTimed.find(sigEq);
  if (bySig) return optionKey(bySig);
  const byTeacher = inSemTimed.find(teacherEq);
  if (byTeacher) return optionKey(byTeacher);
  return null;
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
