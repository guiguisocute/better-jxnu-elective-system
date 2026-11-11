import { useEffect, useState } from "react";
import type { Course } from "../types";
import { loadDataJson, loadDataManifest } from "../lib/dataClient";
import { catalogForSemester } from "../lib/preselection";

/** 当前目录复用已加载课程，历史目录仅在切换到该学期时加载。 */
export function usePreselectionData(semester: string, enabled: boolean, base: Course[], baseLoading: boolean, baseError: string | null) {
  const [semesters, setSemesters] = useState<string[]>([]);
  const [result, setResult] = useState<{ semester: string; courses: Course[]; error: string | null }>({ semester: "", courses: [], error: null });
  useEffect(() => {
    let cancelled = false;
    void loadDataManifest().then(async (manifest) => {
      if (cancelled) return;
      const urls = manifest.preselectionCourses ?? {};
      const available = Object.keys(urls);
      if (!manifest.preselectionCourses && manifest.currentSemester) available.push(manifest.currentSemester);
      setSemesters(available);
      if (!enabled) return;
      if (semester === manifest.currentSemester) {
        if (baseLoading) return;
        if (baseError) throw new Error(baseError);
        setResult({ semester, courses: catalogForSemester(base, semester), error: null });
        return;
      }
      const courses = urls[semester] ? await loadDataJson<Course[]>(urls[semester]) : [];
      if (!cancelled) setResult({ semester, courses, error: null });
    }).catch((error: Error) => {
      if (!cancelled && enabled) setResult({ semester, courses: [], error: error.message });
    });
    return () => { cancelled = true; };
  }, [semester, enabled, base, baseLoading, baseError]);
  return { allSemesters: semesters, courses: result.semester === semester ? result.courses : [],
    loading: enabled && result.semester !== semester, error: result.semester === semester ? result.error : null };
}
