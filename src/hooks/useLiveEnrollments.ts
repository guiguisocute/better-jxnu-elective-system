import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormalSection } from "../types";
import {
  buildEnrollmentResolver,
  enrollmentChangedKeys,
  enrollmentCountMap,
  LIVE_ENROLLMENT_API,
  parseLiveEnrollmentSnapshot,
} from "../lib/liveEnrollments";
import type { LiveEnrollmentSnapshot, LiveEnrollmentStatus } from "../lib/liveEnrollments";

// 固定客户端轮询节奏——不再对齐后端回传的 nextRefreshAt。之前那套「按后端时间表 + 5s 下限」
// 的调度，一旦客户端/服务端时钟有偏差（或后端 nextRefreshAt 略滞后于当前时间），
// untilBackend 会长期算出负值/接近 0，导致每次都撞 5s 下限、退化成准秒级轮询——
// 长时间停留后把整棵组件树反复拖入重渲染，是"筛选筛不掉、要 F5"这个 bug 的根因。
// 改成固定 30s 间隔，不依赖后端时钟，行为可预测。
const REFRESH_INTERVAL_MS = 30_000;
const STALE_AFTER = 90_000;
const REQUEST_TIMEOUT_MS = 12_000;
// 切回前台时：离上次真正发起请求太近就不重复拉，只需恢复固定节奏的下一次调度，
// 避免反复切换标签页时把请求越攒越密。
const VISIBILITY_REFRESH_MIN_GAP_MS = 10_000;

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
  // 最近一次刷新中「人数有变化」的条目键集合 —— 驱动对应徽章闪烁。
  const [changedKeys, setChangedKeys] = useState<Set<string>>(() => new Set());
  // 客户端本地"上一次轮询完成"时刻——下一次固定发生在它 + REFRESH_INTERVAL_MS，供倒计时展示。
  const [lastPolledAt, setLastPolledAt] = useState<number | null>(null);
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
    let lastFetchStartedAt = 0;

    const scheduleNext = () => {
      window.clearTimeout(timer);
      if (cancelled) return;
      // 后台标签页不排下一轮（此前 finally 里无条件 schedule，隐藏时仍在轮询白耗请求）；
      // 回到前台时 visibilitychange 会立即拉一次或恢复固定节奏。
      if (document.visibilityState === "hidden") return;
      timer = window.setTimeout(refresh, REFRESH_INTERVAL_MS);
    };

    const refresh = async () => {
      if (cancelled || inFlight.current) return;
      inFlight.current = true;
      lastFetchStartedAt = Date.now();
      setRefreshing(true);
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), REQUEST_TIMEOUT_MS);
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
          // setSnapshot 也只在此时调用：快照没变就别换对象引用，
          // 否则 resolver/getEnrollment 每 30s 换新引用，全表 memo 行白白重渲染一遍。
          if (parsed.fetchedAt !== lastFetchedAt.current) {
            const nextCounts = enrollmentCountMap(parsed.items);
            if (prevCounts.current.size > 0) {
              const keys = enrollmentChangedKeys(prevCounts.current, nextCounts);
              setChangedKeys(keys);
              setLastUpdate({ count: keys.size, at: Date.now() });
            }
            prevCounts.current = nextCounts;
            setSnapshot(parsed);
            lastFetchedAt.current = parsed.fetchedAt;
          }
          setError(null);
          setStale(Date.now() - Date.parse(parsed.fetchedAt) > STALE_AFTER);
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
          setLastPolledAt(Date.now());
          scheduleNext();
        }
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        window.clearTimeout(timer);
        return;
      }
      // 回到前台：刚拉过不久就不重复拉，只恢复固定节奏的下一次调度；否则立即拉一次。
      if (Date.now() - lastFetchStartedAt >= VISIBILITY_REFRESH_MIN_GAP_MS) {
        void refresh();
      } else {
        scheduleNext();
      }
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
    (section: FormalSection) => snapshot?.semester === section.semester ? resolver(section).value : null,
    [resolver, snapshot?.semester],
  );
  // 该 section 命中的实时条目是否在最近一次刷新里变了人数 → 徽章闪烁。
  const isEnrollmentChanged = useCallback(
    (section: FormalSection) => {
      if (snapshot?.semester !== section.semester || changedKeys.size === 0) return false;
      const key = resolver(section).key;
      return key != null && changedKeys.has(key);
    },
    [resolver, snapshot?.semester, changedKeys],
  );

  const status: LiveEnrollmentStatus = {
    enabled,
    refreshing,
    stale,
    error,
    fetchedAt: snapshot?.fetchedAt ?? null,
    // 固定客户端节奏：下一次 = 上一次轮询完成 + REFRESH_INTERVAL_MS，不再依赖后端回传的时间戳。
    nextRefreshAt: lastPolledAt != null ? new Date(lastPolledAt + REFRESH_INTERVAL_MS).toISOString() : null,
    refreshIntervalMs: REFRESH_INTERVAL_MS,
    lastUpdateCount: lastUpdate?.count ?? 0,
    lastUpdateAt: lastUpdate?.at ?? null,
  };
  return { getEnrollment, isEnrollmentChanged, status };
}
