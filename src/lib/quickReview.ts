// 「评价上学期课程」推导：学号导入的上学期课程记录 ↔ 正选开课安排的班级匹配。
// 原逻辑在 HomePage（快速评价按钮），评价系统 V2 后入口移到 /ratings 子页面。

import type { FormalSection } from "../types";
import { isPassed, type StudentDetailCourse } from "./studentRecord";
import { termToCalLabel, enrollYear } from "./term";

export const formalSectionKey = (s: FormalSection) => `${s.id}|${s.className}|${s.teacherId}`;

const normalizeTeacherName = (v: string | undefined) => (v ?? "").replace(/\s+/g, "");
const splitTeacherNames = (v: string | undefined) =>
  normalizeTeacherName(v).split(/[、,，/]/).map((x) => x.trim()).filter(Boolean);

export const teacherMatches = (sectionTeacher: string, importedTeacher: string | undefined) => {
  const section = normalizeTeacherName(sectionTeacher);
  if (!section) return false;
  const names = splitTeacherNames(importedTeacher);
  if (names.length === 0) return true;
  return names.some((name) => section.includes(name) || name.includes(section));
};

export interface QuickReviewDerived {
  /** 上学期学期 key（无法推导 / 无该学期正选数据时为空串） */
  semester: string;
  /** 匹配到的上学期本人班级（去重后） */
  sections: FormalSection[];
  /** 不可用原因（sections 为空时的提示文案） */
  disabledReason: string;
}

export function deriveQuickReviewSections(args: {
  plan: string;
  term: number;
  /** 第 term 学期成绩是否已出。已出时「上学期」就是它本身，而不是它的前一个。 */
  readingSettled?: boolean;
  importedDetailCourses: StudentDetailCourse[] | undefined;
  formalSections: FormalSection[];
  allSemesters: string[];
}): QuickReviewDerived {
  const { plan, term, readingSettled, importedDetailCourses, formalSections, allSemesters } = args;
  // 刚读完、成绩已出的那一学期才是学生想评价的「上学期」。教务把当前学期切到下一个之后，
  // term 停在刚结束的那一学期上，此时再减 1 会退回到一年前的课。
  const lastTerm = readingSettled ? term : term - 1;
  const semester =
    plan && lastTerm >= 1
      ? (() => {
          const sem = termToCalLabel(enrollYear(plan), lastTerm);
          return sem && allSemesters.includes(sem) ? sem : "";
        })()
      : "";

  const imported = (importedDetailCourses ?? []).filter(
    (c) => !c.supplemented && isPassed(c) && !!c.courseId && c.planTermIndex === lastTerm,
  );

  const importedByCid = new Map<string, StudentDetailCourse[]>();
  for (const c of imported) {
    const list = importedByCid.get(c.courseId) ?? [];
    list.push(c);
    importedByCid.set(c.courseId, list);
  }

  const seen = new Set<string>();
  const sections: FormalSection[] = [];
  if (semester) {
    for (const s of formalSections) {
      if (s.semester !== semester) continue;
      const candidates = importedByCid.get(s.id);
      if (!candidates) continue;
      if (
        candidates.some(
          (c) => teacherMatches(s.teacher, c.teacher) || (!!c.teachingClass && c.teachingClass === s.className),
        )
      ) {
        const key = formalSectionKey(s);
        if (!seen.has(key)) {
          seen.add(key);
          sections.push(s);
        }
      }
    }
  }

  const disabledReason = !plan
    ? "先选择或通过学号导入培养方案"
    : (importedDetailCourses?.length ?? 0) === 0
    ? "先在模拟选课里输入学号导入"
    : !semester
    ? "暂无可匹配的上学期正式开课数据"
    : imported.length === 0
    ? "导入记录里没有上学期课程"
    : sections.length === 0
    ? "上学期课程暂未匹配到任课老师"
    : "";

  return { semester, sections, disabledReason };
}
