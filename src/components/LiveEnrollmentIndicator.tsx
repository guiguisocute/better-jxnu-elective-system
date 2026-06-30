import { useEffect, useMemo, useState } from "react";
import type { LiveEnrollmentStatus } from "../lib/liveEnrollments";

export function LiveEnrollmentIndicator({ status, compact = false }: { status: LiveEnrollmentStatus; compact?: boolean }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!status.enabled) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, 250);
    return () => window.clearInterval(timer);
  }, [status.enabled]);

  const view = useMemo(() => {
    const target = status.nextRefreshAt ? Date.parse(status.nextRefreshAt) : now + status.refreshIntervalMs;
    const start = target - status.refreshIntervalMs;
    const progress = Math.max(0, Math.min(100, ((now - start) / status.refreshIntervalMs) * 100));
    const seconds = Math.max(0, Math.ceil((target - now) / 1000));
    if (!status.fetchedAt && status.error) return { progress: 100, label: "实时人数暂不可用", alert: true };
    if (status.stale) return { progress: 100, label: "人数更新延迟", alert: true };
    if (status.refreshing) return { progress: Math.max(progress, 94), label: "正在刷新人数", alert: false };
    if (!status.fetchedAt) return { progress, label: "正在连接人数服务", alert: false };
    return { progress, label: `${seconds}s 后刷新`, alert: false };
  }, [now, status]);

  if (!status.enabled) return null;
  return (
    <div
      className={`${compact ? "w-[112px]" : "w-[138px]"} shrink-0`}
      role="status"
      title={status.error ? `实时人数服务：${status.error}` : "实时人数每 30 秒自动刷新"}
    >
      <div className={`mb-1 flex items-center justify-between text-[10px] font-medium ${view.alert ? "text-amber-600" : "text-gray-500"}`}>
        <span className="inline-flex items-center gap-1">
          <span className={`h-1.5 w-1.5 rounded-full ${view.alert ? "bg-amber-400" : status.refreshing ? "animate-pulse bg-red-500" : "bg-emerald-500"}`} />
          实时人数
        </span>
        {!compact && <span className="tabular-nums text-gray-400">{view.label}</span>}
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-gray-100">
        <div
          className={`h-full rounded-full transition-[width] duration-200 ease-linear ${view.alert ? "bg-amber-400" : "bg-red-500"}`}
          style={{ width: `${view.progress}%` }}
        />
      </div>
    </div>
  );
}
