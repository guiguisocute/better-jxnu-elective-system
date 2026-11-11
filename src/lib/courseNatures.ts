/** 已知培养方案性质；未知学校原始值仍以字符串保留，避免丢数据。 */
export const COURSE_NATURES = [
  "公共必修课", "专业主干", "专业类基础", "专业必修", "专业选修",
  "专业限选", "计算机限选", "专业任选", "大学英语特色课",
  "教师教育必修", "教师教育选修", "学科基础", "任选", "通识选修", "集中实践",
] as const;
export type KnownCourseNature = typeof COURSE_NATURES[number];
export type CourseNature = KnownCourseNature | (string & {});

/** 常驻筛选项：即使尚未标注任何课程，新性质也可见。 */
export const COURSE_TYPE_OPTIONS: string[] = [
  "公选课", "公共必修课", "教师教育课程", "专业主干", "专业限选",
  "计算机限选", "专业任选", "专业类基础", "大学英语特色课", "任意选修",
];
