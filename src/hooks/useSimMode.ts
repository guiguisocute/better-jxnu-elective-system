import { useState, useCallback, useEffect } from "react";

// 模拟选课模式状态机：browse → onboarding → sim。
//   browse      ：与现状一致，仅多一个顶部开关
//   onboarding  ：首次进入的 3 步引导（确认方案 / 手填已修 / 确认核算）
//   sim         ：底部 dock + 课程行加车按钮 + 详情加车 CTA
export type SimMode = "browse" | "onboarding" | "sim";

const ONBOARDED_KEY = "jxnu.onboarding.done";
// 开关状态随刷新保留：与 jxnu_data_source / jxnu_filters 同机制走 sessionStorage
// （刷新保留、关标签页/重开浏览器复位）。只持久化 browse/sim，不持久化 onboarding 中间态。
const MODE_KEY = "jxnu.sim.mode";

function hasOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === "1";
  } catch {
    return false;
  }
}

function initialMode(): SimMode {
  if (typeof window !== "undefined") {
    try {
      // 支持 ?sim=1 直接进入模拟态（便于分享链接）。
      if (new URLSearchParams(window.location.search).get("sim") === "1") return "sim";
      // 刷新恢复上次开关状态（仅 sim 才恢复，onboarding 中间态不恢复）。
      if (sessionStorage.getItem(MODE_KEY) === "sim") return "sim";
    } catch {}
  }
  return "browse";
}

export function useSimMode() {
  const [mode, setMode] = useState<SimMode>(initialMode);

  // 持久化开关状态（onboarding 中间态不落盘，避免刷新卡在引导）。
  useEffect(() => {
    if (mode === "onboarding") return;
    try { sessionStorage.setItem(MODE_KEY, mode); } catch {}
  }, [mode]);

  // 点开关进入：引导过则直达 sim，否则先走引导。
  const open = useCallback(() => {
    setMode(hasOnboarded() ? "sim" : "onboarding");
  }, []);

  const close = useCallback(() => setMode("browse"), []);

  const finishOnboarding = useCallback(() => {
    try {
      localStorage.setItem(ONBOARDED_KEY, "1");
    } catch {}
    setMode("sim");
  }, []);

  const cancelOnboarding = useCallback(() => setMode("browse"), []);

  // 在 sim 态下重新打开引导（如 dock 里「编辑已修」）。不影响"已引导"标记。
  const openOnboarding = useCallback(() => setMode("onboarding"), []);

  // 直接进入 sim 态（不走 hasOnboarded gate）。是否先弹引导由调用方按「是否选了培养方案」决定。
  const goSim = useCallback(() => setMode("sim"), []);

  // 顶部开关：browse → 进入；sim → 关闭。onboarding 态点开关不动作（由弹窗按钮处理）。
  const toggle = useCallback(() => {
    setMode((m) => {
      if (m === "browse") return hasOnboarded() ? "sim" : "onboarding";
      if (m === "sim") return "browse";
      return m;
    });
  }, []);

  return { mode, toggle, open, goSim, close, finishOnboarding, cancelOnboarding, openOnboarding };
}
