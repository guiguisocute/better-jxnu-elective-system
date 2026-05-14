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
  teacher: string;
}
