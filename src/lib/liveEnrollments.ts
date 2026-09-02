import type { FormalSection } from "../types";

/**
 * VPS Go 后端的实时人数接口。**不设兜底地址**：以前这里硬编码着本仓库作者的 VPS，
 * fork 出去的站点会在无人察觉的情况下一直请求上游后端。地址只在仓库根目录 `.env`
 * 里出现一次（Cloudflare Pages 控制台的同名变量优先级更高）。
 * 未配置时为空串，`useLiveEnrollments` 会跳过轮询——实时人数关闭，其余功能不受影响。
 */
export const LIVE_ENROLLMENT_API = (import.meta.env.VITE_KKAP_API_URL || "").replace(/\/$/, "");

/**
 * VPS Go 后端公开的无敏感运行配置。默认由实时人数 URL 同源推导；如部署路径特殊，
 * 可用 VITE_BACKEND_CONFIG_URL 单独覆盖。后端不可达时 appConfig 会回落静态产物。
 */
export const BACKEND_CONFIG_API = (
  import.meta.env.VITE_BACKEND_CONFIG_URL
  || LIVE_ENROLLMENT_API.replace(/\/api\/enrollments$/, "/api/config")
).replace(/\/$/, "");

export const LIVE_ENROLLMENT_SEMESTER = import.meta.env.VITE_KKAP_SEMESTER || "2026-09";

export type LiveEnrollmentItem = [courseName: string, className: string, teacher: string, enrolled: number];

export interface LiveEnrollmentSnapshot {
  version: number;
  semester: string;
  fetchedAt: string;
  nextRefreshAt: string;
  refreshIntervalMs: number;
  classCount: number;
  conflictCount: number;
  items: LiveEnrollmentItem[];
}

export interface LiveEnrollmentStatus {
  enabled: boolean;
  refreshing: boolean;
  stale: boolean;
  error: string | null;
  /** 后端快照构建时间（数据真值时刻）。注意：采集机时钟可能超前，别拿它做本地时间运算。 */
  fetchedAt: string | null;
  /** **客户端**下一次轮询时刻，倒计时/进度条锚点。不是后端的抓取时刻。 */
  nextRefreshAt: string | null;
  /** 客户端轮询周期，与 nextRefreshAt 同一把尺子。 */
  refreshIntervalMs: number;
  /** 后端抓取周期，仅用于提示文案；不参与排程与进度计算。 */
  serverIntervalMs: number;
  /** 最近一次拿到「新快照」时变化的班级条数（与上一份比）。 */
  lastUpdateCount: number;
  /** 最近一次更新的本地时刻（毫秒）；null = 尚未发生过更新。 */
  lastUpdateAt: number | null;
}

/**
 * 排序与「仅看有余量」共用的**可信余量**定义。返回 null = 无法判定。
 *
 * 两种情况都算无法判定：
 *  1. 已选或容量未知（实时快照没匹配上、或该学期没有容量数据）；
 *  2. 算出来是负数 —— 容量来自 xk 逐课抓取、已选来自教务 KKAP，两个账本口径不同：
 *     合班课 KKAP 记合并后人数（89/30），采集账号看不到容量的公共必修课报 0（74/0）。
 *     现实中余量不可能为负，出现即说明容量不可信（2026-09 实测约 233 条）。
 *
 * 排序把 null 排到最后，筛选把 null 判为"不确定有余量"而隐藏 —— 两处必须同一口径，
 * 否则会出现"排序认为它没余量、筛选却把它留下"这种自相矛盾。
 */
export function trustedRemaining(capacity: number | null, enrolled: number | null): number | null {
  if (enrolled == null || capacity == null) return null;
  const remaining = capacity - enrolled;
  return remaining < 0 ? null : remaining;
}

/** 一份快照的「课程班级 → 已选人数」映射，用于和下一份做差。 */
export function enrollmentCountMap(items: LiveEnrollmentItem[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) map.set(fullKey(item[0], item[1], item[2]), item[3]);
  return map;
}

/** 新旧两份映射间「人数有变化或新增」的条目键集合。 */
export function enrollmentChangedKeys(prev: Map<string, number>, next: Map<string, number>): Set<string> {
  const keys = new Set<string>();
  for (const [key, value] of next) if (prev.get(key) !== value) keys.add(key);
  return keys;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  middot: "·",
  nbsp: " ",
  quot: '"',
};

