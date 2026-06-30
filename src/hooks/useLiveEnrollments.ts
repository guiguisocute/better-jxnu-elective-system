import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormalSection } from "../types";
import {
  buildEnrollmentResolver,
  LIVE_ENROLLMENT_API,
  parseLiveEnrollmentSnapshot,
} from "../lib/liveEnrollments";
import type { LiveEnrollmentSnapshot, LiveEnrollmentStatus } from "../lib/liveEnrollments";

const DEFAULT_INTERVAL = 30_000;
const STALE_AFTER = 90_000;

export function useLiveEnrollments(
  sections: FormalSection[],
  selectedSemester: string,
  enabled: boolean,
) {
  const [snapshot, setSnapshot] = useState<LiveEnrollmentSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [nextPollAt, setNextPollAt] = useState<string | null>(null);
  const inFlight = useRef(false);
  const lastFetchedAt = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setRefreshing(false);
      setStale(false);
      setNextPollAt(null);
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
          setSnapshot(parsed);
          lastFetchedAt.current = parsed.fetchedAt;
          setError(null);
          setStale(Date.now() - Date.parse(parsed.fetchedAt) > STALE_AFTER);
          nextDelay = parsed.refreshIntervalMs;
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
          setNextPollAt(new Date(Date.now() + nextDelay).toISOString());
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
    nextRefreshAt: nextPollAt,
    refreshIntervalMs: snapshot?.refreshIntervalMs ?? DEFAULT_INTERVAL,
  };
  return { getEnrollment, status };
}
