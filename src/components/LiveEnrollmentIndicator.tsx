import { startTransition, useEffect, useMemo, useState } from "react";
import type { LiveEnrollmentStatus } from "../lib/liveEnrollments";

function refreshIntervalLabel(intervalMs: number) {
  const seconds = Math.max(1, Math.round(intervalMs / 1000));
  return seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
}

export function LiveEnrollmentIndicator({ status, compact = false }: { status: LiveEnrollmentStatus; compact?: boolean }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!status.enabled) return;
    // 心跳只驱动倒计时文案/进度条，1s 一跳足够；且必须走 transition ——
    // 紧急 setState 会打断并重启整棵树的 transition 渲染（useDeferredValue 的搜索过滤），
    // 高频紧急心跳曾把 deferred 渲染饿死（长时间停留后筛选/搜索失效）。
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") startTransition(() => setNow(Date.now()));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [status.enabled]);

  // tone: "idle"(倒计时) | "updating"(后端刷新中) | "updated"(刚拿到新数据) | "alert"。
  const view = useMemo(() => {
    const target = status.nextRefreshAt ? Date.parse(status.nextRefreshAt) : now + status.refreshIntervalMs;
    const start = target - status.refreshIntervalMs; // 进度条锚在「客户端上次轮询→下次轮询」整段上
    const progress = Math.max(0, Math.min(100, ((now - start) / status.refreshIntervalMs) * 100));
    const seconds = Math.max(0, Math.ceil((target - now) / 1000));
    const justUpdated = status.lastUpdateAt != null && now - status.lastUpdateAt < 3500;

    if (!status.fetchedAt && status.error) return { progress: 100, label: "实时人数暂不可用", tone: "alert" as const };
    if (status.stale) return { progress: 100, label: "人数更新延迟", tone: "alert" as const };
    // 刚拿到新快照：闪一下「更新 N 条 / 数据无变化」，让用户明确感知到刷新发生了。
    if (justUpdated) {
      const n = status.lastUpdateCount;
      return { progress: 100, label: n > 0 ? `已更新 ${n} 条` : "数据无变化", tone: "updated" as const };
    }
    // 后端到点该刷新了、或前端正在取数 → 「正在更新…」。
    if (status.refreshing || now >= target) return { progress: 96, label: "正在更新…", tone: "updating" as const };
    if (!status.fetchedAt) return { progress, label: "正在连接人数服务", tone: "updating" as const };
    return { progress, label: `${seconds}s 后刷新`, tone: "idle" as const };
  }, [now, status]);

  if (!status.enabled) return null;
  const alert = view.tone === "alert";
  const updated = view.tone === "updated";
  const updating = view.tone === "updating";
  const dotClass = alert ? "bg-amber-400" : updated ? "bg-emerald-500" : updating ? "animate-pulse bg-red-500" : "bg-emerald-500";
  const barClass = alert ? "bg-amber-400" : updated ? "bg-emerald-500" : "bg-red-500";
  const labelClass = updated ? "text-emerald-600 font-semibold" : "text-gray-400";
  return (
    <div
      className={`${compact ? "w-[128px]" : "w-[138px]"} shrink-0`}
      role="status"
      title={status.error
        ? `实时人数服务：${status.error}`
        : `本页每 ${refreshIntervalLabel(status.refreshIntervalMs)}同步一次（后端每 ${refreshIntervalLabel(status.serverIntervalMs)}从教务抓取）`}
    >
      <div className={`mb-1 flex items-center justify-between text-[10px] font-medium ${alert ? "text-amber-600" : "text-gray-500"}`}>
        <span className="inline-flex items-center gap-1">
          <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
          实时人数
        </span>
        {/* 紧凑(移动端)平时只留圆点省版面，但「已更新 N 条」这种绿色更新提示必须露出来让用户感知。 */}
        {(!compact || updated) && <span className={`tabular-nums whitespace-nowrap ${labelClass}`}>{view.label}</span>}
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-gray-100">
        <div
          className={`h-full rounded-full transition-[width] duration-1000 ease-linear ${barClass}`}
          style={{ width: `${view.progress}%` }}
        />
      </div>
    </div>
  );
}
