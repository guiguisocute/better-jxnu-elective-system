import { useCallback, useEffect, useRef, useState } from "react";
import type { PlanCourse } from "../types";

type PlanCourseMap = Record<string, PlanCourse[]>;

// 懒加载 public/plan_courses.json（约 5MB）：仅在 enabled（模拟选课开启 / 首屏已选方案）时自动 fetch 一次并缓存。
// courses = 当前 planKey 对应的方案课程清单（空方案或未命中 → []）。
// coursesOf(key) = 任意 planKey 的方案课程清单（转专业用，复用同一份缓存 map，不额外 fetch）。
// ensure() = 主动触发加载并拿到整份 map：用于「点了才要、enabled 可能尚未满足」的场景（首屏学号一键导入）。
export function usePlanCourses(enabled: boolean, planKey: string) {
  const [map, setMap] = useState<PlanCourseMap | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // in-flight 句柄：让自动预载与 ensure() 手动加载共享同一次 fetch，避免 5MB 被拉两遍（含 StrictMode 双跑）。
  const inflight = useRef<Promise<PlanCourseMap> | null>(null);

  // 幂等加载整份 map：已加载→立即给；加载中→复用同一请求；失败→清句柄可重试。
  // 直接 resolve 整份数据，供「await 后立刻要用」的场景绕开 state 异步（coursesOf 闭包不会即时更新）。
  const ensure = useCallback((): Promise<PlanCourseMap> => {
    if (map) return Promise.resolve(map);
    if (!inflight.current) {
      setLoading(true);
      setError(null);
      inflight.current = fetch("/plan_courses.json")
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<PlanCourseMap>;
        })
        .then((data) => {
          setMap(data);
          setLoading(false);
          return data;
        })
        .catch((err) => {
          setError((err as Error).message);
          setLoading(false);
          inflight.current = null; // 失败可重试
          throw err;
        });
    }
    return inflight.current;
  }, [map]);

  // enabled 时自动预载（模拟选课开启 / 首屏已选方案）；为 false 时保持懒加载，由 ensure() 按需触发。
  useEffect(() => {
    if (enabled) ensure().catch(() => {}); // 错误已在 ensure 内记录到 error
  }, [enabled, ensure]);

  const courses = planKey && map ? map[planKey] ?? [] : [];
  const coursesOf = useCallback(
    (key: string): PlanCourse[] => (key && map ? map[key] ?? [] : []),
    [map],
  );
  return { courses, coursesOf, ensure, loading, error, ready: map != null };
}
