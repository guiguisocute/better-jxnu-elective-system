export interface Teacher {
  dept: string;
  id: string;
  name: string;
  gender: string;
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
  /** 选中的培养方案 key，格式 `年级级-专业`（例 "2025级-计算机科学与技术"）。空串表示未选。 */
  plan: string;
  /**
   * 选中培养方案时对课程列表的硬过滤态：
   * - "none":    仅做软高亮 + tag 裁剪，列表不变（默认）
   * - "include": 只显示本方案的课程
   * - "exclude": 只显示**不在**本方案里的课程
   * 仅在 plan 非空时生效。
   */
  planFilter: "none" | "include" | "exclude";
}
