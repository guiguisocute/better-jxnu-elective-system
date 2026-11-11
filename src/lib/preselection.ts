/** 阶段目标尚未有 raw 时仍提供入口，且绝不混入其他学期目录。 */
export function preselectionSemesters(target: string, catalogSemesters: string[]): string[] {
  return [...new Set([target, ...catalogSemesters].filter((s) => /^\d{4}-(03|09)$/.test(s)))]
    .sort((a, b) => b.localeCompare(a));
}

export function catalogForSemester<T extends { semester: string; inPre?: boolean }>(courses: T[], semester: string): T[] {
  return courses.filter((c) => c.inPre !== false && c.semester === semester);
}
