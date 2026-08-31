// 课程置顶 store —— module-level 订阅范式（参照 cartStore.ts / ratingsStore.ts）。
//
// 置顶的粒度是「教学班」而不是「课程」：补退选时盯的是某个老师的某个班有没有空位，
// 同课程别的班放出余量对用户没有意义。key 沿用表格里已有的
// `${课程号}|${班级名称}|${教师号}` 形式（见 HomePage 的 selectedSectionKey），
// 这样置顶、选中高亮、课表选班三处说的是同一件事。

type Listener = () => void;

const PIN_KEY = "jxnu.pinned";
const ALERT_KEY = "jxnu.pinned.alert";

export type PinAlertSettings = {
  /** 置顶课出现余量时是否提醒。 */
  enabled: boolean;
  /** 播放提示音。 */
  sound: boolean;
  /** 发浏览器通知（需用户授权）。 */
  notify: boolean;
};

const DEFAULT_ALERT: PinAlertSettings = { enabled: false, sound: true, notify: true };

function loadPinned(): string[] {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {}
  return [];
}

function loadAlert(): PinAlertSettings {
  try {
    const raw = localStorage.getItem(ALERT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return { ...DEFAULT_ALERT, ...parsed };
    }
  } catch {}
  return { ...DEFAULT_ALERT };
}

// 置顶是有序的：用户先置顶的排在更上面，吸顶时也按这个顺序堆叠。
// 用数组而不是 Set 就是为了保住这个顺序。
const pinned: string[] = loadPinned();
let alertSettings: PinAlertSettings = loadAlert();

const listeners = new Set<Listener>();
// useSyncExternalStore 要求 getSnapshot 返回稳定引用：只在真正变更时换新对象。
let pinSnapshot: string[] = [...pinned];
let alertSnapshot: PinAlertSettings = { ...alertSettings };

function persist() {
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify(pinned));
    localStorage.setItem(ALERT_KEY, JSON.stringify(alertSettings));
  } catch {}
}

function notify() {
  pinSnapshot = [...pinned];
  alertSnapshot = { ...alertSettings };
  for (const fn of listeners) fn();
}

export function subscribePins(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getPinnedSnapshot(): string[] {
  return pinSnapshot;
}

export function getAlertSnapshot(): PinAlertSettings {
  return alertSnapshot;
}

export function isPinned(key: string): boolean {
  return pinned.includes(key);
}

export function togglePin(key: string) {
  const at = pinned.indexOf(key);
  if (at >= 0) pinned.splice(at, 1);
  else pinned.push(key);
  persist();
  notify();
}

export function unpin(key: string) {
  const at = pinned.indexOf(key);
  if (at < 0) return;
  pinned.splice(at, 1);
  persist();
  notify();
}

export function clearPins() {
  if (pinned.length === 0) return;
  pinned.length = 0;
  persist();
  notify();
}

export function updateAlertSettings(patch: Partial<PinAlertSettings>) {
  alertSettings = { ...alertSettings, ...patch };
  persist();
  notify();
}
