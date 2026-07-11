// 前端运行时配置 —— module-level 订阅范式（参照 cartStore / ratingsStore）。
// 数据源：public/app_config.json（build_data.py 按 data/build_config.json 产出，后台 GUI 唯一写入点）。
// fetch 失败 / 产物缺失（如 npm run dev 未跑过 build_data）→ 静默回落 DEFAULTS，
// DEFAULTS 与历史编译期常量完全等价，保证默认行为不变。
import { useSyncExternalStore } from "react";
import { LIVE_ENROLLMENT_SEMESTER } from "./liveEnrollments";
import { setTestSemesters } from "./term";

export interface AppFeatureFlags {
  /** 学号一键导入（引导模式二级页入口）。运行时值还要与 featureFlags.ts 编译期总闸相与。 */
  studentImport: boolean;
  /** AI帮我选（SimPanel 第 4 个 tab）。同上。 */
  aiPick: boolean;
}

export interface AppConfig {
  /** 测试学期集合（正选/补退选视图加「（测试）」后缀），加载成功后注入 term.ts。 */
  testSemesters: string[];
  /** 实时人数只在该学期开启（HomePage 的 enabled 比较）。 */
  liveEnrollmentSemester: string;
  featureFlags: AppFeatureFlags;
}

export const APP_CONFIG_DEFAULTS: AppConfig = {
  testSemesters: [],
  liveEnrollmentSemester: LIVE_ENROLLMENT_SEMESTER,
  featureFlags: { studentImport: true, aiPick: true },
};

type Listener = () => void;

const listeners = new Set<Listener>();
// useSyncExternalStore 要求 getSnapshot 返回稳定引用：仅在加载成功时整体换新对象。
let snapshot: AppConfig = APP_CONFIG_DEFAULTS;

function subscribe(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify() {
  for (const fn of listeners) fn();
}

export function getAppConfig(): AppConfig {
  return snapshot;
}

// 容错解析：仅当响应 OK 且确实是 JSON 时才用（参照 ratingsStore.readJson）。
// dev 下 /app_config.json 缺失会落到 SPA 回退返回 index.html（text/html）→ 返回 null → 保持 DEFAULTS。
async function readJson(res: Response): Promise<unknown> {
  if (!res.ok) return null;
  if (!(res.headers.get("content-type") || "").includes("application/json")) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** 逐字段校验回落：产物字段缺失/类型不对时用 DEFAULTS 对应项，绝不让坏值进 store。 */
function normalize(raw: unknown): AppConfig {
  const d = APP_CONFIG_DEFAULTS;
  if (!raw || typeof raw !== "object") return d;
  const data = raw as Record<string, unknown>;
  const flags = (
    data.featureFlags && typeof data.featureFlags === "object" ? data.featureFlags : {}
  ) as Record<string, unknown>;
  return {
    testSemesters: Array.isArray(data.testSemesters)
      ? data.testSemesters.filter((s): s is string => typeof s === "string")
      : d.testSemesters,
    // 空串要放行（"" = 后台关闭实时人数轮询；HomePage 的学期比较对 "" 天然 false）
    liveEnrollmentSemester:
      typeof data.liveEnrollmentSemester === "string"
        ? data.liveEnrollmentSemester
        : d.liveEnrollmentSemester,
    featureFlags: {
      studentImport:
        typeof flags.studentImport === "boolean" ? flags.studentImport : d.featureFlags.studentImport,
      aiPick: typeof flags.aiPick === "boolean" ? flags.aiPick : d.featureFlags.aiPick,
    },
  };
}

let loadStarted = false;

/** 应用挂载时调用一次（main.tsx）；重复调用/StrictMode 双执行都只 fetch 一次。 */
export function loadAppConfig(): void {
  if (loadStarted) return;
  loadStarted = true;
  void (async () => {
    try {
      const res = await fetch("/app_config.json", { cache: "no-cache" });
      const raw = await readJson(res);
      if (raw == null) return; // 无产物 / 非 JSON → 静默用 DEFAULTS，零报错
      snapshot = normalize(raw);
      setTestSemesters(snapshot.testSemesters); // 注入 term.ts 的测试学期集合
      notify();
    } catch {
      // 网络异常同样静默回落 DEFAULTS
    }
  })();
}

/** 组件侧读取运行时配置；加载完成后自动触发重渲染。 */
export function useAppConfig(): AppConfig {
  return useSyncExternalStore(subscribe, getAppConfig, getAppConfig);
}
