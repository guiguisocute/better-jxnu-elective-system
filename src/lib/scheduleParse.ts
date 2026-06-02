import type { FormalSection } from "../types";

// 课表筛选用：把正选/补退选的 schedule 字符串解析为「周几 + 合并块时段」。
// 学校合并块：1-2 / 3 / 4 / 5 / 6-7 / 8-9 / 晚上（中午为分隔，不是可点格子）。
// 真实数据节次 token 杂：第89节 / 第67节 / 第12节 / 第3节 / 第十节(中文十) 等。

export const DAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];
// 网格行（自上而下）；中午分隔条单独渲染，不在此列。
export const SLOT_KEYS = ["1-2", "3", "4", "5", "6-7", "8-9", "晚上"];

const DAY_INDEX: Record<string, number> = {
  一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6,
};

const CN_PERIOD: Record<string, string> = {
  一: "1", 二: "2", 三: "3", 四: "4", 五: "5", 六: "6",
  七: "7", 八: "8", 九: "9", 十: "10", 十一: "11", 十二: "12",
};

// 节次 token → 逗号分隔的数字串。沿用 CourseTable 既有口径：
// "89"→"8,9"、"12"→"1,2"、"十"→"10"、"10"→"10"。
export function normalizePeriods(raw: string): string {
  if (CN_PERIOD[raw]) return CN_PERIOD[raw];
  if (!/^\d+$/.test(raw)) return raw;
  if (raw === "10" || raw === "11") return raw;
  if (raw.includes("0") || raw.includes("11")) {
    return raw.match(/1[0-2]|[1-9]/g)?.join(",") || raw;
  }
  return raw.split("").join(",");
}

function toPeriodNumbers(token: string): number[] {
  return normalizePeriods(token)
    .split(",")
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
}

// 单节次 → 合并块 slotKey。10 及以上归「晚上」。
function periodToSlot(p: number): string {
  if (p <= 2) return "1-2";
  if (p === 3) return "3";
  if (p === 4) return "4";
  if (p === 5) return "5";
  if (p <= 7) return "6-7";
  if (p <= 9) return "8-9";
  return "晚上";
}

export interface MeetSlot {
  day: number; // 0=周一 … 6=周日
  slot: string; // SLOT_KEYS 之一
}

const SEG_RE = /星期(.)-第([\d一二三四五六七八九十]+)节/;
const scheduleCache = new Map<string, MeetSlot[]>();

/** 解析 schedule（多时段以 " / " 分隔）→ 去重后的 {day, slot}[]。无法识别的段跳过。 */
export function parseSchedule(raw: string): MeetSlot[] {
  if (!raw) return [];
  const cached = scheduleCache.get(raw);
  if (cached) return cached;
  const out: MeetSlot[] = [];
  const seen = new Set<string>();
  for (const seg of raw.split(" / ")) {
    const m = seg.match(SEG_RE);
    if (!m) continue;
    const day = DAY_INDEX[m[1]];
    if (day === undefined) continue;
    for (const p of toPeriodNumbers(m[2])) {
      const slot = periodToSlot(p);
      const key = `${day},${slot}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ day, slot });
      }
    }
  }
  scheduleCache.set(raw, out);
  return out;
}

export type CellState = "include" | "exclude";
export type ScheduleFilterMap = Record<string, CellState>; // key = "day,slot"

/**
 * 课表筛选判定（与 chip 三态同语法）：
 * - exclude 优先：任一上课时段命中 exclude 格 → 整门排除
 * - include 取「或」：只要有一节落在 include 格内即保留
 * - 无 include 时不限制
 */
export function sectionMatchesSchedule(section: FormalSection, filter: ScheduleFilterMap): boolean {
  const entries = Object.entries(filter);
  if (entries.length === 0) return true;
  const slotKeys = parseSchedule(section.schedule).map((m) => `${m.day},${m.slot}`);
  const includeKeys = entries.filter(([, v]) => v === "include").map(([k]) => k);
  const excludeKeys = entries.filter(([, v]) => v === "exclude").map(([k]) => k);
  if (excludeKeys.some((k) => slotKeys.includes(k))) return false;
  if (includeKeys.length === 0) return true;
  return includeKeys.some((k) => slotKeys.includes(k));
}

/** 周几标签，如 "周三"。 */
export function dayLabel(day: number): string {
  return `周${DAY_LABELS[day] ?? "?"}`;
}

/** 单个时段的展示标签，如 "周三 6-7"。 */
export function slotLabel(m: MeetSlot): string {
  return `${dayLabel(m.day)} ${m.slot}`;
}

/**
 * 「仅看该时间段」(include) 筛选下，schedule 命中后仍占用的、不在所选格子里的时段。
 * 用于红色冲突提醒：这门课会占用你没标为可填的时间。
 * 无 include 格子、或该课没有任一时段落在 include 内时返回 []（不提醒）。
 */
export function unselectedIncludeSlotsFromSchedule(schedule: string, filter: ScheduleFilterMap): MeetSlot[] {
  const includeKeys = Object.entries(filter)
    .filter(([, v]) => v === "include")
    .map(([k]) => k);
  if (includeKeys.length === 0) return [];
  const inc = new Set(includeKeys);
  const slots = parseSchedule(schedule);
  const matched = slots.some((m) => inc.has(`${m.day},${m.slot}`));
  if (!matched) return [];
  return slots.filter((m) => !inc.has(`${m.day},${m.slot}`));
}

/** `unselectedIncludeSlotsFromSchedule` 的 section 包装。 */
export function unselectedIncludeSlots(section: FormalSection, filter: ScheduleFilterMap): MeetSlot[] {
  return unselectedIncludeSlotsFromSchedule(section.schedule, filter);
}
