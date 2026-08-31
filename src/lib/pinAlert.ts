// 置顶课「出现余量」的提醒手段：提示音 + 浏览器通知。
//
// 只在页面开着时有效（含切到后台的标签页）。做 Web Push（关掉页面也能收）需要
// Service Worker + VAPID + 服务端订阅存储，而且国内 Chrome 的推送通道本身就不稳，
// 收益不匹配——补退选时用户本来就会开着页面盯。

let audioContext: AudioContext | null = null;

/**
 * 解锁音频。浏览器的自动播放策略要求 AudioContext 由用户手势创建/恢复，
 * 所以必须在「打开提醒」那次点击里调用，不能等到真正要响的时候才建。
 */
export function primeAlertSound(): void {
  try {
    if (!audioContext) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      audioContext = new Ctor();
    }
    if (audioContext.state === "suspended") void audioContext.resume();
  } catch {}
}

/**
 * 两声上行提示音。用 Web Audio 合成而不是放音频文件：不增加构建产物、
 * 不受静态资源缓存影响，离线也能响。
 */
export function playAvailableChime(): void {
  try {
    primeAlertSound();
    const ctx = audioContext;
    if (!ctx || ctx.state !== "running") return;
    const now = ctx.currentTime;
    for (const [index, freq] of [880, 1320].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = now + index * 0.16;
      // 短促的淡入淡出，避免爆音
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.16);
    }
  } catch {}
}

export type NotifyPermission = "granted" | "denied" | "default" | "unsupported";

export function notifyPermission(): NotifyPermission {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission as NotifyPermission;
}

/** 必须由用户手势触发；Safari 只接受手势里的同步调用。 */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission as NotifyPermission;
  try {
    return (await Notification.requestPermission()) as NotifyPermission;
  } catch {
    return "denied";
  }
}

export function showAvailableNotification(title: string, body: string, tag: string): void {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    // tag 用教学班 key：同一个班反复放量时替换旧通知，而不是堆一屏。
    new Notification(title, { body, tag, renotify: true } as NotificationOptions);
  } catch {}
}
