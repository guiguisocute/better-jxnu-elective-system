import { useState, useEffect, useCallback } from "react";

interface TeacherRating {
  teacher_id: string;
  avg_rating: number;
  count: number;
}

type AllRatings = Record<string, Record<string, { avg: number; count: number }>>;

export function useAllRatings() {
  const [data, setData] = useState<AllRatings>({});

  useEffect(() => {
    fetch("/api/ratings/all")
      .then((r) => r.json())
      .then((d: AllRatings) => setData(d))
      .catch(() => {});
  }, []);

  const getCourseAvg = useCallback(
    (courseId: string): number | null => {
      const teachers = data[courseId];
      if (!teachers || Object.keys(teachers).length === 0) return null;
      const avgs = Object.values(teachers).map((t) => t.avg);
      return avgs.reduce((a, b) => a + b, 0) / avgs.length;
    },
    [data]
  );

  const getTeacherAvg = useCallback(
    (courseId: string, teacherId: string) => data[courseId]?.[teacherId] ?? null,
    [data]
  );

  return { getCourseAvg, getTeacherAvg };
}

export function useRatings(courseId: string | undefined) {
  const [ratings, setRatings] = useState<Map<string, TeacherRating>>(new Map());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!courseId) return;
    setLoading(true);
    fetch(`/api/ratings?courseId=${courseId}`)
      .then((r) => r.json())
      .then((data: TeacherRating[]) => {
        const map = new Map<string, TeacherRating>();
        for (const r of data) map.set(r.teacher_id, r);
        setRatings(map);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [courseId]);

  const getAvg = useCallback(
    (teacherId: string) => ratings.get(teacherId) ?? null,
    [ratings]
  );

  const getCourseAvg = useCallback(() => {
    if (ratings.size === 0) return null;
    let total = 0;
    for (const r of ratings.values()) total += r.avg_rating;
    return total / ratings.size;
  }, [ratings]);

  const refresh = useCallback(async (courseId: string) => {
    const res = await fetch(`/api/ratings?courseId=${courseId}`);
    const data: TeacherRating[] = await res.json();
    const map = new Map<string, TeacherRating>();
    for (const r of data) map.set(r.teacher_id, r);
    setRatings(map);
  }, []);

  return { ratings, loading, getAvg, getCourseAvg, refresh };
}
