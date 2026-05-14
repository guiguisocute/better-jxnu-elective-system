import { useState, useEffect } from "react";
import type { Course } from "../types";

export function useCourseData() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/courses.json")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: Course[]) => {
        setCourses(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const allDepts = [...new Set(courses.map((c) => c.dept).filter(Boolean))].sort();
  const allCredits = [...new Set(courses.map((c) => c.credits))].filter((c) => c > 0).sort((a, b) => a - b);
  const allTags = [...new Set(courses.flatMap((c) => c.tags))].sort();
  const allPlans = [...new Set(
    courses.flatMap((c) => c.plans.map((p) => `${p.year}级-${p.major}`))
  )].sort((a, b) => {
    // 年级倒序（2025 在前），同年级按专业名升序。年级是前 4 位数字。
    const ya = a.slice(0, 4);
    const yb = b.slice(0, 4);
    if (ya !== yb) return yb.localeCompare(ya);
    return a.localeCompare(b);
  });
  const courseTypes = [
    "公选课",
    "公共必修课",
    "教师教育课程",
    "专业主干",
    "专业限选",
    "专业任选",
    "专业类基础",
    "大学英语特色课",
    // 「任意选修」是虚拟类型：依赖选中培养方案，含义=不在本方案 + 非公选课，
    // 即"别人专业的课，可作为我的任选"。FilterBar 中无 plan 时按钮变灰禁用。
    "任意选修",
  ];
  const subTags = allTags.filter((t) => !courseTypes.includes(t));

  return { courses, loading, error, allDepts, allCredits, allTags, allPlans, courseTypes, subTags };
}
