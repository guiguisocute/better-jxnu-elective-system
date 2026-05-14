import type { Course, CoursePlan } from "../types";

/** 培养方案唯一 key：`年级级-专业` 形如 "2025级-计算机科学与技术"（不区分方向）。 */
export function planKey(p: CoursePlan): string {
  return `${p.year}级-${p.major}`;
}

/** 找出该课程命中当前选中培养方案的 plan 条目（可能多条：同年级同专业的不同方向都算）。 */
export function matchedPlans(course: Course, selectedPlan: string): CoursePlan[] {
  if (!selectedPlan) return [];
  return course.plans.filter((p) => planKey(p) === selectedPlan);
}

/**
 * 出现在培养方案 "课程性质" 列的所有可能值。
 * 这类 tag 受选中培养方案影响——只展示该方案下实际命中的。
 */
const NATURE_TAGS = new Set<string>([
  "专业主干",
  "专业类基础",
  "专业必修",
  "专业选修",
  "专业限选",
  "专业任选",
  "大学英语特色课",
  "教师教育必修",
  "教师教育选修",
]);

/**
 * 选中培养方案后，对一行课程要显示的 tag 做裁剪。
 * - 通用类型 tag (公选课/公共必修课/专业课/教师教育课程/公选课-XXX) 保留
 * - nature tag 仅当该课程在所选方案下实际是这个性质时保留
 * - "学位课" 徽章仅当所选方案下命中且 isDegree=true 时保留
 *
 * 不会修改入参，返回新数组。
 */
export function displayTags(course: Course, selectedPlan: string): string[] {
  if (!selectedPlan) return course.tags;
  const matched = matchedPlans(course, selectedPlan);
  const matchedNatures = new Set(matched.map((p) => p.nature).filter(Boolean));
  const anyDegree = matched.some((p) => p.isDegree);
  return course.tags.filter((t) => {
    if (NATURE_TAGS.has(t)) return matchedNatures.has(t);
    if (t === "学位课") return anyDegree;
    return true;
  });
}

/** 该课程是否出现在所选培养方案里。 */
export function isInPlan(course: Course, selectedPlan: string): boolean {
  if (!selectedPlan) return false;
  return matchedPlans(course, selectedPlan).length > 0;
}
