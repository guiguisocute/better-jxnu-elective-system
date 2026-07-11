// AI帮我选 —— POST /api/ai/recommend 的前端请求封装。
// 与 ratingsStore.readJson 同一套容错思路：`npm run dev` 无 Pages Functions 后端时
// /api/* 会落到 SPA 回退返回 index.html，这里靠 content-type 判定优雅降级为
// { ok:false, code:"network" }，绝不把 "Unexpected token '<'" 抛给 UI。

import type { AiErrorCode, AiRecommendRequest, AiRecommendResponse } from "./types";

export type AiClientResult =
  | { ok: true; data: AiRecommendResponse }
  | { ok: false; code: AiErrorCode | "network"; message: string };

/** 每个错误码的中文文案（UI 直接展示；服务端 error 文本仅作日志，不给用户看）。 */
const ERROR_TEXT: Record<AiErrorCode | "network", string> = {
  bad_request: "请求内容未通过校验，请刷新页面后重试",
  quota_voter: "今日次数已用完，明天再来",
  quota_site: "今天全站的 AI 额度已用完，明天早点来",
  budget: "本站 AI 预算已触发熔断，请过几天再试",
  upstream: "AI 服务暂时不可用，请稍后重试",
  disabled: "AI 功能暂未开放（服务端未配置密钥）",
  network: "网络异常或本地开发环境无后端，请检查后重试",
};

const ERROR_CODES = new Set<string>(["bad_request", "quota_voter", "quota_site", "budget", "upstream", "disabled"]);

function isAiErrorCode(v: unknown): v is AiErrorCode {
  return typeof v === "string" && ERROR_CODES.has(v);
}

/**
 * 发起一次 AI 推荐请求。任何失败（HTTP 非 2xx / 非 JSON / 网络异常 / abort）都收敛为
 * { ok:false }，不抛异常 —— 调用方取消请求后应自行检查 signal.aborted 并丢弃本结果。
 */
export async function requestAiRecommend(
  req: AiRecommendRequest,
  signal?: AbortSignal,
): Promise<AiClientResult> {
  let res: Response;
  try {
    res = await fetch("/api/ai/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal,
    });
  } catch {
    // fetch 抛出 = 网络层失败或 abort；abort 场景由调用方用 signal.aborted 识别后忽略。
    return { ok: false, code: "network", message: ERROR_TEXT.network };
  }

  // dev 环境无 Functions 后端：/api/* 返回 index.html（200 + text/html）→ 按无后端降级。
  if (!(res.headers.get("content-type") || "").includes("application/json")) {
    return { ok: false, code: "network", message: "本地开发环境无后端，AI 推荐仅线上可用" };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, code: "upstream", message: ERROR_TEXT.upstream };
  }

  if (!res.ok) {
    const code = isAiErrorCode((body as { code?: unknown } | null)?.code)
      ? ((body as { code: AiErrorCode }).code)
      : "upstream";
    return { ok: false, code, message: ERROR_TEXT[code] };
  }

  // 成功响应的形状兜底：picks 数组 + strategy 字符串缺一不可（防上游半截 JSON 透传）。
  const data = body as AiRecommendResponse;
  if (!data || !Array.isArray(data.picks) || typeof data.strategy !== "string") {
    return { ok: false, code: "upstream", message: ERROR_TEXT.upstream };
  }
  return { ok: true, data };
}
