import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormalSection } from "../types";
import {
  buildEnrollmentResolver,
  countEnrollmentChanges,
  enrollmentCountMap,
  LIVE_ENROLLMENT_API,
  parseLiveEnrollmentSnapshot,
} from "../lib/liveEnrollments";
import type { LiveEnrollmentSnapshot, LiveEnrollmentStatus } from "../lib/liveEnrollments";

const DEFAULT_INTERVAL = 30_000;
const STALE_AFTER = 90_000;
const MIN_POLL = 5_000;
// 后端 nextRefreshAt 之后再等这点缓冲才去取（给后端抓取/落盘留时间），避免拿到旧快照。
const POLL_BUFFER = 4_000;

export function useLiveEnrollments(
  sections: FormalSection[],
  selectedSemester: string,
  enabled: boolean,
) {
  const [snapshot, setSnapshot] = useState<LiveEnrollmentSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<{ count: number; at: number } | null>(null);
  const inFlight = useRef(false);
  const lastFetchedAt = useRef<string | null>(null);
  // 上一份快照的「班级→人数」映射，用于和新一份做差，得出「更新 N 条」。
  const prevCounts = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!enabled) {
      setRefreshing(false);
      setStale(false);
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;

    const schedule = (delay: number) => {
      window.clearTimeout(timer);
      if (!cancelled && document.visibilityState === "visible") {
        timer = window.setTimeout(refresh, delay);
      }
    };

    const refresh = async () => {
      if (cancelled || inFlight.current) return;
      inFlight.current = true;
      setRefreshing(true);
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 12_000);
      let nextDelay = DEFAULT_INTERVAL;
      try {
        const response = await fetch(LIVE_ENROLLMENT_API, {
          cache: "no-cache",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        const contentType = response.headers.get("content-type") || "";
        if (!response.ok || !contentType.includes("application/json")) {
          throw new Error(`HTTP ${response.status}`);
        }
        const parsed = parseLiveEnrollmentSnapshot(await response.json());
        if (!parsed) throw new Error("invalid snapshot");
        if (parsed.semester !== selectedSemester) {
          throw new Error(`snapshot semester is ${parsed.semester}`);
        }
        if (!cancelled) {
          // 后端每周期都会刷新 fetchedAt；只有它变了才算「拿到新快照」→ 做差并触发「更新 N 条」。
          if (parsed.fetchedAt !== lastFetchedAt.current) {
            const nextCounts = enrollmentCountMap(parsed.items);
            if (prevCounts.current.size > 0) {
              setLastUpdate({ count: countEnrollmentChanges(prevCounts.current, nextCounts), at: Date.now() });
            }
            prevCounts.current = nextCounts;
          }
          setSnapshot(parsed);
          lastFetchedAt.current = parsed.fetchedAt;
          setError(null);
          setStale(Date.now() - Date.parse(parsed.fetchedAt) > STALE_AFTER);
          // 严格对齐后端 nextRefreshAt：在它之后留点缓冲再轮询，倒计时不随前端轮询重置。
          const untilBackend = Date.parse(parsed.nextRefreshAt) - Date.now();
          nextDelay = Math.min(
            parsed.refreshIntervalMs + 10_000,
            Math.max(MIN_POLL, untilBackend + POLL_BUFFER),
          );
        }
      } catch (reason) {
        if (!cancelled) {
          const message = reason instanceof Error && reason.name !== "AbortError"
            ? reason.message
            : "request timeout";
          setError(message);
          setStale((lastFetchedAt.current ? Date.now() - Date.parse(lastFetchedAt.current) : Infinity) > STALE_AFTER);
        }
      } finally {
        window.clearTimeout(timeout);
        inFlight.current = false;
        if (!cancelled) {
          setRefreshing(false);
          schedule(nextDelay);
        }
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        window.clearTimeout(timer);
        return;
      }
      void refresh();
    };

    document.addEventListener("visibilitychange", handleVisibility);
    void refresh();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", handleVisibility);
      inFlight.current = false;
    };
  }, [enabled, selectedSemester]);

  const semesterSections = useMemo(
    () => sections.filter((section) => section.semester === selectedSemester),
    [sections, selectedSemester],
  );
  const resolver = useMemo(
    () => buildEnrollmentResolver(snapshot?.items ?? [], semesterSections),
    [snapshot?.items, semesterSections],
  );
  const getEnrollment = useCallback(
    (section: FormalSection) => snapshot?.semester === section.semester ? resolver(section) : null,
    [resolver, snapshot?.semester],
  );

  const status: LiveEnrollmentStatus = {
    enabled,
    refreshing,
    stale,
    error,
    fetchedAt: snapshot?.fetchedAt ?? null,
    // 用后端权威的 nextRefreshAt（而非前端轮询时刻），倒计时才不会一轮询就重置。
    nextRefreshAt: snapshot?.nextRefreshAt ?? null,
    refreshIntervalMs: snapshot?.refreshIntervalMs ?? DEFAULT_INTERVAL,
    lastUpdateCount: lastUpdate?.count ?? 0,
    lastUpdateAt: lastUpdate?.at ?? null,
  };
  return { getEnrollment, status };
}
