import { useState, useEffect, useCallback } from "react";
import {
  subscribe,
  getSnapshot,
  applyOptimistic as storeApplyOptimistic,
  fetchAndSet,
  fetchAllAndSet,
} from "../lib/ratingsStore";

// Shared cache to deduplicate initial fetch
const fetchedCourses = new Set<string>();
let allFetched = false;

function useRatingsStore(courseId?: string) {
  const [data, setData] = useState(() => getSnapshot());

  useEffect(() => {
    const unsub = subscribe(() => setData(getSnapshot()));
    return unsub;
  }, []);

  useEffect(() => {
    if (!courseId) return;
    if (fetchedCourses.has(courseId)) return;
    fetchedCourses.add(courseId);
    fetchAndSet(courseId);
  }, [courseId]);

  return data;
}

export function useAllRatings() {
  const { real, optimistic } = useRatingsStore();

  useEffect(() => {
    if (allFetched) return;
    allFetched = true;
    fetchAllAndSet();
  }, []);

  const getCourseAvg = useCallback(
    (courseId: string): number | null => {
      const teachers = real.get(courseId);
      const opt = optimistic.get(courseId);
      if (!teachers && !opt) return null;
      let total = 0;
      let count = 0;
      const seen = new Set<string>();
      if (teachers) {
        for (const [tid, r] of teachers) {
          total += opt?.has(tid) ? opt.get(tid)! : r.avg_rating;
          count++;
          seen.add(tid);
        }
      }
      if (opt) {
        for (const [tid, val] of opt) {
          if (!seen.has(tid)) { total += val; count++; }
        }
      }
      return count > 0 ? total / count : null;
    },
    [real, optimistic]
  );

  const getTeacherAvg = useCallback(
    (courseId: string, teacherId: string) => {
      const r = real.get(courseId)?.get(teacherId);
      const pending = optimistic.get(courseId)?.get(teacherId);
      if (pending !== undefined) {
        return { avg: pending, count: (r?.count ?? 0) + (r ? 0 : 1) };
      }
      return r ? { avg: r.avg_rating, count: r.count } : null;
    },
    [real, optimistic]
  );

  return { getCourseAvg, getTeacherAvg };
}

export function useRatings(courseId: string | undefined) {
  const { real, optimistic } = useRatingsStore(courseId);

  const getAvg = useCallback(
    (teacherId: string) => {
      if (!courseId) return null;
      const base = real.get(courseId)?.get(teacherId);
      const pending = optimistic.get(courseId)?.get(teacherId);
      if (pending !== undefined) {
        return {
          teacher_id: teacherId,
          avg_rating: pending,
          count: (base?.count ?? 0) + (base ? 0 : 1),
        };
      }
      return base ?? null;
    },
    [courseId, real, optimistic]
  );

  const getCourseAvg = useCallback(() => {
    if (!courseId) return null;
    const teachers = real.get(courseId);
    const opt = optimistic.get(courseId);
    if (!teachers && !opt) return null;
    let total = 0;
    let count = 0;
    const seen = new Set<string>();
    if (teachers) {
      for (const [tid, r] of teachers) {
        total += opt?.has(tid) ? opt.get(tid)! : r.avg_rating;
        count++;
        seen.add(tid);
      }
    }
    if (opt) {
      for (const [tid, val] of opt) {
        if (!seen.has(tid)) { total += val; count++; }
      }
    }
    return count > 0 ? total / count : null;
  }, [courseId, real, optimistic]);

  const applyOptimistic = useCallback(
    (teacherId: string, rating: number) => {
      if (courseId) storeApplyOptimistic(courseId, teacherId, rating);
    },
    [courseId]
  );

  const refresh = useCallback(async (cid: string) => {
    await fetchAndSet(cid);
  }, []);

  const loading = courseId ? !fetchedCourses.has(courseId) : false;

  return { loading, getAvg, getCourseAvg, applyOptimistic, refresh };
}
