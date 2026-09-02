// 前端运行时配置 —— module-level 订阅范式（参照 cartStore / ratingsStore）。
// 数据源：public/app_config.json（build_data.py 按 data/build_config.json 产出，后台 GUI 唯一写入点）。
// fetch 失败 / 产物缺失（如 npm run dev 未跑过 build_data）→ 静默回落 DEFAULTS，
// DEFAULTS 与历史编译期常量完全等价，保证默认行为不变。
import { useSyncExternalStore } from "react";
import { BACKEND_CONFIG_API, LIVE_ENROLLMENT_SEMESTER } from "./liveEnrollments";
import { setTestSemesters } from "./term";

export interface AppFeatureFlags {
  /** 学号一键导入（引导模式二级页入口）。运行时值还要与 featureFlags.ts 编译期总闸相与。 */
  studentImport: boolean;
  /** AI帮我选（SimPanel 第 4 个 tab）。同上。 */
  aiPick: boolean;
}

export interface AppConfig {
  /** 新会话默认进入的选课阶段；用户在当前会话主动切换后优先尊重用户选择。 */
  defaultDataSource: "pre" | "formal";
  /** 测试学期集合（正选/补退选视图加「（测试）」后缀），加载成功后注入 term.ts。 */
  testSemesters: string[];
  /** 实时人数只在该学期开启（HomePage 的 enabled 比较）。 */
  liveEnrollmentSemester: string;
  /**
   * 选课系统当前阶段的 Step 前缀（"Step4"）。后端从容量嗅探 URL 派生，
   * 运维在面板切阶段时自动跟随。空串 = 后端不可达/取不到，此时调用方
   * 保留各自的历史默认值，行为与接这个字段之前完全一致。
   */
  selectionStep: string;
  featureFlags: AppFeatureFlags;
}

export const APP_CONFIG_DEFAULTS: AppConfig = {
  defaultDataSource: "formal",
  testSemesters: [],
  liveEnrollmentSemester: LIVE_ENROLLMENT_SEMESTER,
  selectionStep: "",
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
function normalize(raw: unknown, d: AppConfig = APP_CONFIG_DEFAULTS): AppConfig {
  if (!raw || typeof raw !== "object") return d;
  const data = raw as Record<string, unknown>;
  const flags = (
    data.featureFlags && typeof data.featureFlags === "object" ? data.featureFlags : {}
  ) as Record<string, unknown>;
  return {
    defaultDataSource:
      data.defaultDataSource === "pre" || data.defaultDataSource === "formal"
        ? data.defaultDataSource
        : data.defaultDataSource === "addDrop" ? "formal" : d.defaultDataSource,
    testSemesters: Array.isArray(data.testSemesters)
      ? data.testSemesters.filter((s): s is string => typeof s === "string")
      : d.testSemesters,
    // 空串要放行（"" = 后台关闭实时人数轮询；HomePage 的学期比较对 "" 天然 false）
    liveEnrollmentSemester:
      typeof data.liveEnrollmentSemester === "string"
        ? data.liveEnrollmentSemester
        : d.liveEnrollmentSemester,
    // 只认 Step1..Step9；这个值要拼进跳转到学校选课系统的 URL，坏值宁可退回默认。
    selectionStep:
      typeof data.selectionStep === "string" && /^Step[1-9]$/.test(data.selectionStep)
        ? data.selectionStep
        : d.selectionStep,
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
    // 静态产物负责测试学期/功能开关；VPS 运行配置覆盖两个日常字段，保存后无需
    // 等待 Cloudflare Pages 重新构建。任一来源失败都独立回落，不互相拖累。
    // BACKEND_CONFIG_API 为空 = fork 还没填后端地址（见 .env）。直接跳过这一路，
    // 只用静态产物；否则空串会被当成同源相对路径打出一个必然 404 的请求。
    const [staticResult, runtimeResult] = await Promise.allSettled([
      fetch("/app_config.json", { cache: "no-cache" }).then(readJson),
      BACKEND_CONFIG_API
        ? fetch(BACKEND_CONFIG_API, { cache: "no-cache", headers: { Accept: "application/json" } }).then(readJson)
        : Promise.reject(new Error("backend config url not configured")),
    ]);
    const staticRaw = staticResult.status === "fulfilled" ? staticResult.value : null;
    const runtimeRaw = runtimeResult.status === "fulfilled" ? runtimeResult.value : null;
    const staticConfig = normalize(staticRaw);
    snapshot = normalize(runtimeRaw, staticConfig);
    setTestSemesters(snapshot.testSemesters); // 注入 term.ts 的测试学期集合
    notify();
  })();
}

/** 组件侧读取运行时配置；加载完成后自动触发重渲染。 */
export function useAppConfig(): AppConfig {
  return useSyncExternalStore(subscribe, getAppConfig, getAppConfig);
}
