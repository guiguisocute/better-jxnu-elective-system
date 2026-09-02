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

// 固定客户端轮询节奏——**绝不对齐后端回传的 nextRefreshAt**。之前那套「按后端时间表 + 5s 下限」
// 的调度，一旦客户端/服务端时钟有偏差（或后端 nextRefreshAt 略滞后于当前时间），
// untilBackend 会长期算出负值/接近 0，导致每次都撞 5s 下限、退化成准秒级轮询——
// 长时间停留后把整棵组件树反复拖入重渲染，是"筛选筛不掉、要 F5"这个 bug 的根因。
// 这条不变量必须守住：2026-09-02 实测采集机时钟比真实时间快 5~9 秒（边缘 nginx 的
// Date 头准、快照 body 里的 fetchedAt 超前），跟着后端时间戳排程一定会翻车。
//
// 间隔本身从 30s 降到 10s：补退选期间席位以秒计变化，后端已经每 5 秒出一份新快照，
// 30s 意味着用户看到的数字最多滞后 30 秒、且后端每 6 轮抓取只有 1 轮被消费。
// 代价是每用户每分钟 6 次 × 约 58KB gz 的边缘出流量，改这个值前先算这笔账。
const CLIENT_POLL_INTERVAL_MS = 10_000;
// 原 30 秒后端节奏下的延迟阈值为 90 秒，即允许连续三轮没有新快照。
// 继续沿用这个比例，避免后端按较长间隔抓取时被前端过早误报为延迟。
const STALE_INTERVALS = 3;

// 延迟阈值必须同时兜住客户端自己的轮询周期：手里的快照再新也不可能新过
// 上一次轮询。后端搬进校园网后一轮只要 3 秒，补退选期间会把间隔调到 5 秒，
// 若仍只按后端间隔算，阈值是 10s×3=30s，而客户端本来就 30 秒才拉一次，
// 于是每个周期末尾都要误报一次「数据延迟」。
function staleThresholdMs(serverIntervalMs: number) {
  return Math.max(serverIntervalMs, CLIENT_POLL_INTERVAL_MS) * STALE_INTERVALS;
}
const REQUEST_TIMEOUT_MS = 12_000;
// 切回前台时：离上次真正发起请求太近就不重复拉，只需恢复固定节奏的下一次调度，
// 避免反复切换标签页时把请求越攒越密。取轮询周期的一半——比周期本身大就等于
// 「切回来必然重新拉」，失去了防抖意义；太小则频繁切标签页会把请求攒密。
const VISIBILITY_REFRESH_MIN_GAP_MS = CLIENT_POLL_INTERVAL_MS / 2;

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
  const refreshIntervalMs = useRef(CLIENT_POLL_INTERVAL_MS);
  const [serverTiming, setServerTiming] = useState({
    nextRefreshAt: null as string | null,
    refreshIntervalMs: CLIENT_POLL_INTERVAL_MS,
  });
  // 上一份快照的「班级→人数」映射，用于和新一份做差，得出「更新 N 条」。
  const prevCounts = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    // 没配 VITE_KKAP_API_URL（fork 未填后端地址）时不轮询：源码里不再有兜底地址，
    // 空串会打成同源相对请求，白白每 30s 拿一个 404。
    if (!enabled || !LIVE_ENROLLMENT_API) {
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
      timer = window.setTimeout(refresh, CLIENT_POLL_INTERVAL_MS);
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
          refreshIntervalMs.current = parsed.refreshIntervalMs;
          setServerTiming((previous) => (
            previous.nextRefreshAt === parsed.nextRefreshAt
            && previous.refreshIntervalMs === parsed.refreshIntervalMs
              ? previous
              : { nextRefreshAt: parsed.nextRefreshAt, refreshIntervalMs: parsed.refreshIntervalMs }
          ));
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
          setStale(Date.now() - Date.parse(parsed.fetchedAt) > staleThresholdMs(parsed.refreshIntervalMs));
        }
      } catch (reason) {
        if (!cancelled) {
          const message = reason instanceof Error && reason.name !== "AbortError"
            ? reason.message
            : "request timeout";
          setError(message);
          setStale(
            (lastFetchedAt.current ? Date.now() - Date.parse(lastFetchedAt.current) : Infinity)
            > staleThresholdMs(refreshIntervalMs.current),
          );
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
    // 倒计时锚在**客户端自己的下一次轮询**上，不再用后端的 nextRefreshAt。
    // 后端节奏（5s）比客户端轮询（10s）快，而客户端要等下一次轮询才会拿到新的
    // 后端时间戳；照着后端的锚点跑，进度条会在每个周期里提前跑完，然后一直卡在
    // 「正在更新…」——实测 92 秒里有 54 秒（59%）显示这四个字，其实前端什么都没干。
    // 采集机时钟还快 5~9 秒，会把这个假倒计时再撑长一截。锚回本地时钟后两者都不影响显示。
    nextRefreshAt: lastPolledAt != null ? new Date(lastPolledAt + CLIENT_POLL_INTERVAL_MS).toISOString() : null,
    refreshIntervalMs: CLIENT_POLL_INTERVAL_MS,
    // 后端抓取节奏只做展示信息（tooltip），不参与任何排程或进度计算。
    serverIntervalMs: serverTiming.refreshIntervalMs,
    lastUpdateCount: lastUpdate?.count ?? 0,
    lastUpdateAt: lastUpdate?.at ?? null,
  };
  return { getEnrollment, isEnrollmentChanged, status };
}
