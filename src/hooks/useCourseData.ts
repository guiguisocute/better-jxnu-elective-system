import { useState, useEffect, useCallback, useMemo } from "react";
import type { Course } from "../types";
import { loadDataJson, loadDataManifest } from "../lib/dataClient";

const COURSE_TYPES = [
  "公选课",
  "公共必修课",
  "教师教育课程",
  "专业主干",
  "专业限选",
  "专业任选",
  "专业类基础",
  "大学英语特色课",
  "任意选修",
];

export function useCourseData() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadDataManifest()
      .then((manifest) => loadDataJson<Course[]>(manifest.courses))
      .then((data) => {
        if (cancelled) return;
        setCourses(data);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [nonce]);

  const reload = useCallback(() => {
    setError(null);
    setLoading(true);
    setNonce((n) => n + 1);
  }, []);

  const options = useMemo(() => {
    const allDepts = [...new Set(courses.map((c) => c.dept).filter(Boolean))].sort();
    const allCredits = [...new Set(courses.map((c) => c.credits))].filter((c) => c > 0).sort((a, b) => a - b);
    const allTags = [...new Set(courses.flatMap((c) => c.tags))].sort();
    const allPlans = [...new Set(
      courses.flatMap((c) => c.plans.map((p) => `${p.year}级-${p.major}`))
    )].sort((a, b) => {
      const ya = a.slice(0, 4);
      const yb = b.slice(0, 4);
      if (ya !== yb) return yb.localeCompare(ya);
      return a.localeCompare(b);
    });
    return {
      allDepts,
      allCredits,
      allTags,
      allPlans,
      subTags: allTags.filter((t) => !COURSE_TYPES.includes(t)),
    };
  }, [courses]);

  return { courses, loading, error, reload, ...options, courseTypes: COURSE_TYPES };
}
