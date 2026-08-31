import { useSyncExternalStore, useMemo, useCallback, useRef, useEffect } from "react";
import {
  subscribePins,
  getPinnedSnapshot,
  getAlertSnapshot,
  togglePin,
  unpin,
  clearPins,
  updateAlertSettings,
} from "../lib/pinStore";
import { playAvailableChime, showAvailableNotification } from "../lib/pinAlert";
import type { FormalSection } from "../types";

/** 教学班在置顶/选中/选班三处共用的 key。 */
export function sectionPinKey(s: FormalSection): string {
  return `${s.id}|${s.className}|${s.teacherId}`;
}

/** 订阅置顶列表与提醒设置。 */
export function usePinnedCourses() {
  const keys = useSyncExternalStore(subscribePins, getPinnedSnapshot, getPinnedSnapshot);
  const alert = useSyncExternalStore(subscribePins, getAlertSnapshot, getAlertSnapshot);
  const set = useMemo(() => new Set(keys), [keys]);
  return {
    keys,
    count: keys.length,
    alert,
    has: useCallback((key: string) => set.has(key), [set]),
    toggle: togglePin,
    remove: unpin,
    clear: clearPins,
    updateAlert: updateAlertSettings,
  };
}

function remainingOf(section: FormalSection, enrolled: number | null): number | null {
  if (enrolled === null || section.capacity === null || section.capacity < 0) return null;
  return section.capacity - enrolled;
}

/**
 * 盯住置顶的教学班，余量从「无/未知」变成「有」时提醒一次。
 *
 * 只在**跳变**时响，不是只要有余量就一直响——否则每轮刷新都要炸一次。
 * 首次观测到的状态只记录不提醒：刚打开页面时某门课本来就有余量，那不是
 * 「刚放出来」，把它当跳变会让用户一进站就被误报轰炸。
 */
export function usePinAvailabilityAlert(
  sections: FormalSection[],
  getEnrollment: ((s: FormalSection) => number | null) | undefined,
  pinnedKeys: string[],
  enabled: boolean,
  sound: boolean,
  notify: boolean,
) {
  // key -> 上一次观测到的「是否有余量」。undefined = 还没观测过。
  const previous = useRef<Map<string, boolean>>(new Map());

  const pinnedSet = useMemo(() => new Set(pinnedKeys), [pinnedKeys]);

  useEffect(() => {
    if (!enabled) {
      // 关掉提醒时清空历史：再打开时重新从「首次观测」开始，
      // 不会拿关闭期间的旧状态算出一个假跳变。
      previous.current.clear();
      return;
    }
    if (!getEnrollment) return;

    const seen = new Set<string>();
    for (const section of sections) {
      const key = sectionPinKey(section);
      if (!pinnedSet.has(key)) continue;
      seen.add(key);

      const remaining = remainingOf(section, getEnrollment(section));
      if (remaining === null) continue; // 数据不全，不参与跳变判定

      const nowAvailable = remaining > 0;
      const before = previous.current.get(key);
      previous.current.set(key, nowAvailable);

      if (before === undefined) continue; // 首次观测，只记录
      if (before || !nowAvailable) continue; // 没有发生 无→有 的跳变

      const title = `${section.name} 有余量了`;
      const body = `${section.className}${section.teacher ? ` · ${section.teacher}` : ""} — 剩余 ${remaining} 个名额`;
      if (sound) playAvailableChime();
      if (notify) showAvailableNotification(title, body, key);
    }

    // 取消置顶的课不再留状态，避免下次置顶时用陈旧状态误判。
    for (const key of previous.current.keys()) {
      if (!seen.has(key)) previous.current.delete(key);
    }
  }, [sections, getEnrollment, pinnedSet, enabled, sound, notify]);
}
