import { useState } from "react";
import { primeAlertSound, requestNotifyPermission, notifyPermission, playAvailableChime } from "../lib/pinAlert";
import type { PinAlertSettings } from "../lib/pinStore";

interface Props {
  count: number;
  alert: PinAlertSettings;
  onUpdate: (patch: Partial<PinAlertSettings>) => void;
  onClear: () => void;
}

/**
 * 置顶课的「有余量就提醒」开关。
 *
 * 开启动作必须发生在用户手势里：浏览器的自动播放策略要求 AudioContext 由手势
 * 创建/恢复，Notification.requestPermission 同样只在手势中可靠（Safari 尤其）。
 * 所以解锁音频和申请权限都放在这次 onClick 里，不能等到真要提醒时才做。
 */
export function PinAlertToggle({ count, alert, onUpdate, onClear }: Props) {
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState(notifyPermission());

  if (count === 0) return null;

  const enable = async () => {
    // 顺序很重要：先解锁音频、先把开关置上，再去要通知权限。
    // 反过来写的话，用户忽略或关掉权限弹窗时那个 Promise 不会 resolve，
    // onUpdate 永远执行不到，开关看起来"点了没反应"，连提示音都用不上。
    // 通知只是锦上添花，不该卡住主流程。
    primeAlertSound();
    onUpdate({ enabled: true });
    if (alert.notify) setPermission(await requestNotifyPermission());
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="置顶课程与提醒设置"
        className={`inline-flex items-center gap-1 h-7 px-2 rounded-lg text-[11px] font-medium transition-colors ${
          alert.enabled
            ? "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
            : "bg-gray-50 text-gray-500 hover:text-gray-700 ring-1 ring-gray-200"
        }`}
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z" />
        </svg>
        置顶 {count}
        {alert.enabled && <span className="ml-0.5 w-1.5 h-1.5 rounded-full bg-amber-500" />}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-9 z-50 w-64 rounded-xl border border-gray-100 bg-white p-3 shadow-lg dark:bg-[#161B22] dark:border-[#30363D]">
            <p className="text-[11px] text-gray-500 mb-2">
              置顶的教学班会固定在表格顶部。开启提醒后，一旦它<b>出现余量</b>就立刻通知你。
            </p>

            <label className="flex items-center justify-between py-1.5 text-xs cursor-pointer">
              <span>出现余量时提醒</span>
              <input
                type="checkbox"
                checked={alert.enabled}
                onChange={(e) => { if (e.target.checked) void enable(); else onUpdate({ enabled: false }); }}
              />
            </label>

            <label className="flex items-center justify-between py-1.5 text-xs cursor-pointer text-gray-600">
              <span>提示音</span>
              <input
                type="checkbox"
                checked={alert.sound}
                onChange={(e) => { if (e.target.checked) primeAlertSound(); onUpdate({ sound: e.target.checked }); }}
              />
            </label>

            <label className="flex items-center justify-between py-1.5 text-xs cursor-pointer text-gray-600">
              <span>浏览器通知</span>
              <input
                type="checkbox"
                checked={alert.notify}
                onChange={async (e) => {
                  if (e.target.checked) setPermission(await requestNotifyPermission());
                  onUpdate({ notify: e.target.checked });
                }}
              />
            </label>

            {alert.notify && permission === "denied" && (
              <p className="mt-1 text-[11px] text-rose-500">
                通知权限被浏览器拒绝了，需要在地址栏的站点设置里手动放开；提示音不受影响。
              </p>
            )}
            {alert.notify && permission === "unsupported" && (
              <p className="mt-1 text-[11px] text-gray-400">此浏览器不支持通知，将只用提示音。</p>
            )}
            <p className="mt-1 text-[11px] text-gray-400">
              页面开着（含切到后台标签页）才会提醒；关掉页面收不到。
            </p>

            <div className="mt-2 flex items-center justify-between border-t border-gray-100 pt-2 dark:border-[#30363D]">
              <button type="button" onClick={() => playAvailableChime()} className="text-[11px] text-gray-400 hover:text-gray-600">
                试听
              </button>
              <button type="button" onClick={() => { onClear(); setOpen(false); }} className="text-[11px] text-gray-400 hover:text-rose-500">
                清空置顶
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
