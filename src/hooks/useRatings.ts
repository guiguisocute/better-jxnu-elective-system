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
  const [optimistic, setOptimistic] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!courseId) return;
    setLoading(true);
    setOptimistic(new Map());
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
    (teacherId: string) => {
      const base = ratings.get(teacherId);
      const pending = optimistic.get(teacherId);
      if (pending !== undefined) {
        return {
          teacher_id: teacherId,
          avg_rating: pending,
          count: (base?.count ?? 0) + (base ? 0 : 1),
        };
      }
      return base ?? null;
    },
    [ratings, optimistic]
  );

  const getCourseAvg = useCallback(() => {
    if (ratings.size === 0 && optimistic.size === 0) return null;
    let total = 0;
    let count = 0;
    const seen = new Set<string>();
    for (const [tid, r] of ratings) {
      total += optimistic.has(tid) ? optimistic.get(tid)! : r.avg_rating;
      count++;
      seen.add(tid);
    }
    for (const [tid, val] of optimistic) {
      if (!seen.has(tid)) { total += val; count++; }
    }
    return count > 0 ? total / count : null;
  }, [ratings, optimistic]);

  const applyOptimistic = useCallback((teacherId: string, rating: number) => {
    setOptimistic((prev) => new Map(prev).set(teacherId, rating));
  }, []);

  const refresh = useCallback(async (courseId: string) => {
    const res = await fetch(`/api/ratings?courseId=${courseId}`);
    const data: TeacherRating[] = await res.json();
    const map = new Map<string, TeacherRating>();
    for (const r of data) map.set(r.teacher_id, r);
    setRatings(map);
    // Only clear optimistic values confirmed by server
    setOptimistic((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map(prev);
      for (const [tid, val] of prev) {
        const server = map.get(tid);
        if (server && Math.abs(server.avg_rating - val) < 0.01) next.delete(tid);
      }
      return next;
    });
  }, []);

  return { ratings, loading, getAvg, getCourseAvg, applyOptimistic, refresh };
}