export function normalizeEnrollmentText(value: string): string {
  return (value || "")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (raw, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? raw)
    .replace(/\s+/g, " ")
    .trim();
}

function fullKey(courseName: string, className: string, teacher: string): string {
  return [courseName, className, teacher].map(normalizeEnrollmentText).join("|");
}

function classKey(courseName: string, className: string): string {
  return [courseName, className].map(normalizeEnrollmentText).join("|");
}

function increment(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** 一个 section 命中实时人数的结果：value=已选人数，key=命中的实时条目键（用于判断它是否刚变化）。 */
export interface EnrollmentMatch {
  value: number | null;
  key: string | null;
}

export function buildEnrollmentResolver(
  items: LiveEnrollmentItem[],
  sections: FormalSection[],
): (section: FormalSection) => EnrollmentMatch {
  const liveFull = new Map<string, LiveEnrollmentItem[]>();
  const liveClass = new Map<string, LiveEnrollmentItem[]>();
  for (const item of items) {
    const full = fullKey(item[0], item[1], item[2]);
    const fallback = classKey(item[0], item[1]);
    liveFull.set(full, [...(liveFull.get(full) ?? []), item]);
    liveClass.set(fallback, [...(liveClass.get(fallback) ?? []), item]);
  }

  const staticFullCount = new Map<string, number>();
  const staticClassCount = new Map<string, number>();
  for (const section of sections) {
    increment(staticFullCount, fullKey(section.name, section.className, section.teacher));
    increment(staticClassCount, classKey(section.name, section.className));
  }

  return (section: FormalSection) => {
    const full = fullKey(section.name, section.className, section.teacher);
    const exact = liveFull.get(full);
    if (exact?.length === 1 && staticFullCount.get(full) === 1) return { value: exact[0][3], key: full };

    // Public_Kkap and the formal schedule occasionally disagree only on the
    // teacher (late staffing changes).  Use course+class only when it is unique
    // on both sides; ambiguous rows deliberately stay unmatched.
    const fallback = classKey(section.name, section.className);
    const byClass = liveClass.get(fallback);
    if (byClass?.length === 1 && staticClassCount.get(fallback) === 1) {
      const it = byClass[0];
      return { value: it[3], key: fullKey(it[0], it[1], it[2]) };
    }
    return { value: null, key: null };
  };
}

export function parseLiveEnrollmentSnapshot(value: unknown): LiveEnrollmentSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (
    typeof data.version !== "number"
    || typeof data.semester !== "string"
    || typeof data.fetchedAt !== "string"
    || typeof data.nextRefreshAt !== "string"
    || typeof data.refreshIntervalMs !== "number"
    || !Array.isArray(data.items)
  ) return null;

  const items: LiveEnrollmentItem[] = [];
  for (const raw of data.items) {
    if (
      !Array.isArray(raw)
      || raw.length !== 4
      || typeof raw[0] !== "string"
      || typeof raw[1] !== "string"
      || typeof raw[2] !== "string"
      || typeof raw[3] !== "number"
      || !Number.isInteger(raw[3])
      || raw[3] < 0
    ) return null;
    items.push([raw[0], raw[1], raw[2], raw[3]]);
  }

  return {
    version: data.version,
    semester: data.semester,
    fetchedAt: data.fetchedAt,
    nextRefreshAt: data.nextRefreshAt,
    // 如实保留后端上报的抓取间隔。以前钳到 ≥10s 是因为它曾用于驱动客户端排程；
    // 现在排程完全由客户端固定定时器负责，这个值只剩两个用途：tooltip 文案，
    // 以及 staleThresholdMs 里的 max(它, 客户端间隔)——两处都不怕小值。
    // 继续钳的话，后端设 5 秒时 tooltip 会显示"后端每 10 秒"，是条假信息。
    refreshIntervalMs: Math.max(0, data.refreshIntervalMs),
    classCount: typeof data.classCount === "number" ? data.classCount : items.length,
    conflictCount: typeof data.conflictCount === "number" ? data.conflictCount : 0,
    items,
  };
}
