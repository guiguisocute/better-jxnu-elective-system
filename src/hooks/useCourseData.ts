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
  const courseTypes = [
    "公选课",
    "公共必修课",
    "专业课",
    "教师教育课程",
    "专业主干",
    "专业限选",
    "专业任选",
    "专业类基础",
    "大学英语特色课",
  ];
  const subTags = allTags.filter((t) => !courseTypes.includes(t));

  return { courses, loading, error, allDepts, allCredits, allTags, courseTypes, subTags };
}
