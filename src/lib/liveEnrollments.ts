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
  /** 后端快照构建时间（数据真值时刻），用于进度条锚点。 */
  fetchedAt: string | null;
  /** 后端下次刷新时刻（权威），倒计时严格对齐它，不随前端轮询重置。 */
  nextRefreshAt: string | null;
  refreshIntervalMs: number;
  /** 最近一次拿到「新快照」时变化的班级条数（与上一份比）。 */
  lastUpdateCount: number;
  /** 最近一次更新的本地时刻（毫秒）；null = 尚未发生过更新。 */
  lastUpdateAt: number | null;
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
    refreshIntervalMs: Math.max(10_000, data.refreshIntervalMs),
    classCount: typeof data.classCount === "number" ? data.classCount : items.length,
    conflictCount: typeof data.conflictCount === "number" ? data.conflictCount : 0,
    items,
  };
}
