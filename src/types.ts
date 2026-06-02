export interface Teacher {
  dept: string;
  id: string;
  name: string;
  gender: string;
}

// 选课阶段：预选 / 正选 / 补退选。后两者数据形态一致，差异只在课程范围与时间跨度。
export type DataSource = "pre" | "formal" | "addDrop";

// 正选/补退选阶段数据：每行 = 一个实际开班的 section。
export interface FormalSection {
  id: string;             // 课程号
  name: string;           // 课程名称
  credits: number;        // 学分（正选 课程信息.学分 > master）
  dept: string;           // 开课学院
  tags: string[];         // 沿用预选标签
  teacher: string;        // 任课教师姓名
  teacherId: string;      // 教号
  schedule: string;       // "星期x-第x节"，多时段以 " / " 分隔
  className: string;      // 班级名称
  classroom: string;      // 教室代号
  capacity: number | null;// 容量（暂留空 = null）
  semester: string;       // 学期 key，例 "2026-09" / "2025-03"（YYYY-MM，秋=09 / 春=03）
  desc: string;           // 课程简介（正选 课程信息.内容简介；详情页与 course.desc 二者取一）
  _search: string;
}

// 正选/补退选列表的「同课程号折叠」分组：一门课 + 其全部班级（已按当前排序排好）。
// course 为按课程号回查的 Course（可能缺失），用于组头的 tag 裁剪 / 培养方案归属高亮。
export interface FormalGroup {
  id: string;             // 课程号
  course?: Course;
  sections: FormalSection[];
}

export interface CoursePlan {
  year: string;
  major: string;
  direction: string;
  nature: string;
  isDegree: boolean;
  semester: string;
}

export interface Course {
  id: string;
  name: string;
  credits: number;
  dept: string;
  semester: string;
  prereqId: string;
  prereqDesc: string;
  desc: string;
  tags: string[];
  teachers: Teacher[];
  isDegreeCourse: boolean;
  plans: CoursePlan[];
  _search: string;
  /** 该课是否出现在当前学期预选目录。false = 仅由当前学期正选(开课安排)补入预选视图。 */
  inPre?: boolean;
  /** 教师名单来自正选(开课安排)的真实授课记录（预选目录缺老师或本就是 formal-only 课）。 */
  teachersFromFormal?: boolean;
}

// 单个 (年级, 专业) 的毕业学分要求 + 按性质汇总。来自 v7 培养方案 JSON 顶层。
// 暂未在 UI 消费，先 build 出 JSON 备用。
export interface MajorRequirement {
  year: string;
  major: string;
  directions: string[];
  minTotal: number;
  minMajorElective: number;
  byNature: Record<string, { count: number; sumXf: number }>;
}

// 培养方案里的一门课（来自 public/plan_courses.json，按 planKey 索引）。
// 用于模拟选课：按学期列必修/限选课、自动核算已修。nature 已归一化（公共必修→公共必修课）。
export interface PlanCourse {
  cid: string;
  name: string;
  nature: string;
  credits: number;
  semester: string; // "第N学期"，可能为空
  isDegree: boolean;
  directions: string[];
}

export interface Filters {
  search: string;
  credits: number[];
  creditsExclude: number[];
  dept: string[];
  deptExclude: string[];
  type: string[];
  typeExclude: string[];
  tag: string[];
  tagExclude: string[];
  /** 上课区域（仅正选/补退选生效）。值来自 src/lib/classroomArea.ts 的 AREAS + OTHER_AREA。 */
  area: string[];
  areaExclude: string[];
  /** 选中的培养方案 key，格式 `年级级-专业`（例 "2025级-计算机科学与技术"）。空串表示未选。
   *  驱动 planMatch 的行高亮 / tag 裁剪，并作为学分核算的方案来源。 */
  plan: string;
  /**
   * 选中培养方案时对课程列表的硬过滤态（胶囊开关，二态）：
   * - "none":    仅做软高亮 + tag 裁剪，列表不变（默认）
   * - "include": 只显示本方案的课程
   * 仅在 plan 非空时生效。
   */
  planFilter: "none" | "include";
  /** 隐藏已修课程（仅模拟选课开启时可用，依赖 useCreditPlan 派生的 takenCids）。 */
  hideTaken: boolean;
}
